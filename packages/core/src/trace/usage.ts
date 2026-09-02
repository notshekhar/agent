/** Tokens and dollars as the trace reports them: flat, summed, priced. */
import { priceUsage } from "../agent/cost";
import { normalizeUsage } from "../sessions/usage";
import type { UsageBlock } from "../types";

export interface TraceUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    /** USD as billed (stamped) or re-priced from the catalog; undefined when
     * neither is possible (unknown model). */
    usd?: number;
    estimated: boolean;
}

export function emptyUsage(): TraceUsage {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, estimated: false };
}

export function addUsage(into: TraceUsage, u: TraceUsage | undefined): void {
    if (!u) return;
    into.input += u.input;
    into.output += u.output;
    into.cacheRead += u.cacheRead;
    into.cacheWrite += u.cacheWrite;
    into.reasoning += u.reasoning;
    if (u.usd !== undefined) into.usd = (into.usd ?? 0) + u.usd;
    if (u.estimated) into.estimated = true;
}

/**
 * Stamped cost is what was actually billed; the provider's own figure
 * (openrouter) next; catalog pricing is the fallback for entries persisted
 * before stamping existed.
 */
export function traceUsage(model: string | undefined, block: UsageBlock | undefined): TraceUsage | undefined {
    if (!block) return undefined;
    const n = normalizeUsage(block);
    const usd = n.usd ?? n.cost ?? (model ? priceUsage(model, block)?.usd : undefined);
    return {
        input: n.input ?? 0,
        output: n.output ?? 0,
        cacheRead: n.cacheRead ?? 0,
        cacheWrite: n.cacheWrite ?? 0,
        reasoning: n.reasoning ?? 0,
        ...(usd !== undefined ? { usd } : {}),
        estimated: n.estimated,
    };
}
