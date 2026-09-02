/**
 * /trace — render a TraceModel as one self-contained HTML file.
 *
 * No network, no build: styles inline (styles.ts), the model embedded as
 * JSON, a small vanilla script (client.ts) draws it. The masthead is also
 * written here, server-side, so the page says what it is before (or
 * without) script.
 *
 * Visual idea: a timing diagram. The grid IS the time axis, so it is drawn
 * only inside the tracks, on the ruler's own ticks, and the page around them
 * stays flat — a page-wide grid textures everything and measures nothing.
 * Every bar is a measurement, and a measurement that was not taken is written
 * out as such rather than guessed at.
 */
import { TRACE_CLIENT_JS } from "./client";
import { escapeHtml as esc, fmtMs, fmtUsd, plural } from "./format";
import type { TraceCoverage, TraceModel } from "./model";
import { TRACE_CSS } from "./styles";

/** The one-sentence headline the masthead is built around. */
export function traceHeadline(model: TraceModel): string {
    const t = model.totals;
    const head = `${plural(t.turns, "turn")}, ${plural(t.steps, "step")}, ${plural(t.tools, "tool call")}`;
    const tail = `${fmtMs(t.wallMs)} of wall clock, ${fmtUsd(t.usage.usd)}${t.usage.estimated ? " (part estimated)" : ""}.`;
    return `${head} — ${tail}`;
}

/** How much of the session the bars can be trusted for, in words. */
export function coverageLine(c: TraceCoverage): string {
    const steps = c.recorded + c.derived + c.none;
    if (steps === 0) return "no steps yet";
    if (c.recorded === steps) return "timing recorded for every step";
    return `timing recorded for ${c.recorded} of ${steps} steps · ${c.derived} wall-time only · ${c.none} not recorded`;
}

/** The model as a script-element payload. A literal `<` would end the
 * element early, so it is escaped; JSON.parse reads it back unchanged. */
function embedJson(model: TraceModel): string {
    return JSON.stringify(model).replace(/</g, "\\u003c");
}

function masthead(model: TraceModel, title: string): string {
    const s = model.session;
    const c = model.coverage;
    const coverage = coverageLine(c);
    return `<header class="mast">
  <p class="eyebrow">loop trace <span class="sep">·</span> <span class="mono">${esc(s.id)}</span></p>
  <h1>${esc(title)}</h1>
  <p class="meta mono">${esc(s.model)} <span class="sep">·</span> ${esc(s.cwd)} <span class="sep">·</span> started ${esc(new Date(s.createdAt).toLocaleString())}</p>
  <p class="headline">${esc(traceHeadline(model))}</p>
  <div class="coverage" role="img" aria-label="${esc(coverage)}">
    <div class="coverage-bar"><span class="cov recorded" style="flex-grow:${c.recorded}"></span><span class="cov derived" style="flex-grow:${c.derived}"></span><span class="cov none" style="flex-grow:${c.none}"></span></div>
    <p class="coverage-line mono">${esc(coverage)}</p>
  </div>
</header>`;
}

export function renderTraceHtml(model: TraceModel): string {
    const title = model.session.name ?? `session ${model.session.id}`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>trace · ${esc(title)}</title>
<style>${TRACE_CSS}</style>
</head>
<body>
${masthead(model, title)}
<main id="app"><noscript><p class="mono">This page draws the trace with script. The data is in the page; enable script to see it.</p></noscript></main>
<footer class="foot mono">generated ${esc(new Date(model.generatedAt).toLocaleString())} <span class="sep">·</span> timings are observed by the loop process, good for a trace, not a latency benchmark</footer>
<script id="trace" type="application/json">${embedJson(model)}</script>
<script>${TRACE_CLIENT_JS}</script>
</body>
</html>
`;
}
