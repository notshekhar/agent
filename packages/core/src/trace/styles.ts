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
body { margin: 0; font: 14px/1.45 var(--mono); background: var(--paper); }
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
.legend { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 0; font-size: 11px; color: var(--muted); }
.legend i { display: inline-block; width: 18px; height: 8px; border-radius: 2px; vertical-align: -1px; margin-right: 6px; }
.legend .l-model i { background: var(--model); }
.legend .l-wait i { background: var(--model-wait); }
.legend .l-tool i { background: var(--tool); }
.legend .l-derived i { background: repeating-linear-gradient(135deg, var(--derived) 0 3px, transparent 3px 6px); }
.legend .l-retry i { background: repeating-linear-gradient(135deg, var(--wait) 0 2px, transparent 2px 4px); }
.legend .l-error i { background: var(--error); }

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
  .turn-head { grid-template-columns: 1fr; }
  .turn-stats { text-align: left; }
}
@media (prefers-reduced-motion: no-preference) {
  .step { transition: box-shadow .25s ease; }
}
@media print {
  body { background: #fff; }
  details { break-inside: avoid; }
}

/* ---------------------------------------------------------------- chrome */
.sticky {
  position: sticky; top: 0; z-index: 40;
  backdrop-filter: blur(8px);
  background: color-mix(in srgb, var(--paper) 88%, transparent);
  border-bottom: 1px solid var(--rule);
  margin: 0 -28px 0; padding: 8px 28px;
}
.tbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.tbar .spacer { flex: 1 1 auto; }
.search {
  flex: 1 1 220px; max-width: 380px; min-width: 160px;
  font: 12.5px/1 var(--mono); color: var(--ink);
  background: var(--paper-2); border: 1px solid var(--rule); border-radius: 3px; padding: 7px 9px;
}
.search:focus { outline: none; border-color: var(--focus); box-shadow: 0 0 0 2px color-mix(in srgb, var(--focus) 22%, transparent); }
.sel, .btn {
  font: 12px/1 var(--mono); color: var(--ink-2); background: var(--paper-2);
  border: 1px solid var(--rule); border-radius: 3px; padding: 7px 9px; cursor: pointer;
}
.btn:hover, .sel:hover { color: var(--ink); border-color: var(--grid-strong); }
.btn.on { color: var(--paper-2); background: var(--error); border-color: var(--error); }
.btn.ghost { background: transparent; }
.count { font-size: 11.5px; color: var(--muted); white-space: nowrap; }

/* -------------------------------------------------------------- overview */
.ov { margin-top: 24px; }
.ov-head { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 10px; }
.ov-head h2 { margin: 0; }
.seg { display: inline-flex; border: 1px solid var(--rule); border-radius: 3px; overflow: hidden; background: var(--paper-2); }
.seg-b {
  font: 11.5px/1 var(--mono); color: var(--muted); background: transparent;
  border: 0; border-right: 1px solid var(--rule); padding: 7px 10px; cursor: pointer;
}
.seg-b:last-child { border-right: 0; }
.seg-b:hover { color: var(--ink); }
.seg-b.on { color: var(--paper-2); background: var(--ink); }
.ov-badge { display: flex; gap: 8px; align-items: center; margin-left: auto; }
.badge {
  font-size: 11.5px; color: var(--paper-2); background: var(--focus);
  padding: 4px 8px; border-radius: 3px; white-space: nowrap;
}
.ov-plot { display: grid; grid-template-columns: 84px 1fr; border: 1px solid var(--rule); background: var(--paper-2); border-radius: 4px 4px 0 0; }
.ov-lanes { position: relative; border-right: 1px solid var(--rule); }
.ov-lane-label { position: absolute; left: 0; font-size: 10.5px; color: var(--muted); padding: 0 8px; line-height: 1; }
.ov-lane-label:nth-child(1) { top: 27px; }
.ov-lane-label:nth-child(2) { top: 41px; }
.ov-lane-label:nth-child(3) { top: 51px; }
.ov-track-wrap { min-width: 0; }
.ov-ruler { position: relative; height: 22px; border-bottom: 1px solid var(--rule); overflow: hidden; }
.ov-tick {
  position: absolute; top: 0; height: 100%; border-left: 1px solid var(--grid-strong);
  padding-left: 4px; font-size: 10.5px; color: var(--muted); line-height: 22px; white-space: nowrap;
}
.ov-track {
  position: relative; overflow: hidden; min-height: 72px; touch-action: none; cursor: crosshair;
  background-image: linear-gradient(90deg, var(--grid) 1px, transparent 1px);
  background-repeat: repeat-x;
}
.ov-track.panning { cursor: grabbing; }
.ov-domain { position: absolute; top: 0; bottom: 0; left: 0; width: 100%; }
.ov-b { position: absolute; border-radius: 2px; min-width: 2px; cursor: pointer; }
.ov-b.dim { opacity: .18; }
.ov-b.on { outline: 2px solid var(--ink); outline-offset: 1px; z-index: 6; }
.ov-b.user { top: 4px; width: 2px; height: 10px; background: var(--user); border-radius: 0; }
.ov-b.ev { top: 4px; width: 6px; height: 6px; margin-left: -2px; background: var(--reason); transform: rotate(45deg); border-radius: 0; }
.ov-b.ev.compact { background: var(--tool); }
.ov-b.model { top: 18px; height: 9px; background: var(--model); }
.ov-b.model.derived { background: repeating-linear-gradient(135deg, var(--derived) 0 3px, transparent 3px 6px); }
.ov-b.model.cut { box-shadow: inset -2px 0 0 var(--error); }
.ov-b.tool { height: 6px; background: var(--tool); }
.ov-b.tool.err { background: var(--error); }
.ov-b.tool.derived { background: repeating-linear-gradient(135deg, var(--derived) 0 3px, transparent 3px 6px); }
.ov-b.tool.open { background: repeating-linear-gradient(90deg, var(--tool) 0 4px, transparent 4px 7px); }
.ov-ttft { position: absolute; top: -2px; width: 1px; height: calc(100% + 4px); background: var(--paper-2); opacity: .9; }
.ov-idle { position: absolute; top: 16px; height: 13px; background: repeating-linear-gradient(90deg, var(--wait) 0 2px, transparent 2px 6px); opacity: .5; }
.ov-seam { position: absolute; top: 2px; bottom: 2px; width: 3px; margin-left: -1px; background: repeating-linear-gradient(180deg, var(--wait) 0 3px, transparent 3px 6px); }
.ov-turnline { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--grid-strong); cursor: pointer; }
.ov-turnline i { position: absolute; top: 0; left: 2px; font: 9.5px/1 var(--mono); font-style: normal; color: var(--muted); }
.ov-brush {
  position: absolute; top: 0; bottom: 0; pointer-events: none;
  background: color-mix(in srgb, var(--focus) 14%, transparent);
  border-left: 1px solid var(--focus); border-right: 1px solid var(--focus);
}
.ov-cursor { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--ink); opacity: .35; pointer-events: none; }
.ov-cursor::after {
  content: attr(data-t); position: absolute; top: -20px; left: 3px;
  font: 10px/1 var(--mono); color: var(--muted); white-space: nowrap;
}
.ov-map { position: relative; height: 30px; border: 1px solid var(--rule); border-top: 0; border-radius: 0 0 4px 4px; background: var(--paper-2); cursor: pointer; overflow: hidden; }
.ov-map-canvas { display: block; opacity: .55; }
.ov-map-window { position: absolute; top: 0; bottom: 0; background: color-mix(in srgb, var(--focus) 16%, transparent); border: 1px solid var(--focus); }
.ov-tip {
  position: absolute; z-index: 60; max-width: 380px; pointer-events: none;
  background: var(--ink); color: var(--paper); border-radius: 4px; padding: 8px 10px;
  font: 11.5px/1.5 var(--mono); box-shadow: 0 8px 24px rgba(0,0,0,.22);
}
.ov-tip b { display: block; font-weight: 600; margin-bottom: 2px; }
.ov-tip span { display: block; opacity: .82; }
.ov-tip .warn { color: #FF9A92; opacity: 1; }
.ov-tip .dim { opacity: .55; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ov-hint { margin: 8px 0 0; font-size: 11px; color: var(--muted); }

/* ---------------------------------------------------------------- stats */
.stats h3 { margin: 0 0 8px; font: 11.5px/1 var(--mono); letter-spacing: .12em; text-transform: uppercase; color: var(--muted); }
.bd-bar { display: flex; height: 14px; border-radius: 3px; overflow: hidden; background: var(--wait); }
.bd-seg.bd-wait { background: var(--model-wait); }
.bd-seg.bd-stream { background: var(--model); }
.bd-seg.bd-tools { background: var(--tool); }
.bd-seg.bd-idle { background: repeating-linear-gradient(135deg, var(--wait) 0 4px, transparent 4px 8px); }
.bd-key { display: flex; flex-wrap: wrap; gap: 6px 22px; margin: 10px 0 0; padding: 0; list-style: none; font-size: 11.5px; color: var(--ink-2); }
.bd-key li { white-space: nowrap; }
.bd-key li::before { content: ""; display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
.bd-key li.bd-wait::before { background: var(--model-wait); }
.bd-key li.bd-stream::before { background: var(--model); }
.bd-key li.bd-tools::before { background: var(--tool); }
.bd-key li.bd-idle::before { background: var(--wait); }
.bd-key b { font-weight: 500; color: var(--ink); }
.stats-grid { display: grid; grid-template-columns: 1.35fr 1fr; gap: 32px; margin-top: 26px; align-items: start; }
.agg { width: 100%; border-collapse: collapse; font-size: 12px; }
.agg th { font-weight: 400; color: var(--muted); text-align: right; padding: 0 0 6px; border-bottom: 1px solid var(--rule); font-size: 11px; }
.agg th.l, .agg td.l { text-align: left; }
.agg td { text-align: right; padding: 6px 0 6px 10px; border-bottom: 1px solid var(--grid); color: var(--ink-2); white-space: nowrap; }
.agg-row { cursor: pointer; }
.agg-row:hover td { background: color-mix(in srgb, var(--model) 6%, transparent); }
.agg-row.on td { background: color-mix(in srgb, var(--focus) 12%, transparent); color: var(--ink); }
.agg td.l { padding-left: 0; width: 40%; }
.agg-name { color: var(--ink); }
.agg-track { display: block; height: 3px; margin-top: 4px; background: var(--grid); border-radius: 2px; }
.agg-track i { display: block; height: 100%; background: var(--tool); border-radius: 2px; }
.agg td.err { color: var(--error); }
.slow { margin: 0; padding: 0; list-style: none; }
.slow li { border-bottom: 1px solid var(--grid); }
.slow-a { display: grid; grid-template-columns: 68px 88px 1fr; gap: 10px; align-items: baseline; padding: 6px 0; text-decoration: none; font-size: 12px; }
.slow-a:hover { background: color-mix(in srgb, var(--model) 6%, transparent); }
.slow-a b { font-weight: 500; color: var(--ink); text-align: right; }
.slow-k { color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.slow-s { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cost-wrap { border-bottom: 1px solid var(--rule); }
.cost { display: flex; align-items: flex-end; gap: 2px; height: 56px; }
.cost-b { flex: 1 1 0; min-width: 2px; background: var(--model); opacity: .75; border-radius: 1px 1px 0 0; }
.cost-b:hover { opacity: 1; background: var(--focus); }
.cost-foot { margin: 6px 0 0; font-size: 11px; color: var(--muted); }

/* -------------------------------------------------------------- per turn */
.ts { margin-top: 16px; border: 1px solid var(--rule); background: var(--paper-2); border-radius: 4px; overflow: hidden; }
.ts-ruler { position: relative; height: 20px; border-bottom: 1px solid var(--rule); }
.ts-track {
  position: relative;
  background-image: linear-gradient(90deg, var(--grid) 1px, transparent 1px);
  background-repeat: repeat-x;
}
.ts-b { position: absolute; border-radius: 2px; min-width: 2px; cursor: pointer; }
.ts-b.model { height: 9px; background: var(--model); }
.ts-b.model.derived { background: repeating-linear-gradient(135deg, var(--derived) 0 3px, transparent 3px 6px); }
.ts-b.tool { height: 6px; background: var(--tool); }
.ts-b.tool.err { background: var(--error); }
.ts-b.tool.derived { background: repeating-linear-gradient(135deg, var(--derived) 0 3px, transparent 3px 6px); }
.ts-b.tool.open { background: repeating-linear-gradient(90deg, var(--tool) 0 4px, transparent 4px 7px); }
.ts-b.ev { width: 6px; height: 6px; background: var(--reason); transform: rotate(45deg); }

/* ---------------------------------------------------------------- state */
.hidden { display: none !important; }
.turn.hl > .turn-head { box-shadow: -6px 0 0 var(--focus); }
.tool.hl, details.hl { box-shadow: 0 0 0 2px var(--focus); }
mark { background: color-mix(in srgb, var(--tool) 45%, transparent); color: inherit; border-radius: 2px; }
.jump { color: var(--muted); text-decoration: none; border-bottom: 1px dotted var(--rule); }
.jump:hover { color: var(--focus); }

/* ----------------------------------------------------------------- help */
.help { position: fixed; inset: 0; z-index: 90; background: rgba(8, 11, 15, .55); display: grid; place-items: center; }
.help-card { background: var(--paper-2); border: 1px solid var(--rule); border-radius: 6px; padding: 22px 26px; max-width: 460px; box-shadow: 0 20px 60px rgba(0,0,0,.35); }
.help-card h3 { margin: 0 0 14px; font: 12px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
.help-card dl { display: grid; grid-template-columns: 92px 1fr; gap: 6px 14px; margin: 0; font-size: 12.5px; }
.help-card dt { color: var(--ink); }
.help-card dd { margin: 0; color: var(--ink-2); }
.help-foot { margin: 16px 0 0; font-size: 11.5px; color: var(--muted); }

@media (max-width: 860px) {
  .stats-grid { grid-template-columns: 1fr; gap: 24px; }
  .ov-plot { grid-template-columns: 60px 1fr; }
}
@media print {
  .sticky, .ov-hint, .help { display: none; }
}

`;
