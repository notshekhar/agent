/**
 * Self-healing request shaping for Anthropic-shaped endpoints.
 *
 * The thinking parameters are the one part of the Anthropic request whose
 * accepted form we cannot know from the model id alone:
 *
 *  - it moves per model generation (`{type:"enabled",budget_tokens}` →
 *    `{type:"adaptive"}` + `output_config.effort`, and thinking is on by
 *    default — no field at all — from Claude Opus 5 / Sonnet 5 onward);
 *  - a gateway in front of Anthropic can rewrite it. Measured against bifrost
 *    (2026-07-27, claude-opus-5): a streaming request carrying
 *    `thinking:{type:"adaptive"}` arrives at Anthropic as
 *    `thinking:{type:"enabled"}` and 400s with `"thinking.type.enabled" is not
 *    supported for this model`; the same body non-streaming 500s with "failed
 *    to convert bifrost request". Dropping `thinking` and sending only
 *    `output_config.effort` passes — and is equivalent on models where
 *    omitting the field runs adaptive anyway.
 *
 * No model table can describe that second class of failure, because the fault
 * is in the transport, not the model. So instead of only guessing up front
 * (see agent/thinking.ts for the seed shapes), we read the rejection: on a
 * recognized "wrong thinking shape" error the request body is rewritten into
 * the next shape and re-issued ONCE, transparently — the caller never sees the
 * failed attempt — and the working shape is remembered per provider+model so
 * every later request starts there, in this session and future ones.
 *
 * Bounded by construction: one retry per request, and a shape is only recorded
 * after the retry actually succeeds.
 */
import { join } from "node:path";
import { CachedStore } from "../auth/storage";
import { getConfigDir, PRODUCT_NAME } from "../brand";
import { debugLog } from "../debug";

/**
 * The wire forms of "think this hard", in the order they were introduced.
 *  - `adaptive`: `thinking:{type:"adaptive",display:"summarized"}` +
 *    `output_config.effort` — the documented shape for Opus 4.6+/Sonnet 4.6+.
 *  - `adaptive-plain`: the same without `display`, for an endpoint that rejects
 *    the field (it only controls whether the reasoning text is returned).
 *  - `omit`: no `thinking`, `output_config.effort` only — identical behaviour
 *    on models where omitting the field runs adaptive (Opus 5, Sonnet 5,
 *    Fable/Mythos 5), and the only shape that survives a proxy that can't
 *    carry the field.
 *  - `legacy`: `thinking:{type:"enabled",budget_tokens}`, no `output_config` —
 *    Opus 4.5 / Sonnet 4.5 / Haiku 4.5 and older.
 *  - `bare`: neither field — last resort when the endpoint rejects both.
 */
export type ThinkingShape = "adaptive" | "adaptive-plain" | "omit" | "legacy" | "bare";

/** Request bodies we leave alone: thinking explicitly off, or never on. */
type BodyShape = ThinkingShape | "disabled" | "none";

interface AnthropicBody {
    model?: unknown;
    max_tokens?: unknown;
    thinking?: { type?: string; budget_tokens?: number; display?: string } | null;
    output_config?: { effort?: string } | null;
}

const shapeStore = new CachedStore(
    `${PRODUCT_NAME}-agent-model-shapes`,
    { shapes: {} },
    { configPath: join(getConfigDir(), "model-shapes.json") },
);

function shapeKey(providerKey: string, model: string): string {
    return `${providerKey}|${model}`;
}

/** The shape learned for this provider+model, if a retry has already proved one. */
export function learnedShape(providerKey: string, model: string): ThinkingShape | undefined {
    const shapes = shapeStore.get("shapes") as Record<string, string> | undefined;
    const v = shapes?.[shapeKey(providerKey, model)] as ThinkingShape | undefined;
    return v && SHAPES.includes(v) ? v : undefined;
}

function rememberShape(providerKey: string, model: string, shape: ThinkingShape): void {
    const shapes = { ...((shapeStore.get("shapes") as Record<string, string> | undefined) ?? {}) };
    shapes[shapeKey(providerKey, model)] = shape;
    shapeStore.set("shapes", shapes);
}

/** Test seam: forget everything learned (also used by `/doctor`-style resets). */
export function forgetShapes(): void {
    shapeStore.set("shapes", {});
}

/**
 * Thinking budgets for the legacy shape, by effort. Only used when an endpoint
 * turns out to predate `output_config.effort`, so the numbers just have to be
 * a sane ladder — the API requires 1024 ≤ budget < max_tokens.
 */
const LEGACY_BUDGET: Record<string, number> = { low: 4096, medium: 8192, high: 16384, xhigh: 32768, max: 32768 };

const SHAPES: ThinkingShape[] = ["adaptive", "adaptive-plain", "omit", "legacy", "bare"];

export function bodyShape(body: AnthropicBody): BodyShape {
    const type = body.thinking?.type;
    if (type === "adaptive") return body.thinking?.display ? "adaptive" : "adaptive-plain";
    if (type === "enabled") return "legacy";
    if (type === "disabled") return "disabled";
    if (body.output_config?.effort) return "omit";
    return "none";
}

/**
 * Rewrite `body` into `shape` in place. Effort is preserved across shapes
 * (translated to a budget for `legacy`) so a corrected request still thinks as
 * hard as the user asked. Returns false when the body is already in that shape.
 */
export function applyShape(body: AnthropicBody, shape: ThinkingShape, effortHint?: string): boolean {
    const current = bodyShape(body);
    if (current === shape) return false;
    // Never turn an explicitly-off request on, and never invent thinking for a
    // request that asked for none.
    if (current === "disabled" || current === "none") return false;
    const effort = body.output_config?.effort ?? effortHint ?? "medium";
    switch (shape) {
        case "adaptive":
            body.thinking = { type: "adaptive", display: "summarized" };
            body.output_config = { ...(body.output_config ?? {}), effort };
            return true;
        case "adaptive-plain":
            body.thinking = { type: "adaptive" };
            body.output_config = { ...(body.output_config ?? {}), effort };
            return true;
        case "omit":
            delete body.thinking;
            body.output_config = { ...(body.output_config ?? {}), effort };
            return true;
        case "legacy": {
            const max = typeof body.max_tokens === "number" ? body.max_tokens : 0;
            const wanted = LEGACY_BUDGET[effort] ?? 8192;
            // budget_tokens must stay strictly below max_tokens (min 1024).
            const budget = max > 1024 ? Math.max(1024, Math.min(wanted, max - 1024)) : wanted;
            body.thinking = { type: "enabled", budget_tokens: budget };
            delete body.output_config;
            return true;
        }
        case "bare":
            delete body.thinking;
            delete body.output_config;
            return true;
    }
}

/**
 * The shape to try next, read off the endpoint's own rejection. Undefined for
 * anything that isn't a thinking-shape complaint — those errors are the
 * caller's to see, unchanged.
 */
function isAdaptive(shape: BodyShape): boolean {
    return shape === "adaptive" || shape === "adaptive-plain";
}

export function shapeFromError(current: BodyShape, status: number, errorText: string): ThinkingShape | undefined {
    if (current === "disabled" || current === "none") return undefined;
    const text = errorText.toLowerCase();

    // A proxy that can't serialize the field at all (bifrost: "failed to
    // convert bifrost request to the expected provider request body").
    if (/failed to convert .*request/.test(text)) return isAdaptive(current) ? "omit" : undefined;
    if (status < 400 || status >= 500) return undefined;

    // `thinking.display` is visibility only — never lose a turn over it. Drop
    // the field and keep thinking rather than escalating to another shape.
    if (
        current === "adaptive" &&
        /(thinking\.)?display.{0,60}(not supported|unsupported|unexpected|unknown|unrecognized|invalid)/.test(text)
    ) {
        return "adaptive-plain";
    }

    // Thinking complaints first — these messages name the *remedy* as well as
    // the offender ("… is not supported. Use thinking.type.adaptive and
    // output_config.effort"), so match on the token the endpoint actually
    // objected to rather than on any mention of a field name. Otherwise the
    // remedy text gets read as a second complaint.
    // The quoting is whatever the endpoint chose, seen through JSON escaping:
    // `\"thinking.type.enabled\" is not supported…`.
    const offender =
        /thinking\.type\.(enabled|adaptive|disabled)[\\"'`\s]*(?:is\s+)?(?:not supported|unsupported|invalid|unknown)/.exec(
            text,
        )?.[1];
    switch (offender) {
        // If we already sent adaptive, something between us and the model
        // rewrote it — we can't fix the rewriter, so stop sending the field.
        case "enabled":
            return isAdaptive(current) ? "omit" : "adaptive";
        // An endpoint that only knows the legacy shape.
        case "adaptive":
            return "legacy";
        // Thinking can't be turned off here (Fable 5), or not at this effort
        // (Opus 5 above `high`): let the model default instead.
        case "disabled":
            return "omit";
    }
    if (/budget_tokens/.test(text)) {
        // Rejected → the model has moved past budgets; demanded → it hasn't.
        if (/not supported|unsupported|unexpected|unknown/.test(text)) {
            return isAdaptive(current) ? "omit" : "adaptive";
        }
        if (/required|missing/.test(text)) return "legacy";
    }
    // Effort itself rejected → the endpoint predates `output_config`.
    if (
        /output_config.{0,80}(not supported|unsupported|unexpected|unknown|unrecognized|invalid)/.test(text) ||
        /(not supported|unsupported|unexpected|unknown|unrecognized|invalid).{0,80}output_config/.test(text)
    ) {
        return current === "legacy" ? "bare" : "legacy";
    }
    return undefined;
}

function parseBody(body: unknown): AnthropicBody | undefined {
    if (typeof body !== "string" || !body.startsWith("{")) return undefined;
    try {
        const json = JSON.parse(body) as AnthropicBody;
        return typeof json === "object" && json !== null ? json : undefined;
    } catch {
        return undefined;
    }
}

/** Re-issue with a rewritten body; content-length no longer matches. */
function withBody(init: RequestInit | undefined, body: AnthropicBody): RequestInit {
    const headers = new Headers(init?.headers);
    headers.delete("content-length");
    return { ...(init ?? {}), headers, body: JSON.stringify(body) };
}

/**
 * Wrap an Anthropic-shaped fetch so thinking-parameter rejections are learned
 * from and corrected instead of surfacing as a dead turn. `providerKey`
 * namespaces what is learned (the same model id behaves differently through a
 * gateway than it does first-party).
 */
export function anthropicShapeFetch(providerKey: string, base: typeof fetch = fetch): typeof fetch {
    const wrapped = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
        const body = parseBody(init?.body);
        const model = typeof body?.model === "string" ? body.model : undefined;
        if (!body || !model) return base(input, init as RequestInit);

        let sent = init;
        const learned = learnedShape(providerKey, model);
        if (learned && applyShape(body, learned)) {
            debugLog("shape", `${providerKey}/${model}: using learned shape ${learned}`);
            sent = withBody(init, body);
        }

        const res = await base(input, sent as RequestInit);
        if (res.ok) return res;

        // Read the error once, then either hand it back untouched or retry.
        const errorText = await res.text();
        const current = bodyShape(body);
        const next = shapeFromError(current, res.status, errorText);
        if (!next || !applyShape(body, next)) {
            return new Response(errorText, { status: res.status, statusText: res.statusText, headers: res.headers });
        }

        debugLog("shape", `${providerKey}/${model}: ${current} rejected (${res.status}) — retrying as ${next}`);
        const retry = await base(input, withBody(sent, body));
        if (retry.ok) {
            rememberShape(providerKey, model, next);
            debugLog("shape", `${providerKey}/${model}: ${next} accepted — remembered`);
            return retry;
        }
        // The correction did not help: surface the ORIGINAL rejection, which
        // describes what the endpoint actually objected to.
        retry.body?.cancel().catch(() => {});
        return new Response(errorText, { status: res.status, statusText: res.statusText, headers: res.headers });
    };
    // Bun-only (see providers/index.ts withPreconnect): absent on Node, where
    // reading `.bind` off it throws and kills the turn.
    const preconnect = (fetch as typeof fetch & { preconnect?: typeof fetch.preconnect }).preconnect;
    if (preconnect) {
        (wrapped as typeof fetch & { preconnect?: typeof fetch.preconnect }).preconnect =
            preconnect.bind(fetch);
    }
    return wrapped as typeof fetch;
}
