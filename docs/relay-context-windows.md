# Draft: Relay — no-summary context windows

**Phases 1-3 are BUILT** (2026-09-05). Relay ships as the seventh builtin
extension, `defaultEnabled: false` — enable it in `/extensions` or with
`/relay`. Phase 4 (mid-turn rollover) is still open; section 8 has it.

Two deviations from this plan, both deliberate:

- **The extension API is `0.3.1`, not `0.4.0`.** Every change is additive and
  an extension only ever READS `TurnContext`, so nothing breaks — but while the
  API is 0.x the minor must match, so a minor bump would have stopped every
  installed `^0.3` extension from loading for a change that breaks none of them.
- **`api.context.branch()` was added** and is not in the original plan. The
  `history` tool has to read entries the model can no longer see, and there was
  no seam for that; reaching through the AI SDK's tool-execution context was
  the alternative and it is not a supported surface.

Prior art: OpenAI Codex `0.146.0` ships `new_context` + `get_context_remaining`
natively (`core/src/tools/handlers/new_context_window.rs`), and
[`fitchmultz/pi-posthorse`](https://github.com/fitchmultz/pi-posthorse) `0.4.4`
ports that model onto a fork of Pi. Relay is the same policy on loop, minus
Posthorse's weaknesses.

---

## 1. What it is

Instead of summarizing when context fills, start a **fresh window** and carry a
small, mechanically-built recovery record across the boundary. The transcript
stays intact in SQLite and is reachable with a `history` tool.

Why it beats summarizing:

- **Free.** No `generateText` call at the moment context is fullest.
- **Deterministic.** Cannot hallucinate a summary.
- **No drift.** Each window starts from real artifacts, not a summary of a
  summary of a summary.
- **No auth dependency.** Works when the summarizer model is unreachable.

What it costs: everything the model worked out but never wrote down. That is
the whole risk, and section 5 is how we blunt it.

## 2. Shape

**It cannot be a pure extension, and it does not need a fork.** Extension API
`0.3.0` has no seam for context usage, session appends, compaction
interception, or rewriting the model-bound message array. Posthorse solved
this by forking Pi; we own loop, so we add seams.

Five additive seams in `packages/core` plus one builtin extension
(`defaultEnabled: false`). With no extension loaded, core takes the identical
code path it takes today.

## 3. The insight that makes this small

loop's `compact` entry is **already a cut point plus a replacement block**.
`compactedContextEntries()` walks the branch, skips message entries before
`cutAt`, and unshifts a summary block in front of the survivors.

A rollover is that same mechanism with a different replacement block. So we do
**not** add a new entry type — we add one optional field to the entry we have,
and inherit branch-path correctness, `/tree`, `/fork`, `/resume`, the context
report and todo survival for free.

```ts
// packages/core/src/types.ts:320
| {
      type: "compact";
      summary: string;          // "" on a rollover
      cutAt: number;
+     handoff?: string;         // set on a rollover; replaces the summary block
+     rollover?: true;          // discriminator for UI and the context report
      ts: number; tokensBefore: number; tokensAfter: number;
      usage?: UsageBlock; model?: string;
  }
```

## 4. Verified anchors

| Fact | Where |
| --- | --- |
| Auto-compact fires once per turn, after system prompt + tools are assembled | `agent/turn.ts:564-596` |
| The user's message is appended **before** that check | `agent/turn.ts:491` |
| Nothing else appends between those two points | verified `turn.ts:488-530` |
| `cutAt` indexes message entries only | `agent/compact.ts` |
| Todo survival across a cut already exists | `agent/compact.ts` |
| Token estimate is chars/4 with a per-entry `WeakMap` cache | `agent/model-messages.ts:22` |
| Todos persist as a `custom` entry payload | `tools/todo.ts:220` |
| Model-bound-only injection already exists (`<hook-context>`) | `agent/turn.ts:632-644` |
| Builtins are a static array, all opt-in | `extensions/builtin/index.ts` |
| Cross-session agent memory: `MEMORY.md` + fact files, no tool | `agent/memory.ts` |

## 5. Core changes

### C1 — schema, **and the load adapter**

`types.ts:320` as above, **and** `sessions/session-adapter.ts:132`.

> **Blocker.** `Session.load()` runs every stored entry through
> `adaptSessionEntry`, which rebuilds the compact entry from an **explicit
> allowlist**. `handoff` is not in it, so it is silently dropped on reload.
> Rollover works live, then `/resume` reconstructs `{ summary: "", cutAt: N }`
> and the fresh window opens with *"compacted into the following summary:"*
> followed by nothing. Invisible to any test that does not restart.
>
> Worse, it can be **destructive**: a legacy session that trips
> `ensureTreeFields()` calls `replaceEntries()`, which deletes and re-inserts
> every row from the adapted objects — writing the omission to disk.
>
> That adapter already carries comments about `model`/`interrupted` ("Both must
> survive the reload") and about a `custom` payload that got buried and broke
> `isRecapPayload()`. This bug class has bitten there twice.

```ts
  ...(typeof obj.model === "string" ? { model: obj.model } : {}),
+ // The rollover recovery record IS the context after a boundary.
+ ...(typeof obj.handoff === "string" ? { handoff: obj.handoff } : {}),
+ ...(obj.rollover === true ? { rollover: true } : {}),
```

### C2 — prepend the handoff instead of the summary

One branch at the existing `out.unshift(summary)` site in `agent/compact.ts`.
The todo re-injection immediately above stays as written and becomes
load-bearing rather than a nicety.

```ts
const block = compact.handoff
  ? `${ROLLOVER_PREAMBLE}\n${compact.handoff}\n</handoff>`
  : `${COMPACTION_SUMMARY_PREFIX}${compact.summary}${COMPACTION_SUMMARY_SUFFIX}`;
out.unshift({ kind: "message", role: "user", content: block });
```

Also fix the copy in the surviving-todo block: it says "before the compaction
above", which is wrong after a rollover.

### C3 — count the handoff in the estimate

`agent/model-messages.ts:22` seeds `chars` from `compact.summary.length + 200`.
On a rollover the summary is empty, so the handoff would be invisible and the
next threshold check would misfire low.

```ts
- let chars = compact ? compact.summary.length + 200 : 0;
+ const preamble = compact?.handoff ? ROLLOVER_PREAMBLE.length + 20 : 200;
+ let chars = compact ? (compact.handoff ?? compact.summary).length + preamble : 0;
```

Derive it from the constant — a literal drifts the moment the wording changes.

### C4 — policy dispatch at the threshold

Replace the direct `runCompact` call at `turn.ts:577` (not the threshold logic,
not the `PreCompact` hook, not the abort handling):

```ts
export type ContextDecision =
  | { kind: "summarize" }                      // today's behavior
  | { kind: "rollover"; handoff: string; cutAt: number }
  | { kind: "none" };

export interface ContextPolicy {
  name: string;
  decide(ctx: {
    session: Session; modelId: string; cwd: string;
    usedTokens: number; contextWindow: number; overheadTokens: number;
    reason: "threshold" | "explicit";
  }): Promise<ContextDecision>;
}
```

Core registers none; `getContextPolicy() ?? { kind: "summarize" }`.

> **Blocker — rollover has no natural floor.** Summarization is self-limiting:
> `runCompact` returns early when `cut <= previousCut`. Rollover is not —
> `cutAt` advances every turn as the conversation grows, so the decision always
> looks valid. If the floor (handoff + system prompt + tool defs) sits above
> `contextWindow * threshold`, it rolls over **on every turn**, discarding each
> turn as it completes.

```ts
const MIN_USABLE_TOKENS = (MAX_HANDOFF_CHARS / 4) * 2;   // 10_000
const usable = (window * threshold) - overheadTokens;
if (usable < MIN_USABLE_TOKENS) {
  debugLog("rollover", `unsupported budget: ${usable} < ${MIN_USABLE_TOKENS}`);
  return { kind: "none" };    // let core's own threshold decide
}
```

Surface it in `get_context_remaining` and `/relay` too, or the user just sees
nothing happen.

> **Trap — the cut is not `messages.length`.** The user's message lands at
> `turn.ts:491`, the check runs at `:564`, and nothing appends in between. So
> `cutAt = messages.length` would cut away the request the user just typed.
> Use the index of the current user message (`messages.length - 1`).
> Posthorse hit this and documents it.

### C5 — extension API (bump to `0.4.0`)

```ts
interface TurnContext {
+ contextWindow: number;    // modelInfo.contextWindow, 0 when unknown
+ contextUsed?: number;     // OPTIONAL — see below
}

interface TurnMiddleware {
+ onAdditionalContext?(ctx: TurnContext): string | void | Promise<string | void>;
}

+ context: {
+   registerPolicy(p: ContextPolicy): void;
+   requestBoundary(handoff?: string): void;
+   read(): { used: number; window: number; rolloverAt: number } | undefined;
+ };
```

`onAdditionalContext` joins `promptHooks.additionalContext` at `turn.ts:632` —
that block already lands on the last user message, model-bound copy only, never
in the transcript, which is exactly what a reminder needs.

> **Blocker — `contextUsed` cannot live on `turnContext` at `:508`.** Accurate
> usage needs `overheadTokens`, which needs the final system prompt (built
> `:531`, transformed `:545` by middleware that *receives* `turnContext`).
> Circular. The comment at `:559` says the un-overheaded estimate undercounts by
> 10–20k with workspace context and skills loaded.
>
> So: optional, populated only after `:562`. `onSystemPrompt` sees `undefined`
> (fine — Relay's prompt block is static); only `onAdditionalContext` sees a
> real number. Document the asymmetry on the interface.

### C6 — the handoff builder (`agent/rollover.ts`, new)

Pure, ~180 lines, in core because it needs entry types and the todo payload
shape, and because it is the piece most worth unit-testing.

> **Scan from the last boundary, not the branch root.** Pre-cut entries are
> still on the branch. A builder that scans from the start re-collects every
> historical user message on the second rollover and again on the third, until
> it trips the budget and permanently falls back to summarizing — which reads
> as "rollover mysteriously stopped working."

```ts
let windowStart = 0;
let priorBoundary: Entry | undefined;
for (let i = branch.length - 1; i >= 0; i--) {
  if (branch[i].type === "compact") { windowStart = i + 1; priorBoundary = branch[i]; break; }
}
const current = branch.slice(windowStart);
```

Priority order, truncated from the bottom. P1–P3 are things **loop has and
Posthorse does not** — they close the "nothing is captured automatically" gap
that makes Posthorse weaker than Codex:

| | Source |
| --- | --- |
| P0 | Every user message in the window, verbatim. Owner intent and mid-session corrections are the highest-value bytes in the transcript. |
| P1 | The live todo list, from `latestTodos(branch)` — **not** `getSessionTodos()`, which is an in-memory cache seeded only by `cli/interactive/replay.ts` and therefore empty in print/serve mode. |
| P2 | Files touched, from `write`/`edit`/`apply_patch` calls. Deduped path list. |
| P3 | Commands run, from `bash` calls — command line only, output dropped. |
| P4 | The unconsumed tool batch: trailing assistant tool-call plus results no model has seen. Posthorse's sharpest idea. |
| P5 | The prior handoff, labelled *possibly stale*, never nested — a pointer to its entry id instead. |

Excluded on purpose: assistant prose, reasoning, consumed tool results.

Budget: half the fresh window after overhead stays free for actual work, capped
at `MAX_HANDOFF_CHARS = 20_000`. If it does not fit, return `{ kind: "summarize" }`
and let core's summarizer take the turn — that is Codex's own design
(`auto_compact_fallback_prompt`). **Log the fallback**; Posthorse's equivalent
path is silent and that is the one thing not to copy.

### C7 — every consumer, across four surfaces

15 files. The structural point is that **`cutAt` filtering is reimplemented per
surface** rather than shared. Land one helper — `latestBoundary(branch)`,
`isCutBy(boundary, messageIndex)`, `boundaryBodyText(entry)` — and route all
four through it.

`core`: `session-adapter.ts:132` (C1, correctness), `branch-summary.ts:89`,
`export-markdown.ts:63`, `telegram/render.ts:404`, `telegram/bridge.ts`,
`trace/model.ts:182`, `trace/client.ts:125`, `context-report.ts`, `session.ts`
(`lastCompactCutAt` needs no change — it reads `cutAt`, which a rollover sets
normally).

`cli`: `interactive/replay.ts` (see section 7 — already changed),
`interactive/ui/tree/entry-display.ts:152`.

`web` / `apps/web`: `web/src/ui/transcript.ts:327`,
`apps/web/loop/handlers/thread.ts`, `apps/web/.../SessionTreeDialog.tsx`.

`compact-start`/`compact-end` gain `mode: "summary" | "rollover"`. A rollover
row reads `Fresh context · 128k → 4.2k · no summary` and reports **no cost**.

## 6. The extension

`packages/core/src/extensions/builtin/relay/` — seventh builtin,
`defaultEnabled: false`. Named for the relay station where the post-horse was
swapped.

**Tools**

- `new_context({ handoff? })` — calls `requestBoundary`; commits at end of turn.
- `get_context_remaining()` — tokens to the rollover line and the hard limit,
  both marked estimates (loop's accounting is chars/4).
- `history({ op, query, id, limit, offset })` — search/read over
  `session.getBranch()`. Pre-cut entries are still on the branch and in memory,
  so v1 is a linear scan with no new storage. Port Posthorse's priority ranking
  (original content outranks handoffs, summaries and previous `history` calls).

> **Port `requirePage` too, not just the ranking.** Without it, one
> `history read` on a large tool result pours the old window straight back into
> the new one and re-trips the threshold — the mechanism defeating itself.
> Preserve the offset in the error so the model gets a two-step recovery:
> *"Too little context remains. Call new_context, then retry with offset N."*

**Do not add a `notes` tool.** `agent/memory.ts` makes an explicit commitment:
*"There is no dedicated tool: the agent saves with its normal write tools, so
every memory write is visible in the transcript."* Point the prompt block at a
session scratchpad (`.loop/notes/<session>.md`, ordinary `write` tool) instead,
and carry its path in the handoff.

**Prompt block** — static, via `onSystemPrompt`, so the cache prefix does not
churn. **Reminder** — via `onAdditionalContext`, fires once per window in the
last 10% of usable context capped at 32k, fingerprinted on
`(cutAt, contextWindow, threshold)` so a model switch invalidates it.

**Settings** — `extensionSettings.relay = { mode, reminder, carryCommands, maxHandoffChars }`,
`/relay` toggles and prints the budget.

## 7. Ordering

| | |
| --- | --- |
| `:491` | user message appended |
| `:508` | tools assembled, `turnContext` built |
| `:531` | system prompt built; `applySystemPrompt` (Relay's block) |
| `:562` | `estimateOverheadTokens` over the real prompt + tools |
| **`:565`** | **policy dispatch replaces the direct `runCompact` call (C4)** |
| `:605` | `buildMessages()` — now sees the boundary |
| **`:632`** | **`onAdditionalContext`; the reminder lands here (C5)** |
| `:804` | `streamText` opens |
| **`:1176`** | **commit a pending `requestBoundary` — after ALL turn appends** |

> **Two ordering traps.** `await persistChain` (~`:1090`) is *not* end of turn —
> the interrupted assistant entry lands at `:1143` and the stream-edge entry at
> `:1162`. Commit before those and `cutAt` is computed against an incomplete
> list. And **never commit on an abort**: the user pressed Ctrl+C; guard on
> `abortSignal?.aborted` and drop the request.

Explicit `new_context` commits at end of turn rather than mid-batch (as Codex
and Posthorse do) because mid-turn means breaking the open `streamText` and
reopening over a rebuilt array. The machinery exists — the resume path at
`:1040-1085` already calls `attemptMessages = buildMessages()` — but it
entangles rollover with retry accounting and `maxSteps`. That is phase 4.

## 8. Phases

1. **Core, behind a flag.** C1–C4, C6. No extension. Prove a session rolls
   over, the next turn starts from the handoff, and `/tree` `/fork` `/resume`
   all reconstruct across a boundary. Ships nothing user-visible.
2. **Seams + extension.** C5, C7, the Relay builtin, API `0.4.0`. Ships the
   feature, opt-in, off by default.
3. **Recall.** `history` with ranking and paging, plus the reminder. Split
   deliberately — the boundary is useful without recall, and recall needs
   tuning against real sessions.
4. **Mid-turn rollover.** Break/reopen the stream. The only phase that beats
   what loop can do today: a single oversized turn is unsurvivable under
   summarization too.

## 9. Tests

`packages/core/test/compact.test.ts` exists; extend it and add
`test/rollover.test.ts`.

- **Round-trip through the store.** Roll over, `Session.load()` fresh, assert
  the handoff survives. The only test that catches C1 — every in-memory test
  passes while resume is broken.
- **No rollover loop.** Below `MIN_USABLE_TOKENS`, three turns must produce
  exactly one compact entry (or zero), never one per turn.
- **The cutAt trap.** The current user message must survive its own rollover.
- **Handoff does not grow across boundaries.** Three rollovers; the third
  handoff is not materially larger than the first.
- **Abort does not commit.** `new_context`, then abort — no compact entry.
- **History cannot blow the window.** Near-full window must throw the
  offset-preserving error, not return a page.
- **Todo survival**, **unconsumed tool batch**, **branch correctness** after
  `/tree` back across a boundary, **no ledger row**, **estimate moves** (C3).
- **Clean install unchanged.** No extension loaded → threshold path identical
  to today. The regression that matters most.

## 10. Open questions

- **Subagents.** Entries ride the cut by message index, and `messageIndex` only
  advances on message entries — so a subagent finishing immediately before the
  current user message has `messageIndex === cutAt`, and the test is `<`, so it
  **survives**. One stale, potentially enormous report leaks into a window built
  to be small. Decide: exclude it, or admit it deliberately as a P2.5 carrying
  agent name + result head. Keeping it *by accident* is the wrong outcome.
- **Carried state decays.** P2/P3 are derived from this window's tool calls, so
  files touched in window 1 never reach window 3. Fix by appending the running
  list to `.loop/notes/<session>.md` at each boundary so it accumulates on disk
  instead of decaying through P5.
- **Reminder fingerprint does not survive a restart.** In extension memory, so a
  `/resume` can re-fire it. Posthorse persists reminders as transcript entries —
  idempotent, at the cost of noise. Pick one.
- **`PreCompact` now fires for something that writes no summary.** Pass
  `trigger: "rollover"` so hooks can branch.
- **Two policies at once.** Posthorse warns that Pi keeps the last non-cancel
  result, so load order silently decides. `registerPolicy` should warn loudly
  and keep the **first**.
- **Adverse selection.** Long debugging sessions are both likeliest to hit a
  boundary and worst served by one, because their state is a mental model, not
  a file. P1–P3 blunt it; it stays the weakest case. Watch it on real sessions
  before considering `defaultEnabled`.
