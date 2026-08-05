/**
 * A loop session, rendered as the conversation the UI knows how to draw.
 *
 * Two sources are merged. `session.history` is the transcript loop has
 * persisted — authoritative, but only written when a turn ends. The in-flight
 * turn comes from `liveTurn.ts`, fed by loop's `session.event` stream. A thread
 * is therefore "everything on disk, plus the turn currently being written".
 *
 * The mapping that makes this work without any new loop protocol:
 *
 *   loop text-delta / text parts   -> OrchestrationMessage(role: assistant)
 *   loop reasoning                 -> activity kind "task.progress", which is
 *                                     what the work log renders as thinking
 *   loop tool calls                -> activity tone "tool"
 *   loop's `plan` tool call        -> OrchestrationProposedPlan, since its
 *                                     `input.plan` IS the markdown document
 *                                     the plan card renders
 */
import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  OrchestrationThread as OrchestrationThreadSchema,
  type OrchestrationThreadStreamItem,
} from "@loop/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { loopSessionIdFor } from "./dispatch.ts";
import { toInstanceId } from "./ids.ts";
import { clearLiveTurn, onLiveTurnChange, readLiveTurn, type LiveToolCall } from "./liveTurn.ts";
import { loopCall } from "../transport.ts";

/** `kind` the work log turns into a thinking-toned row. */
const THINKING_ACTIVITY_KIND = "task.progress";

/** loop's tool for proposing a plan; its input carries the whole document. */
const PLAN_TOOL = "plan";

interface LoopEntry {
  readonly type: string;
  readonly ts: number;
  readonly id?: string;
  readonly role?: "user" | "assistant" | "tool";
  readonly content?: unknown;
  readonly interrupted?: boolean;
  readonly name?: string;
}

interface LoopHistory {
  readonly sessionId: string;
  readonly info: { readonly cwd: string; readonly provider: string; readonly model: string; readonly createdAt: number };
  readonly name?: string;
  readonly entries: readonly LoopEntry[];
  readonly seq: number;
  readonly running: boolean;
}

interface ContentPart {
  readonly type: string;
  readonly text?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly input?: unknown;
  readonly args?: unknown;
  readonly output?: unknown;
  readonly result?: unknown;
}

const decodeThread = Schema.decodeUnknownEffect(OrchestrationThreadSchema);

const iso = (epochMs: number) => new Date(epochMs).toISOString();

function partsOf(content: unknown): readonly ContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content as readonly ContentPart[];
  return [];
}

function textOf(content: unknown): string {
  return partsOf(content)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

/** A one-line summary for a tool row; the full input goes in the payload. */
function toolSummary(name: string, input: unknown): string {
  const record = input as Record<string, unknown> | undefined;
  const candidate =
    record?.["command"] ?? record?.["file_path"] ?? record?.["path"] ?? record?.["pattern"];
  if (typeof candidate === "string" && candidate.trim() !== "") {
    const flat = candidate.replace(/\s+/g, " ").trim();
    return `${name} ${flat.length > 90 ? `${flat.slice(0, 89)}…` : flat}`;
  }
  return name || "tool";
}

function detailOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

interface Accumulator {
  readonly messages: unknown[];
  readonly activities: unknown[];
  readonly plans: unknown[];
}

function pushToolActivity(
  out: Accumulator,
  options: {
    readonly id: string;
    readonly turnId: string | null;
    readonly createdAt: string;
    readonly name: string;
    readonly input: unknown;
    readonly output?: unknown;
    readonly error?: unknown;
    readonly toolCallId?: string;
  },
): void {
  const detail = detailOf(options.error ?? options.output ?? options.input);
  out.activities.push({
    id: options.id,
    tone: options.error === undefined ? "tool" : "error",
    kind: `tool.${options.name || "unknown"}`,
    summary: toolSummary(options.name, options.input),
    payload: {
      ...(detail === undefined ? {} : { detail }),
      ...(options.toolCallId === undefined ? {} : { toolCallId: options.toolCallId }),
    },
    turnId: options.turnId,
    createdAt: options.createdAt,
  });
}

/** Walk loop's persisted transcript into messages, activities and plans. */
function foldHistory(history: LoopHistory): Accumulator {
  const out: Accumulator = { messages: [], activities: [], plans: [] };
  // Tool results arrive as their own `role: "tool"` entries, after the
  // assistant message that called them, so calls are indexed while walking and
  // their results merged in when they show up.
  const pendingTools = new Map<string, { index: number; name: string; input: unknown }>();

  for (const [position, entry] of history.entries.entries()) {
    if (entry.type !== "message") continue;
    const entryId = entry.id ?? `entry-${position}`;
    const createdAt = iso(entry.ts);

    if (entry.role === "user") {
      const text = textOf(entry.content);
      if (text.trim() === "") continue;
      out.messages.push({
        id: entryId,
        role: "user",
        text,
        turnId: null,
        streaming: false,
        createdAt,
        updatedAt: createdAt,
      });
      continue;
    }

    if (entry.role === "tool") {
      for (const part of partsOf(entry.content)) {
        const id = part.toolCallId;
        if (!id) continue;
        const pending = pendingTools.get(id);
        if (!pending) continue;
        const output = part.output ?? part.result;
        const detail = detailOf(output ?? pending.input);
        const activity = out.activities[pending.index] as { payload: Record<string, unknown> };
        activity.payload = { ...activity.payload, ...(detail === undefined ? {} : { detail }) };
      }
      continue;
    }

    if (entry.role !== "assistant") continue;

    // One turn per assistant message: loop does not record turn ids, and the
    // message is the only boundary the transcript actually has.
    const turnId = entryId;
    const text = textOf(entry.content);
    if (text.trim() !== "") {
      out.messages.push({
        id: `${entryId}-assistant`,
        role: "assistant",
        text,
        turnId,
        streaming: false,
        createdAt,
        updatedAt: createdAt,
      });
    }

    let ordinal = 0;
    for (const part of partsOf(entry.content)) {
      ordinal += 1;
      if (part.type === "reasoning" && typeof part.text === "string" && part.text.trim() !== "") {
        out.activities.push({
          id: `${entryId}-reasoning-${ordinal}`,
          tone: "info",
          kind: THINKING_ACTIVITY_KIND,
          summary: "Thinking",
          payload: { detail: part.text },
          turnId,
          createdAt,
        });
        continue;
      }
      if (part.type !== "tool-call") continue;

      const name = part.toolName ?? "unknown";
      const input = part.input ?? part.args;
      if (name === PLAN_TOOL) {
        // loop delivers a plan AS a tool call whose input is the document, so
        // it maps onto the plan card with no new protocol.
        const markdown = (input as { plan?: unknown } | undefined)?.plan;
        if (typeof markdown === "string" && markdown.trim() !== "") {
          out.plans.push({
            id: part.toolCallId ?? `${entryId}-plan-${ordinal}`,
            turnId,
            planMarkdown: markdown,
            createdAt,
            updatedAt: createdAt,
          });
          continue;
        }
      }
      const index = out.activities.length;
      pushToolActivity(out, {
        id: `${entryId}-tool-${ordinal}`,
        turnId,
        createdAt,
        name,
        input,
        ...(part.toolCallId === undefined ? {} : { toolCallId: part.toolCallId }),
      });
      if (part.toolCallId) pendingTools.set(part.toolCallId, { index, name, input });
    }
  }

  return out;
}

/**
 * Overlay the turn currently being streamed, if there is one.
 *
 * The overlay has to retire exactly once, and neither obvious rule is safe.
 * Dropping it the moment loop reports `finish` can blank the reply, because
 * the transcript is not guaranteed to be written by the time the rebuild runs
 * — and with no further events there would be no rebuild to restore it. Never
 * dropping it shows the reply twice, once live and once persisted.
 *
 * So retirement is driven by evidence rather than by timing: the overlay goes
 * away when the transcript itself already ends with the text it was holding.
 */
function foldLiveTurn(out: Accumulator, sessionId: string): { running: boolean; turnId: string | null } {
  const live = readLiveTurn(sessionId);
  if (!live) return { running: false, turnId: null };

  if (!live.running && live.text.trim() !== "") {
    const lastAssistant = [...out.messages]
      .reverse()
      .find((message) => (message as { role: string }).role === "assistant") as
      | { text: string }
      | undefined;
    if (lastAssistant?.text.trim() === live.text.trim()) {
      clearLiveTurn(sessionId);
      return { running: false, turnId: null };
    }
  }

  const turnId = `live-${live.startedAt}`;
  const createdAt = live.startedAt;

  if (live.reasoning.trim() !== "") {
    out.activities.push({
      id: `${turnId}-reasoning`,
      tone: "info",
      kind: THINKING_ACTIVITY_KIND,
      summary: "Thinking",
      payload: { detail: live.reasoning },
      turnId,
      createdAt,
    });
  }

  let ordinal = 0;
  for (const tool of live.tools as readonly LiveToolCall[]) {
    ordinal += 1;
    pushToolActivity(out, {
      id: `${turnId}-tool-${ordinal}`,
      turnId,
      createdAt,
      name: tool.name,
      input: tool.input,
      ...(tool.output === undefined ? {} : { output: tool.output }),
      ...(tool.error === undefined ? {} : { error: tool.error }),
      toolCallId: tool.id,
    });
  }

  if (live.text.trim() !== "") {
    out.messages.push({
      id: `${turnId}-assistant`,
      role: "assistant",
      text: live.text,
      turnId,
      streaming: live.running,
      createdAt,
      updatedAt: new Date().toISOString(),
    });
  }

  if (live.error !== undefined) {
    out.activities.push({
      id: `${turnId}-error`,
      tone: "error",
      kind: "turn.error",
      summary: "The turn failed",
      payload: { detail: live.error },
      turnId,
      createdAt,
    });
  }

  return { running: live.running, turnId };
}

export const buildThread = Effect.fnUntraced(function* (loopSessionId: string) {
  const history = yield* Effect.promise(() =>
    loopCall<LoopHistory>("session.history", { sessionId: loopSessionId }),
  );

  const out = foldHistory(history);
  const live = foldLiveTurn(out, loopSessionId);
  const running = history.running || live.running;

  const firstUser = out.messages.find(
    (message) => (message as { role: string }).role === "user",
  ) as { text: string } | undefined;
  const title = history.name?.trim() || firstUser?.text.replace(/\s+/g, " ").slice(0, 80) || "Untitled";
  const updatedAt = iso(
    history.entries.length > 0 ? history.entries[history.entries.length - 1]!.ts : history.info.createdAt,
  );

  return yield* decodeThread({
    id: loopSessionId,
    projectId: history.info.cwd,
    title,
    modelSelection: {
      instanceId: toInstanceId(history.info.provider),
      model: history.info.model || "unknown",
    },
    runtimeMode: "full-access",
    branch: null,
    worktreePath: null,
    latestTurn:
      live.turnId === null
        ? null
        : {
            turnId: live.turnId,
            state: running ? "running" : "completed",
            requestedAt: updatedAt,
            startedAt: updatedAt,
            completedAt: running ? null : updatedAt,
            assistantMessageId: null,
          },
    createdAt: iso(history.info.createdAt),
    updatedAt,
    archivedAt: null,
    deletedAt: null,
    messages: out.messages,
    proposedPlans: out.plans,
    activities: out.activities,
    checkpoints: [],
    session: {
      threadId: loopSessionId,
      status: running ? "running" : "idle",
      providerName: history.info.provider || null,
      providerInstanceId: toInstanceId(history.info.provider),
      runtimeMode: "full-access",
      activeTurnId: running ? live.turnId : null,
      lastError: null,
      updatedAt,
    },
  });
});

/** How long to gather live-turn changes before rebuilding the thread. */
const REBUILD_COALESCE_MS = 80;

const authFailure = (message: string) =>
  new EnvironmentAuthorizationError({ message, requiredScope: AuthOrchestrationReadScope });

/**
 * Subscribe loop's event stream to this session.
 *
 * loop only broadcasts a turn to clients that have attached, so without this
 * a thread would render its transcript and then sit still while the agent
 * worked. `session.open` revives the session without subscribing; `attach`
 * is the subscription, and is a separate call precisely so history can be
 * rendered first and no event can slip in between and apply twice.
 */
const attach = (loopSessionId: string) =>
  Effect.promise(async () => {
    await loopCall("session.open", { sessionId: loopSessionId }).catch(() => undefined);
    await loopCall("session.attach", { sessionId: loopSessionId }).catch(() => undefined);
  });

const snapshotItem = (thread: unknown): OrchestrationThreadStreamItem =>
  ({ kind: "snapshot", snapshot: { snapshotSequence: 0, thread } }) as OrchestrationThreadStreamItem;

/**
 * The thread as a stream: the transcript, the completion marker the client
 * waits on, then a fresh snapshot each time the in-flight turn moves.
 */
export function threadStream(
  threadId: string,
): Stream.Stream<OrchestrationThreadStreamItem, EnvironmentAuthorizationError> {
  const loopSessionId = loopSessionIdFor(threadId);

  const initial = Effect.gen(function* () {
    yield* attach(loopSessionId);
    const thread = yield* buildThread(loopSessionId);
    return [snapshotItem(thread), { kind: "synchronized" as const }];
  }).pipe(Effect.mapError(() => authFailure(`loop could not open thread ${threadId}`)));

  const updates = Stream.callback<OrchestrationThreadStreamItem>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const unsubscribe = onLiveTurnChange((changed) => {
          if (changed !== loopSessionId || timer !== null) return;
          timer = setTimeout(() => {
            timer = null;
            void Effect.runPromise(buildThread(loopSessionId))
              .then((thread) => Queue.offerUnsafe(queue, snapshotItem(thread)))
              .catch(() => undefined);
          }, REBUILD_COALESCE_MS);
        });
        return () => {
          if (timer !== null) clearTimeout(timer);
          unsubscribe();
        };
      }),
      (dispose) => Effect.sync(dispose),
    ).pipe(Effect.asVoid),
  );

  return Stream.fromEffect(initial).pipe(Stream.flattenIterable, Stream.concat(updates));
}
