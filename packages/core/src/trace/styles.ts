/** Stylesheet for the trace page — see html.ts for the design notes. */
export const TRACE_CSS = /* css */ `:root {
  --paper: #F3F5F8;
  --paper-2: #FFFFFF;
  --grid: rgba(27, 36, 48, .08);
  --grid-strong: rgba(27, 36, 48, .18);
  --ink: #1B2430;
  --ink-2: #4A5563;
  --muted: #6E7987;
  --rule: rgba(27, 36, 48, .14);
  --model: #2F5BEA;
  --model-wait: rgba(47, 91, 234, .32);
  --tool: #E09A1E;
  --tool-soft: rgba(224, 154, 30, .16);
  --reason: #7A5AF5;
  --derived: #9AA3AE;
  --wait: #B8C0CA;
  --error: #D6453D;
  --user: #1B2430;
  --focus: #2F5BEA;
  --display: "Avenir Next Condensed", "Helvetica Neue", "Inter", system-ui, sans-serif;
  --mono: "JetBrains Mono", "SF Mono", "Fira Code", Menlo, Consolas, monospace;
  --prose: "Iowan Old Style", "Charter", "Georgia", serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #14181E;
    --paper-2: #1B2027;
    --grid: rgba(255, 255, 255, .06);
    --grid-strong: rgba(255, 255, 255, .16);
    --ink: #E6EAF0;
    --ink-2: #B8C0CA;
    --muted: #8B95A3;
    --rule: rgba(255, 255, 255, .12);
    --model: #6C8DFF;
    --model-wait: rgba(108, 141, 255, .35);
    --tool: #F0B54A;
    --tool-soft: rgba(240, 181, 74, .16);
    --reason: #A18BFF;
    --derived: #5B6572;
    --wait: #3E4752;
    --error: #FF6B61;
    --user: #E6EAF0;
    --focus: #6C8DFF;
  }
}
* { box-sizing: border-box; }
html { background: var(--paper); color: var(--ink); }
body {
  margin: 0;
  font: 14px/1.45 var(--mono);
  background:
    linear-gradient(var(--grid) 1px, transparent 1px) 0 0 / 100% 8px,
    linear-gradient(90deg, var(--grid) 1px, transparent 1px) 0 0 / 8px 100%,
    var(--paper);
  background-attachment: fixed;
}
a { color: inherit; }
.mono { font-family: var(--mono); }
.sep { color: var(--muted); margin: 0 .35em; }

.mast { max-width: 1180px; margin: 0 auto; padding: 44px 28px 20px; }
.eyebrow { margin: 0 0 10px; font: 12px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
h1 { margin: 0; font: 600 44px/1.02 var(--display); letter-spacing: -.01em; color: var(--ink); word-break: break-word; }
.meta { margin: 10px 0 0; color: var(--muted); font-size: 12.5px; word-break: break-all; }
.headline { margin: 26px 0 0; font: 400 26px/1.25 var(--display); color: var(--ink); max-width: 900px; }
.coverage { margin-top: 18px; max-width: 900px; }
.coverage-bar { display: flex; height: 6px; border-radius: 3px; overflow: hidden; background: var(--wait); }
.cov { display: block; height: 100%; }
.cov.recorded { background: var(--model); }
.cov.derived { background: repeating-linear-gradient(135deg, var(--derived) 0 3px, transparent 3px 6px); }
.cov.none { background: transparent; }
.coverage-line { margin: 8px 0 0; font-size: 12px; color: var(--muted); }

main { max-width: 1180px; margin: 0 auto; padding: 8px 28px 60px; }
section { margin-top: 44px; }
h2 { margin: 0 0 14px; font: 12px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }

/* legend */
.legend { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 0 0 14px; font-size: 12px; color: var(--ink-2); }
.legend i { display: inline-block; width: 18px; height: 8px; border-radius: 2px; vertical-align: -1px; margin-right: 6px; }
.legend .l-model i { background: var(--model); }
.legend .l-wait i { background: var(--model-wait); }
.legend .l-tool i { background: var(--tool); }
.legend .l-derived i { background: repeating-linear-gradient(135deg, var(--derived) 0 3px, transparent 3px 6px); }
.legend .l-retry i { background: repeating-linear-gradient(135deg, var(--wait) 0 2px, transparent 2px 4px); }
.legend .l-error i { background: var(--error); }

/* overview strip: one row per turn, bar length ∝ duration */
.strip { border-top: 1px solid var(--rule); }
.strip-row {
  display: grid; grid-template-columns: 34px minmax(160px, 30%) 1fr auto; gap: 0 14px; align-items: center;
  padding: 7px 0; border-bottom: 1px solid var(--rule); cursor: pointer; color: inherit; text-decoration: none;
}
.strip-row:hover, .strip-row:focus-visible { background: var(--paper-2); outline: none; }
.strip-row:focus-visible .strip-n { color: var(--focus); }
.strip-n { font-size: 12px; color: var(--muted); text-align: right; }
.strip-q { font-size: 12.5px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.strip-bar { position: relative; height: 10px; }
.strip-bar .seg { position: absolute; top: 0; height: 100%; border-radius: 1px; }
.seg.model { background: var(--model); }
.seg.tool { background: var(--tool); }
.seg.derived { background: repeating-linear-gradient(135deg, var(--derived) 0 3px, transparent 3px 6px); }
.strip-bar .none { position: absolute; top: -3px; font-size: 11px; color: var(--muted); }
.strip-r { font-size: 12px; color: var(--ink-2); white-space: nowrap; text-align: right; }
.strip-r b { font-weight: 500; color: var(--ink); }

/* turn */
.turn { border-top: 2px solid var(--ink); padding-top: 14px; }
.turn-head { display: grid; grid-template-columns: 1fr auto; gap: 8px 24px; align-items: start; }
.turn-n { font: 12px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--muted); margin: 0 0 8px; }
.turn-q { margin: 0; font: 400 19px/1.35 var(--prose); color: var(--user); white-space: pre-wrap; word-break: break-word; max-width: 820px; }
.turn-q.empty { color: var(--muted); font-style: italic; }
.turn-stats { font-size: 12px; color: var(--ink-2); text-align: right; line-height: 1.7; white-space: nowrap; }
.turn-stats b { font-weight: 500; color: var(--ink); }
.turn-events { margin: 10px 0 0; padding: 0; list-style: none; font-size: 12px; color: var(--muted); }
.turn-events li::before { content: "▸ "; }

/* timeline */
.tl { margin-top: 18px; border: 1px solid var(--rule); background: var(--paper-2); border-radius: 4px; overflow: hidden; }
.tl-ruler { position: relative; height: 22px; border-bottom: 1px solid var(--rule); margin-left: 132px; }
.tl-tick { position: absolute; top: 0; height: 100%; border-left: 1px solid var(--grid-strong); padding-left: 4px; font-size: 10.5px; color: var(--muted); line-height: 22px; white-space: nowrap; }
.tl-lane { position: relative; display: grid; grid-template-columns: 132px 1fr; min-height: 30px; border-bottom: 1px solid var(--grid); }
.tl-lane:last-child { border-bottom: 0; }
.tl-lane:hover { background: color-mix(in srgb, var(--model) 5%, transparent); }
.tl-label { padding: 6px 10px; font-size: 11.5px; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-right: 1px solid var(--rule); cursor: pointer; }
.tl-label small { display: block; color: var(--muted); font-size: 10.5px; }
.tl-track { position: relative; min-height: 30px; background-image: linear-gradient(90deg, var(--grid-strong) 1px, transparent 1px); }
.bar { position: absolute; border-radius: 2px; min-width: 2px; cursor: pointer; }
.bar.model { top: 7px; height: 8px; background: var(--model); }
.bar.model-wait { top: 7px; height: 8px; background: var(--model-wait); }
.bar.tool { height: 6px; background: var(--tool); }
.bar.tool.err { background: var(--error); }
.bar.tool.open { background: repeating-linear-gradient(90deg, var(--tool) 0 4px, transparent 4px 7px); }
.bar.derived { top: 9px; height: 10px; background: repeating-linear-gradient(135deg, var(--derived) 0 3px, transparent 3px 6px); }
.bar.retry { top: 9px; height: 6px; background: repeating-linear-gradient(135deg, var(--wait) 0 2px, transparent 2px 4px); }
.tick-ttft { position: absolute; top: 4px; width: 1px; height: 14px; background: var(--ink); opacity: .55; }
.tl-none { position: absolute; left: 8px; top: 7px; font-size: 11px; color: var(--muted); font-style: italic; }
.tl-interrupted { font-size: 10.5px; font-style: normal; color: var(--error); }

/* steps */
.steps { margin-top: 18px; display: grid; gap: 12px; }
.step { border: 1px solid var(--rule); border-left: 3px solid var(--model); background: var(--paper-2); border-radius: 4px; padding: 12px 16px 14px; }
.step.derived-step { border-left-color: var(--derived); }
.step.none-step { border-left-color: transparent; }
.step.hl { box-shadow: 0 0 0 2px var(--focus); }
.step-head { display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: baseline; font-size: 12px; color: var(--ink-2); }
.step-head .n { font: 12px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--ink); }
.step-head b { font-weight: 500; color: var(--ink); }
.step-head .warn { color: var(--error); }
.step-head .quiet { color: var(--muted); font-style: italic; }
.step-usage { margin-left: auto; color: var(--muted); }
.step-usage b { color: var(--ink-2); }
details { margin-top: 10px; }
summary { cursor: pointer; font-size: 12.5px; color: var(--ink-2); list-style: none; }
summary::-webkit-details-marker { display: none; }
summary::before { content: "▸ "; color: var(--muted); }
details[open] > summary::before { content: "▾ "; }
summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.reason { border-left: 2px solid var(--reason); padding-left: 12px; margin: 8px 0 0; font: 13.5px/1.55 var(--prose); color: var(--ink-2); white-space: pre-wrap; word-break: break-word; }
.text { margin: 12px 0 0; font: 15.5px/1.55 var(--prose); color: var(--ink); white-space: pre-wrap; word-break: break-word; max-width: 820px; }
.tools { margin: 12px 0 0; padding: 0; list-style: none; display: grid; gap: 6px; }
.tool { border: 1px solid var(--rule); border-radius: 3px; background: var(--paper); }
.tool > summary { display: grid; grid-template-columns: 8px minmax(90px, auto) 1fr auto; gap: 10px; align-items: baseline; padding: 7px 10px; }
.tool > summary::before { content: ""; width: 8px; height: 8px; border-radius: 2px; background: var(--tool); align-self: center; }
.tool.err > summary::before { background: var(--error); }
.tool.sub > summary::before { background: var(--reason); }
.tool .name { color: var(--ink); font-weight: 500; }
.tool .input { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px; }
.tool .dur { color: var(--ink-2); font-size: 12px; white-space: nowrap; }
.tool .dur.err { color: var(--error); }
.tool pre { margin: 0; padding: 10px 12px; border-top: 1px solid var(--rule); font: 12px/1.5 var(--mono); color: var(--ink-2); white-space: pre-wrap; word-break: break-word; max-height: 420px; overflow: auto; }
.tool .more { padding: 6px 12px; border-top: 1px solid var(--rule); font-size: 11.5px; color: var(--muted); }
.tool .sub-meta { padding: 8px 12px 0; font-size: 12px; color: var(--ink-2); }
.tool .sub-prompt { margin: 6px 12px 0; padding-left: 10px; border-left: 2px solid var(--reason); font: 13px/1.5 var(--prose); color: var(--ink-2); white-space: pre-wrap; }

.empty { color: var(--muted); font-style: italic; }
.foot { max-width: 1180px; margin: 0 auto; padding: 0 28px 40px; font-size: 11.5px; color: var(--muted); }

@media (max-width: 760px) {
  .mast, main, .foot { padding-left: 16px; padding-right: 16px; }
  h1 { font-size: 34px; }
  .headline { font-size: 21px; }
  .strip-row { grid-template-columns: 28px 1fr auto; }
  .strip-bar { grid-column: 1 / -1; }
  .turn-head { grid-template-columns: 1fr; }
  .turn-stats { text-align: left; }
  .tl-ruler { margin-left: 92px; }
  .tl-lane { grid-template-columns: 92px 1fr; }
}
@media (prefers-reduced-motion: no-preference) {
  .step { transition: box-shadow .25s ease; }
}
@media print {
  body { background: #fff; }
  .tl-lane:hover { background: none; }
  details { break-inside: avoid; }
}

`;
