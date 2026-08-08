/**
 * What a session is costing and how full its context is.
 *
 * These are loop's `/context`, `/cost` and `/steak`, which the terminal has
 * and the app did not. Every number is computed loop-side — `context.report`
 * runs the same assembly `runTurn` does, `usage.steak` lays the heatmap out
 * with the CLI's own `buildSteakGrid` — so the two surfaces cannot disagree
 * about what a streak is or which category a token belongs to. Nothing here
 * recomputes anything; it reads, narrows, and hands the shape to a component.
 *
 * Every reader tolerates an older loop by returning null rather than throwing:
 * a panel that is absent is a fair report of "this loop cannot tell you", and
 * a thrown error inside a popover takes the chat down with it.
 */
import { loopCall } from "./transport.ts";

/** One row of loop's `/context` breakdown. */
export interface ContextCategory {
  readonly key: string;
  readonly label: string;
  readonly tokens: number;
}

export interface ContextReport {
  readonly modelId: string;
  /** 0 when loop's catalog does not know the model — the bar cannot be drawn
   * from a window of zero, and callers check for it. */
  readonly contextWindow: number;
  /** Fraction of the window at which loop compacts on its own. */
  readonly autoCompactThreshold: number;
  readonly categories: readonly ContextCategory[];
  readonly totalTokens: number;
  readonly freeTokens: number;
  readonly skills: readonly { readonly name: string; readonly tokens: number }[];
  readonly toolCount: number;
  readonly mcpToolCount: number;
}

export interface SessionCost {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly usd: number;
  /** The total includes an estimated (interrupted-turn) amount, so it renders
   * with a leading `~` rather than as an exact figure. */
  readonly estimated?: boolean;
}

export interface CostStats {
  readonly lifetimeUsd: number;
  readonly byProvider: Readonly<Record<string, number>>;
  readonly todayUsd: number;
  readonly last7Usd: number;
  readonly monthUsd: number;
  /** Spend in the folder the caller asked about; 0 when none was passed. */
  readonly cwdUsd: number;
}

export interface SteakGrid {
  readonly totalTokens: number;
  readonly stats: {
    readonly currentStreak: number;
    readonly longestStreak: number;
    readonly activeDays: number;
    readonly busiestDay: string;
    readonly busiestDayTokens: number;
  };
  readonly weeks: number;
  /** `cells[weekday][weekIndex]`, weekday 0=Sun. -1 = outside the range, 0 =
   * no usage, 1..4 = quartile buckets. */
  readonly cells: readonly (readonly number[])[];
  readonly tokens: readonly (readonly number[])[];
  readonly startDay: string;
  readonly monthLabels: readonly string[];
  readonly thresholds: readonly [number, number, number];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The context breakdown for an open session, or — with no session id — the
 * fixed overhead a new one in that folder would start with, which is what the
 * composer can show before the first message.
 */
export async function readContextReport(input: {
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly model?: string;
}): Promise<ContextReport | null> {
  const report = await loopCall<unknown>(
    "context.report",
    {
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.model === undefined ? {} : { model: input.model }),
    },
    input.cwd,
  ).catch(() => null);
  if (!isRecord(report) || !Array.isArray(report.categories)) return null;
  return report as unknown as ContextReport;
}

/**
 * What this conversation has cost. Seeded from loop's ledger, so it survives
 * reopening the session in a new window.
 *
 * An all-zero breakdown comes back as null rather than as `$0.00`, and the
 * distinction matters: MEASURED against loop 0.15.11, `cost.session` builds a
 * fresh unseeded tracker for a session that process has not run a turn in, so
 * it answers zero for a conversation that cost real money. Reporting nothing
 * is honest; reporting `$0.0000` claims the session was free.
 *
 * Safe in the other direction too — a session with no turns has genuinely
 * spent nothing, and there is nothing to show for it either.
 */
export async function readSessionCost(
  sessionId: string,
  cwd?: string,
): Promise<SessionCost | null> {
  const cost = await loopCall<unknown>("cost.session", { sessionId }, cwd).catch(() => null);
  if (!isRecord(cost) || typeof cost.usd !== "number") return null;
  const breakdown = cost as unknown as SessionCost;
  const empty =
    breakdown.usd === 0 &&
    breakdown.inputTokens === 0 &&
    breakdown.outputTokens === 0 &&
    breakdown.cachedInputTokens === 0;
  return empty ? null : breakdown;
}

/** Today / 7d / month / lifetime spend, plus this folder's share when asked. */
export async function readCostStats(cwd?: string): Promise<CostStats | null> {
  // `cwd` rides the params, not only the routing argument: over the Electron
  // bridge the argument only chooses which `loop rpc` process answers, and
  // `cost.stats` needs it as a parameter to fill in `cwdUsd`.
  const stats = await loopCall<unknown>(
    "cost.stats",
    cwd === undefined ? {} : { cwd },
    cwd,
  ).catch(() => null);
  if (!isRecord(stats) || typeof stats.lifetimeUsd !== "number") return null;
  return stats as unknown as CostStats;
}

/** The token-usage heatmap. `year` renders a calendar year; omit for the
    trailing 52 weeks, which is what the terminal shows. */
export async function readSteak(input: {
  readonly year?: number;
  readonly cwd?: string;
} = {}): Promise<SteakGrid | null> {
  const grid = await loopCall<unknown>(
    "usage.steak",
    input.year === undefined ? {} : { year: input.year },
    input.cwd,
  ).catch(() => null);
  if (!isRecord(grid) || !Array.isArray(grid.cells)) return null;
  return grid as unknown as SteakGrid;
}

export interface CompactResult {
  readonly summary: string;
  readonly cutAt: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

/**
 * Compact now — loop's `/compact`.
 *
 * Unlike the readers this one THROWS, because it is an action: "nothing
 * happened" and "it failed" have to be distinguishable, and loop refuses while
 * a turn is running. A summary of `""` is loop's own "there was nothing to
 * compact", not a failure.
 */
export async function compactSession(sessionId: string, cwd?: string): Promise<CompactResult> {
  const result = await loopCall<unknown>("session.compact", { sessionId }, cwd);
  if (!isRecord(result) || typeof result.summary !== "string") {
    throw new Error("loop did not report what it compacted");
  }
  return result as unknown as CompactResult;
}
