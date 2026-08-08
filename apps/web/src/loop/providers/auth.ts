/**
 * Signing in to loop's providers, from the UI.
 *
 * Every credential decision lives in loop: which providers exist, which are
 * connected, how each one authenticates, and where the secrets are stored. The
 * UI never reads a key, never writes one to disk, and never talks to a
 * provider's auth server itself — it drives loop's `auth.*` RPCs and renders
 * what comes back. That is what makes `loop login` in the terminal and the
 * button in this app the same act rather than two stores to keep in sync.
 *
 * The interesting one is `auth.flow.*`. An OAuth sign-in is a conversation, not
 * a call: it hands back a URL, may ask a question halfway through (Copilot
 * wants a GitHub Enterprise domain before it can even start the device flow),
 * and finishes minutes later. No request/response can hold that open, so loop
 * runs the flow server-side and exposes it as an append-only event log this
 * module drains by cursor. See packages/core/src/rpc/auth-flows.ts.
 */
import { loopCall } from "../transport.ts";
import type { LoopAuthMethod } from "./index.ts";

export interface LoopProviderStatus {
  readonly id: string;
  readonly kind: "builtin" | "custom" | "extension";
  /** Has usable credentials right now — stored, or from the environment. */
  readonly authorized: boolean;
  readonly mode: "apikey" | "oauth" | "missing";
  readonly methods: readonly LoopAuthMethod[];
  /** The env var loop falls back to, so the UI can say where a key came from. */
  readonly envVar?: string;
  readonly baseURL?: string;
  readonly sdk?: string;
}

export interface LoopProvidersSnapshot {
  readonly providers: readonly LoopProviderStatus[];
  readonly active: string | null;
}

/**
 * Every provider loop can offer, connected or not.
 *
 * Deliberately not the same question as `auth.status`, which answers "what can
 * run a turn now". A settings screen has to show what you *could* connect, or
 * there is nothing to click — and that gap is exactly why the ported panel was
 * still rendering the upstream agent list instead of loop's providers.
 */
export async function fetchLoopProviders(cwd?: string): Promise<LoopProvidersSnapshot> {
  try {
    const result = await loopCall<{
      providers?: readonly LoopProviderStatus[];
      active?: string | null;
    }>("auth.providers", {}, cwd);
    return { providers: result.providers ?? [], active: result.active ?? null };
  } catch (cause) {
    if (!isMethodNotFound(cause)) throw cause;
    return await fromAuthStatus(cwd);
  }
}

/** loop answers an unimplemented method by name; there is no error code for it. */
function isMethodNotFound(cause: unknown): boolean {
  return cause instanceof Error && /method not found/i.test(cause.message);
}

/**
 * The provider list rebuilt from `auth.status`, for a loop too old to have
 * `auth.providers`.
 *
 * The desktop shell spawns whichever `loop` is installed on the machine, so
 * the agent can trail the app by a release or more — and a hard failure here
 * would blank the whole settings page over one missing method. `auth.status`
 * has existed all along and carries enough to render honestly: which providers
 * loop can offer and which are connected. What is lost is the sign-in
 * metadata, so no login is offered rather than one being guessed at and
 * failing.
 */
async function fromAuthStatus(cwd?: string): Promise<LoopProvidersSnapshot> {
  const status = await loopCall<{
    providers?: readonly string[];
    authorized?: readonly string[];
    active?: string | null;
  }>("auth.status", {}, cwd);
  const authorized = new Set(status.authorized ?? []);
  const providers = (status.providers ?? []).map(
    (id): LoopProviderStatus => ({
      id,
      kind: id.startsWith("custom:") ? "custom" : "builtin",
      authorized: authorized.has(id),
      mode: authorized.has(id) ? "apikey" : "missing",
      methods: [],
    }),
  );
  return { providers, active: status.active ?? null };
}

/** Store an API key for a provider. loop decides where it lands. */
export async function loginWithApiKey(
  provider: string,
  apiKey: string,
  cwd?: string,
): Promise<void> {
  await loopCall("auth.login", { provider, apiKey }, cwd);
}

/** Drop a provider's credentials. Removes a custom gateway outright. */
export async function logoutProvider(provider: string, cwd?: string): Promise<void> {
  await loopCall("auth.logout", { provider }, cwd);
}

// ─── Interactive flows ────────────────────────────────────────────────────────

export type AuthFlowEvent =
  | { readonly type: "auth"; readonly url: string; readonly instructions?: string }
  | { readonly type: "progress"; readonly message: string }
  | {
      readonly type: "prompt";
      readonly promptId: string;
      readonly message: string;
      readonly placeholder?: string;
      readonly allowEmpty: boolean;
    }
  | { readonly type: "done"; readonly message: string }
  | { readonly type: "error"; readonly message: string };

export type AuthFlowStatus = "running" | "done" | "error" | "cancelled";

export interface AuthFlowPoll {
  readonly status: AuthFlowStatus;
  readonly cursor: number;
  readonly events: readonly AuthFlowEvent[];
  readonly pendingPromptId?: string;
}

export async function startAuthFlow(
  provider: string,
  method: LoopAuthMethod,
  cwd?: string,
): Promise<{ flowId: string }> {
  return await loopCall<{ flowId: string }>("auth.flow.start", { provider, method }, cwd);
}

export async function pollAuthFlow(
  flowId: string,
  cursor: number,
  cwd?: string,
): Promise<AuthFlowPoll> {
  return await loopCall<AuthFlowPoll>("auth.flow.poll", { flowId, cursor }, cwd);
}

export async function answerAuthFlow(
  flowId: string,
  promptId: string,
  value: string,
  cwd?: string,
): Promise<void> {
  await loopCall("auth.flow.answer", { flowId, promptId, value }, cwd);
}

export async function cancelAuthFlow(flowId: string, cwd?: string): Promise<void> {
  await loopCall("auth.flow.cancel", { flowId }, cwd);
}

/** How often a running flow is re-read. Fast enough that a browser redirect
 * lands almost immediately, slow enough to be free over a local pipe. */
export const AUTH_FLOW_POLL_MS = 700;

/**
 * Drive a flow to completion, reporting each event as it arrives.
 *
 * Resolves with how the flow ended rather than throwing on failure: a refused
 * sign-in is an outcome the UI renders, not an exception. Only a broken
 * connection to loop throws.
 */
export async function runAuthFlow(
  input: {
    readonly provider: string;
    readonly method: LoopAuthMethod;
    readonly cwd?: string;
    readonly signal?: AbortSignal;
    /**
     * The flow's id, as soon as loop assigns it — before any event arrives.
     *
     * Needed rather than merely convenient: a flow can ask its first question
     * immediately (Copilot wants the Enterprise domain before it requests a
     * device code) and blocks until it is answered. A caller that only learned
     * the id from the resolved promise could never reply, so the login would
     * hang on its opening question.
     */
    readonly onStart?: (flowId: string) => void;
  },
  onEvent: (event: AuthFlowEvent) => void,
): Promise<{ status: AuthFlowStatus; flowId: string }> {
  const { flowId } = await startAuthFlow(input.provider, input.method, input.cwd);
  input.onStart?.(flowId);
  let cursor = 0;
  while (true) {
    if (input.signal?.aborted) {
      await cancelAuthFlow(flowId, input.cwd).catch(() => {});
      return { status: "cancelled", flowId };
    }
    const poll = await pollAuthFlow(flowId, cursor, input.cwd);
    cursor = poll.cursor;
    for (const event of poll.events) onEvent(event);
    if (poll.status !== "running") return { status: poll.status, flowId };
    await new Promise((resolve) => setTimeout(resolve, AUTH_FLOW_POLL_MS));
  }
}
