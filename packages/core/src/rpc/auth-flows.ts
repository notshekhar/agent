/**
 * Signing in to a provider from a remote client.
 *
 * `auth.login` already covered the easy half — paste an API key, store it. The
 * other half is every login the TUI can do and a socket could not: xAI's
 * SuperGrok OAuth, ChatGPT/Codex, GitHub Copilot's device flow, and the
 * zero-key providers whose "login" is really a probe (Bedrock's AWS chain,
 * Ollama's local daemon).
 *
 * Those flows are *conversations*: they hand back a URL to open, sometimes ask
 * a question mid-flight (Copilot wants the GitHub Enterprise domain first),
 * and finish minutes later. A JSON-RPC request/response cannot hold one open —
 * the TUI gets to await a prompt because it owns the terminal, and a socket
 * client does not.
 *
 * So a flow becomes a small server-side object with an append-only event log
 * the client drains by cursor:
 *
 *     auth.flow.start   → { flowId }
 *     auth.flow.poll    → { events, cursor, status }   (repeat)
 *     auth.flow.answer  → resolves a `prompt` event
 *     auth.flow.cancel  → aborts it
 *
 * Polling rather than pushing is deliberate: loop's notification channel is
 * per-session (`session.event`), and a login belongs to no session.
 */
import { randomBytes } from "node:crypto";
import {
    getAuthMode,
    listAuthorizedProviders,
    listCustomProviders,
    loginOAuth,
    loginXaiOAuth,
    loginApiKey,
    setActiveProvider,
} from "../auth";
import { bustCatalogCache, refreshBedrockCatalog } from "../catalog";
import { envName } from "../brand";
import { getExtensionHost } from "../extensions";
import { bedrockRegion, listOllamaModels, ollamaBaseURL, resolveAwsCredentials } from "../providers";
import { BUILTIN_PROVIDER_IDS, type ProviderId } from "../types";

/** How a provider can be signed in to, in the order a picker should offer them. */
export type AuthMethod = "oauth" | "apikey" | "detect";

/**
 * Providers whose OAuth is actually wired into `getModel`. Registering an
 * OAuth implementation is not enough — anthropic has one, but the anthropic
 * branch of `getModel` reads `getApiKey`, so OAuth creds stored under it would
 * never be used. Offering it here would produce a login that appears to work
 * and then fails on the first turn.
 */
const OAUTH_PROVIDERS: Record<string, ProviderId> = {
    // The picker entry is "openai"; the credentials live under the id the
    // model router looks up, exactly as the TUI's /login does.
    openai: "openai-chatgpt",
    "openai-chatgpt": "openai-chatgpt",
    "github-copilot": "github-copilot",
    xai: "xai",
};

/** Providers with no credential to enter: the "login" is a probe. */
const DETECT_PROVIDERS = new Set<ProviderId>(["bedrock", "ollama"]);

/** Which methods a provider offers, most preferred first. */
export function authMethodsFor(provider: string): AuthMethod[] {
    if (DETECT_PROVIDERS.has(provider as ProviderId)) return ["detect"];
    const methods: AuthMethod[] = [];
    if (provider in OAUTH_PROVIDERS) methods.push("oauth");
    // Copilot has no API keys at all; every other OAuth provider also accepts one.
    if (provider !== "github-copilot") methods.push("apikey");
    return methods;
}

/** The env var `getApiKey` falls back to, so the UI can say where a key came from. */
export function apiKeyEnvVar(provider: string): string | undefined {
    if (DETECT_PROVIDERS.has(provider as ProviderId)) return undefined;
    if (provider === "vercel") return "AI_GATEWAY_API_KEY";
    if (provider === "github-copilot") return undefined;
    return `${provider.replace(/-/g, "_").toUpperCase()}_API_KEY`;
}

export interface ProviderDescriptor {
    readonly id: string;
    readonly kind: "builtin" | "custom" | "extension";
    /** Has usable stored credentials right now. */
    readonly authorized: boolean;
    /** How the stored credential was obtained, or "missing". */
    readonly mode: "apikey" | "oauth" | "missing";
    readonly methods: readonly AuthMethod[];
    readonly envVar?: string;
    /** Custom gateways only — enough to describe the endpoint in the UI. */
    readonly baseURL?: string;
    readonly sdk?: string;
}

/**
 * Every provider a client may offer, authorized or not.
 *
 * Deliberately wider than `auth.status`, which answers "what can run now".
 * A settings screen has to list the providers you could sign in to, or there
 * would be nothing to click.
 */
export function listProviderDescriptors(): ProviderDescriptor[] {
    const authorized = new Set<string>(listAuthorizedProviders());
    const builtins = BUILTIN_PROVIDER_IDS.map((id): ProviderDescriptor => {
        const envVar = apiKeyEnvVar(id);
        // A key in the environment authorizes the provider just as a stored one
        // does (see getApiKey), and the TUI treats it that way — so a provider
        // configured by env must not render as "not connected".
        const fromEnv = envVar !== undefined && Boolean(process.env[envVar]);
        return {
            id,
            kind: "builtin",
            authorized: authorized.has(id) || fromEnv,
            mode: getAuthMode(id),
            methods: authMethodsFor(id),
            ...(envVar ? { envVar } : {}),
        };
    });
    // ChatGPT credentials are stored under their own id but presented on the
    // "openai" row, so the separate entry would be a duplicate the user cannot
    // act on. Its authorization is folded into openai instead.
    const chatgptAuthorized = authorized.has("openai-chatgpt");
    const merged = builtins.map((descriptor) =>
        descriptor.id === "openai" && chatgptAuthorized
            ? { ...descriptor, authorized: true, mode: getAuthMode("openai-chatgpt") }
            : descriptor,
    );

    const customs = listCustomProviders().map(
        (config): ProviderDescriptor => ({
            id: `custom:${config.name}`,
            kind: "custom",
            authorized: true,
            mode: "apikey",
            methods: ["apikey"],
            baseURL: config.baseURL,
            sdk: config.sdk,
        }),
    );

    const builtinIds = new Set<string>(BUILTIN_PROVIDER_IDS);
    const extensions = getExtensionHost()
        .getProviderDescriptors()
        .filter((plugin) => !builtinIds.has(plugin.id))
        .map(
            (plugin): ProviderDescriptor => ({
                id: plugin.id,
                kind: "extension",
                authorized: authorized.has(plugin.id),
                mode: getAuthMode(plugin.id),
                methods: (plugin.auth?.mode ?? "apikey") === "apikey" ? ["apikey"] : [],
                ...(plugin.auth?.envVar ? { envVar: plugin.auth.envVar } : {}),
            }),
        );

    return [...merged, ...customs, ...extensions];
}

// ─── Interactive flows ────────────────────────────────────────────────────────

export type AuthFlowEvent =
    | { type: "auth"; url: string; instructions?: string }
    | { type: "progress"; message: string }
    | { type: "prompt"; promptId: string; message: string; placeholder?: string; allowEmpty: boolean }
    | { type: "done"; message: string }
    | { type: "error"; message: string };

export type AuthFlowStatus = "running" | "done" | "error" | "cancelled";

interface Flow {
    readonly id: string;
    readonly provider: string;
    readonly events: AuthFlowEvent[];
    readonly abort: AbortController;
    status: AuthFlowStatus;
    /** The question currently awaiting `auth.flow.answer`, if any. */
    pending?: { promptId: string; resolve: (value: string) => void };
    finishedAt?: number;
}

const flows = new Map<string, Flow>();
/** A finished flow is kept briefly so a slow poll still sees how it ended. */
const FLOW_RETENTION_MS = 60_000;

function sweep(): void {
    const cutoff = Date.now() - FLOW_RETENTION_MS;
    for (const [id, flow] of flows) {
        if (flow.finishedAt !== undefined && flow.finishedAt < cutoff) flows.delete(id);
    }
}

function emit(flow: Flow, event: AuthFlowEvent): void {
    flow.events.push(event);
}

function finish(flow: Flow, status: AuthFlowStatus, event: AuthFlowEvent): void {
    if (flow.status !== "running") return;
    flow.status = status;
    flow.finishedAt = Date.now();
    emit(flow, event);
    // A prompt nobody will answer must not leave the login half-run.
    flow.pending?.resolve("");
    delete flow.pending;
}

/** The callbacks a core OAuth implementation expects, backed by the event log. */
function callbacksFor(flow: Flow) {
    let promptSeq = 0;
    return {
        onAuth: ({ url, instructions }: { url: string; instructions?: string }) =>
            emit(flow, { type: "auth", url, ...(instructions ? { instructions } : {}) }),
        onProgress: (message: string) => emit(flow, { type: "progress", message }),
        onPrompt: ({
            message,
            placeholder,
            allowEmpty,
        }: {
            message: string;
            placeholder?: string;
            allowEmpty?: boolean;
        }) =>
            new Promise<string>((resolve) => {
                const promptId = `p${++promptSeq}`;
                flow.pending = { promptId, resolve };
                emit(flow, {
                    type: "prompt",
                    promptId,
                    message,
                    ...(placeholder ? { placeholder } : {}),
                    allowEmpty: allowEmpty ?? false,
                });
            }),
        signal: flow.abort.signal,
    };
}

/** Bedrock's login: resolve AWS credentials, then prove the region answers. */
async function runBedrockDetect(flow: Flow): Promise<void> {
    emit(flow, { type: "progress", message: "Resolving AWS credentials…" });
    const creds = await resolveAwsCredentials();
    if (!creds) {
        throw new Error(
            "No AWS credentials found. Sign in with the AWS CLI (`aws configure` or `aws sso login`) or set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.",
        );
    }
    const region = bedrockRegion();
    emit(flow, { type: "progress", message: `Listing Bedrock models in ${region}…` });
    const models = await refreshBedrockCatalog();
    if (models === null) {
        throw new Error(
            `Could not list Bedrock models in ${region}. Check the account has Bedrock access there (AWS_REGION or ${envName("BEDROCK_REGION")} switches region).`,
        );
    }
    if (models.length === 0) {
        throw new Error(
            `Bedrock answered but no invokable models in ${region}. Request model access in the AWS console (Bedrock → Model access).`,
        );
    }
    // Credentials stay in the AWS chain; the placeholder is what marks the
    // provider authorized, exactly as the TUI's /login bedrock does.
    loginApiKey("bedrock", "aws");
    setActiveProvider("bedrock");
    finish(flow, "done", {
        type: "done",
        message: `Bedrock connected — ${models.length} model${models.length === 1 ? "" : "s"} in ${region}.`,
    });
}

/** Ollama's login: the daemon has to be up and hold at least one model. */
async function runOllamaDetect(flow: Flow): Promise<void> {
    emit(flow, { type: "progress", message: "Checking the local Ollama daemon…" });
    const models = await listOllamaModels();
    if (models === null) {
        throw new Error(
            `Ollama is not reachable at ${ollamaBaseURL()}. Start it (\`ollama serve\`) or set ${envName("OLLAMA_BASE_URL")}.`,
        );
    }
    if (models.length === 0) {
        throw new Error("Ollama is running but no models are installed. Pull one, e.g. `ollama pull llama3.2`.");
    }
    loginApiKey("ollama", "local");
    setActiveProvider("ollama");
    finish(flow, "done", {
        type: "done",
        message: `Ollama connected — ${models.length} model${models.length === 1 ? "" : "s"} installed.`,
    });
}

async function runFlow(flow: Flow, method: AuthMethod): Promise<void> {
    if (method === "detect") {
        if (flow.provider === "bedrock") return runBedrockDetect(flow);
        if (flow.provider === "ollama") return runOllamaDetect(flow);
        throw new Error(`${flow.provider} has nothing to detect`);
    }
    const target = OAUTH_PROVIDERS[flow.provider];
    if (!target) throw new Error(`${flow.provider} does not support OAuth`);
    if (target === "xai") {
        await loginXaiOAuth((info) => emit(flow, { type: "auth", ...info }));
        setActiveProvider("xai");
    } else {
        await loginOAuth(target, callbacksFor(flow));
        setActiveProvider(target);
    }
    bustCatalogCache();
    finish(flow, "done", { type: "done", message: `Signed in to ${flow.provider}.` });
}

export interface StartAuthFlowInput {
    readonly provider: string;
    readonly method?: AuthMethod;
}

/**
 * Begin a login. Returns immediately with the flow's id — the work continues
 * in the background and is observed through `pollAuthFlow`.
 */
export function startAuthFlow(input: StartAuthFlowInput): { flowId: string; provider: string; method: AuthMethod } {
    sweep();
    const provider = input.provider.trim();
    if (!provider) throw new Error("provider required");
    const available = authMethodsFor(provider);
    const method = input.method ?? available.find((candidate) => candidate !== "apikey") ?? available[0];
    if (!method) throw new Error(`${provider} has no interactive login`);
    if (method === "apikey") throw new Error("API-key logins go through auth.login, not auth.flow.start");
    if (!available.includes(method)) throw new Error(`${provider} does not support ${method} login`);

    // A second flow for the same provider would race the first over the same
    // callback port and the same store entry.
    for (const existing of flows.values()) {
        if (existing.provider === provider && existing.status === "running") {
            return { flowId: existing.id, provider, method };
        }
    }

    const flow: Flow = {
        id: randomBytes(8).toString("hex"),
        provider,
        events: [],
        abort: new AbortController(),
        status: "running",
    };
    flows.set(flow.id, flow);
    void runFlow(flow, method).catch((err: unknown) => {
        finish(flow, "error", { type: "error", message: err instanceof Error ? err.message : String(err) });
    });
    return { flowId: flow.id, provider, method };
}

export interface PollAuthFlowResult {
    readonly status: AuthFlowStatus;
    readonly cursor: number;
    readonly events: readonly AuthFlowEvent[];
    /** The prompt still awaiting an answer, so a reconnecting client can see it. */
    readonly pendingPromptId?: string;
}

export function pollAuthFlow(flowId: string, cursor = 0): PollAuthFlowResult {
    const flow = flows.get(flowId);
    if (!flow) throw new Error(`unknown login flow: ${flowId}`);
    const from = Math.max(0, Math.min(cursor, flow.events.length));
    return {
        status: flow.status,
        cursor: flow.events.length,
        events: flow.events.slice(from),
        ...(flow.pending ? { pendingPromptId: flow.pending.promptId } : {}),
    };
}

export function answerAuthFlow(flowId: string, promptId: string, value: string): { ok: true } {
    const flow = flows.get(flowId);
    if (!flow) throw new Error(`unknown login flow: ${flowId}`);
    const pending = flow.pending;
    if (!pending) throw new Error("this login is not waiting for an answer");
    if (pending.promptId !== promptId) throw new Error("stale answer — the login has moved on");
    delete flow.pending;
    pending.resolve(value);
    return { ok: true };
}

export function cancelAuthFlow(flowId: string): { ok: true } {
    const flow = flows.get(flowId);
    if (!flow) return { ok: true };
    flow.abort.abort();
    finish(flow, "cancelled", { type: "error", message: "Login cancelled." });
    return { ok: true };
}

/** Test seam: drop every flow so state cannot leak between cases. */
export function resetAuthFlows(): void {
    for (const flow of flows.values()) flow.abort.abort();
    flows.clear();
}
