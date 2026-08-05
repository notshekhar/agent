/**
 * The shell: what the sidebar and the project view are built from.
 *
 * loop has no concept of a "project" — it has sessions, each with a `cwd`. So
 * **the cwd is the project**: sessions are grouped by it, and a project's id is
 * the folder path itself. Nothing is persisted for this; the grouping is
 * derived from `session.list` every time, which means a folder appears the
 * moment it has a session and disappears when its last one is gone.
 *
 * `ProjectId` and `ThreadId` are both `TrimmedNonEmptyString` underneath, so a
 * path and a loop session id are legal ids as-is.
 */
import {
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
  OrchestrationShellSnapshot as OrchestrationShellSnapshotSchema,
} from "@loop/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { toInstanceId } from "./ids.ts";
import { loopCall } from "../transport.ts";

/** A row of loop's `session.list`; see packages/core/src/sessions/manager.ts. */
export interface LoopSessionRow {
  readonly id: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly mtime: number;
  readonly provider: string;
  readonly model: string;
  readonly name?: string;
  readonly firstUserMessage?: string;
  readonly running?: boolean;
  readonly attached?: number;
}

const decodeSnapshot = Schema.decodeUnknownEffect(OrchestrationShellSnapshotSchema);

const iso = (epochMs: number) => new Date(epochMs).toISOString();

function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name === "" ? trimmed || "/" : name;
}

/** A thread's title: what the user named it, else what they first asked. */
function threadTitle(row: LoopSessionRow): string {
  const named = row.name?.trim();
  if (named) return named;
  const first = row.firstUserMessage?.trim().replace(/\s+/g, " ");
  if (first) return first.length > 80 ? `${first.slice(0, 79)}…` : first;
  return "Untitled";
}

export const buildShellSnapshot = Effect.fnUntraced(function* () {
  const rows = yield* Effect.promise(() =>
    loopCall<readonly LoopSessionRow[]>("session.list").catch(() => [] as readonly LoopSessionRow[]),
  );

  const projects = new Map<string, { created: number; updated: number }>();
  for (const row of rows) {
    const existing = projects.get(row.cwd);
    if (existing) {
      existing.created = Math.min(existing.created, row.createdAt);
      existing.updated = Math.max(existing.updated, row.mtime);
    } else {
      projects.set(row.cwd, { created: row.createdAt, updated: row.mtime });
    }
  }

  const newestFirst = [...rows].sort((a, b) => b.mtime - a.mtime);

  return yield* decodeSnapshot({
    // One derived snapshot per read; there is no incremental sequence to
    // resume from, so every subscription starts from zero.
    snapshotSequence: 0,
    projects: [...projects].map(([cwd, times]) => ({
      id: cwd,
      title: folderName(cwd),
      workspaceRoot: cwd,
      defaultModelSelection: null,
      scripts: [],
      createdAt: iso(times.created),
      updatedAt: iso(times.updated),
    })),
    threads: newestFirst.map((row) => ({
      id: row.id,
      projectId: row.cwd,
      title: threadTitle(row),
      modelSelection: { instanceId: toInstanceId(row.provider), model: row.model || "unknown" },
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.mtime),
      archivedAt: null,
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    })),
    updatedAt: iso(Date.now()),
  });
});

/**
 * The items a fresh `orchestration.subscribeShell` emits: the snapshot, then
 * the completion marker the client waits on before it will render.
 */
export const initialShellItems = Effect.fnUntraced(function* () {
  const snapshot: OrchestrationShellSnapshot = yield* buildShellSnapshot();
  return [
    { kind: "snapshot" as const, snapshot },
    { kind: "synchronized" as const },
  ] satisfies OrchestrationShellStreamItem[];
});
