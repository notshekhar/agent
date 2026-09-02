/**
 * Client script for the trace page. Plain ES5-ish vanilla JS held in a string:
 * no `${` inside — the string is a template literal in TS.
 * Everything user-controlled goes through textContent; the model comes
 * from the JSON script element html.ts embeds.
 */
export const TRACE_CLIENT_JS = /* js */ `(function () {
  "use strict";
  var model = JSON.parse(document.getElementById("trace").textContent);
  var app = document.getElementById("app");

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (attrs[k] === undefined || attrs[k] === null || attrs[k] === false) continue;
      if (k === "class") el.className = attrs[k];
      else if (k === "text") el.textContent = attrs[k];
      else if (k === "style") el.style.cssText = attrs[k];
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), attrs[k]);
      else el.setAttribute(k, attrs[k]);
    }
    if (children) for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return el;
  }

  function fmtMs(ms) {
    if (ms < 1000) return Math.round(ms) + " ms";
    if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + " s";
    var m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
    return s ? m + " min " + s + " s" : m + " min";
  }
  function fmtTok(n) {
    if (n < 1000) return String(n);
    if (n < 100000) return (n / 1000).toFixed(1).replace(/\\.0$/, "") + "k";
    if (n < 1000000) return Math.round(n / 1000) + "k";
    return (n / 1000000).toFixed(2).replace(/\\.?0+$/, "") + "M";
  }
  function fmtUsd(u) {
    if (u === undefined || u === null) return "—";
    if (u === 0) return "$0";
    if (u < 0.000001) return "<$0.000001";
    if (u < 0.01) return "$" + u.toPrecision(2);
    if (u < 1) return "$" + u.toFixed(3);
    return "$" + u.toFixed(2);
  }
  function clock(ts) {
    var d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  function shortModel(id) { return id ? id.split("/").pop() : ""; }
  function usageText(u) {
    if (!u) return null;
    var parts = [fmtTok(u.input) + " in"];
    if (u.cacheRead) parts.push(fmtTok(u.cacheRead) + " cached");
    if (u.cacheWrite) parts.push(fmtTok(u.cacheWrite) + " cache write");
    parts.push(fmtTok(u.output) + " out");
    if (u.reasoning) parts.push(fmtTok(u.reasoning) + " reasoning");
    return parts.join(" · ") + " · " + (u.estimated ? "~" : "") + fmtUsd(u.usd);
  }

  /* --- per-step derived numbers (recorded only) --- */
  function stepSpans(step) {
    var t = step.timing;
    if (t.kind !== "recorded") return null;
    var modelMs = Math.max(0, t.modelEndedAt - t.startedAt);
    var toolMs = 0, toolEnd = t.modelEndedAt;
    // union of tool intervals, so parallel tools are not double-counted
    var iv = step.tools.filter(function (x) { return x.timing; }).map(function (x) {
      return [x.timing.startedAt, x.timing.endedAt === undefined ? t.endedAt : x.timing.endedAt];
    }).sort(function (a, b) { return a[0] - b[0]; });
    var cur = null;
    for (var i = 0; i < iv.length; i++) {
      if (!cur || iv[i][0] > cur[1]) { if (cur) toolMs += cur[1] - cur[0]; cur = [iv[i][0], iv[i][1]]; }
      else if (iv[i][1] > cur[1]) cur[1] = iv[i][1];
      if (iv[i][1] > toolEnd) toolEnd = iv[i][1];
    }
    if (cur) toolMs += cur[1] - cur[0];
    return { modelMs: modelMs, toolMs: toolMs, totalMs: Math.max(0, t.endedAt - t.startedAt),
             ttftMs: t.firstTokenAt !== undefined ? Math.max(0, t.firstTokenAt - t.startedAt) : undefined };
  }
  function turnSplit(turn) {
    var m = 0, tl = 0;
    for (var i = 0; i < turn.steps.length; i++) {
      var s = stepSpans(turn.steps[i]);
      if (!s) return null;
      m += s.modelMs; tl += s.toolMs;
    }
    return { modelMs: m, toolMs: tl };
  }
  function turnStart(turn) {
    var t0 = turn.startedAt;
    turn.steps.forEach(function (s) {
      if (s.timing.kind === "recorded") {
        var st = s.timing.startedAt - (s.timing.retryWaitMs || 0);
        if (st < t0) t0 = st;
      }
    });
    return t0;
  }

  /* --- legend --- */
  function legend() {
    var items = [
      ["l-model", "model, streaming"], ["l-wait", "model, before first token"], ["l-tool", "tool running"],
      ["l-derived", "wall time only (recorded before timing existed)"], ["l-retry", "waiting to retry the stream"], ["l-error", "tool error"]
    ];
    return h("div", { class: "legend" }, items.map(function (it) {
      return h("span", { class: it[0] }, [h("i"), it[1]]);
    }));
  }

  /* --- overview strip --- */
  function strip() {
    var turns = model.turns;
    if (!turns.length) return h("p", { class: "empty", text: "No turns in this session yet." });
    var longest = 1;
    turns.forEach(function (t) { longest = Math.max(longest, t.endedAt - turnStart(t)); });
    return h("div", { class: "strip" }, turns.map(function (t) {
      var dur = t.endedAt - turnStart(t);
      var w = Math.max(0.6, (dur / longest) * 100);
      var bar = h("div", { class: "strip-bar" });
      var split = turnSplit(t);
      if (t.steps.length === 0) {
        bar.appendChild(h("span", { class: "none", text: "no reply" }));
      } else if (split) {
        // proportional model / tool split of the turn's own bar
        var busy = split.modelMs + split.toolMs;
        var mw = busy ? (split.modelMs / busy) * w : w;
        bar.appendChild(h("span", { class: "seg model", style: "left:0;width:" + mw + "%" }));
        if (split.toolMs) bar.appendChild(h("span", { class: "seg tool", style: "left:" + mw + "%;width:" + (w - mw) + "%" }));
      } else {
        bar.appendChild(h("span", { class: "seg derived", style: "left:0;width:" + w + "%" }));
      }
      var q = t.user.text.replace(/\\s+/g, " ").trim();
      return h("a", { class: "strip-row", href: "#turn-" + t.index, title: q }, [
        h("span", { class: "strip-n", text: String(t.index) }),
        h("span", { class: "strip-q", text: q || "(no prompt)" }),
        bar,
        h("span", { class: "strip-r" }, [h("b", { text: fmtMs(dur) }), " · " + t.steps.length + (t.steps.length === 1 ? " step" : " steps") + " · " + (t.usage.estimated ? "~" : "") + fmtUsd(t.usage.usd)])
      ]);
    }));
  }

  /* --- per-turn timeline --- */
  function niceTick(spanMs) {
    var c = [100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000, 3600000];
    for (var i = 0; i < c.length; i++) if (spanMs / c[i] <= 10) return c[i];
    return c[c.length - 1];
  }
  function pct(t, t0, span) { return Math.max(0, Math.min(100, ((t - t0) / span) * 100)); }

  function timeline(turn) {
    var t0 = turnStart(turn), t1 = Math.max(turn.endedAt, t0 + 1), span = t1 - t0;
    var tick = niceTick(span);
    var ruler = h("div", { class: "tl-ruler" });
    for (var x = 0; x <= span; x += tick) {
      var left = pct(t0 + x, t0, span);
      // a label that starts in the last few percent has nowhere to go
      ruler.appendChild(h("span", { class: "tl-tick", style: "left:" + left + "%", text: left > 94 ? "" : (x === 0 ? "0" : fmtMs(x)) }));
    }
    var gridSize = (tick / span) * 100;
    var lanes = turn.steps.map(function (s) {
      var track = h("div", { class: "tl-track", style: "background-size:" + gridSize + "% 100%" });
      var t = s.timing;
      var label = h("div", { class: "tl-label", onclick: function () { focusStep(turn.index, s.index); } }, [
        "step " + s.index,
        s.interrupted ? h("em", { class: "tl-interrupted", text: " interrupted" }) : null,
        h("small", { text: shortModel(s.model) })
      ]);
      var rows = 0;
      if (t.kind === "recorded") {
        if (t.retryWaitMs) track.appendChild(h("span", { class: "bar retry", title: "waited " + fmtMs(t.retryWaitMs) + " to retry the stream",
          style: "left:" + pct(t.startedAt - t.retryWaitMs, t0, span) + "%;width:" + (t.retryWaitMs / span) * 100 + "%" }));
        var firstOut = t.firstTokenAt !== undefined ? Math.min(t.firstTokenAt, t.modelEndedAt) : t.startedAt;
        if (firstOut > t.startedAt) track.appendChild(h("span", { class: "bar model-wait", title: "before first token: " + fmtMs(firstOut - t.startedAt),
          style: "left:" + pct(t.startedAt, t0, span) + "%;width:" + ((firstOut - t.startedAt) / span) * 100 + "%" }));
        track.appendChild(h("span", { class: "bar model", title: "model: " + fmtMs(t.modelEndedAt - t.startedAt) + (t.firstTokenAt !== undefined ? " (first token at " + fmtMs(t.firstTokenAt - t.startedAt) + ")" : ""),
          style: "left:" + pct(firstOut, t0, span) + "%;width:" + Math.max(0, (t.modelEndedAt - firstOut) / span) * 100 + "%",
          onclick: function () { focusStep(turn.index, s.index); } }));
        if (t.firstTokenAt !== undefined) track.appendChild(h("span", { class: "tick-ttft", style: "left:" + pct(t.firstTokenAt, t0, span) + "%" }));
        // tools on sub-rows; overlapping ones stack
        var rowEnds = [];
        var timed = s.tools.filter(function (x) { return x.timing; }).sort(function (a, b) { return a.timing.startedAt - b.timing.startedAt; });
        timed.forEach(function (tool) {
          var st = tool.timing.startedAt, en = tool.timing.endedAt === undefined ? t.endedAt : tool.timing.endedAt;
          var row = 0; while (row < rowEnds.length && rowEnds[row] > st) row++;
          rowEnds[row] = en; rows = Math.max(rows, row + 1);
          track.appendChild(h("span", { class: "bar tool" + (tool.error ? " err" : "") + (tool.timing.endedAt === undefined ? " open" : ""),
            title: tool.name + " · " + (tool.timing.endedAt === undefined ? "did not return" : fmtMs(en - st)) + (tool.input ? " · " + tool.input : ""),
            style: "left:" + pct(st, t0, span) + "%;width:" + ((en - st) / span) * 100 + "%;top:" + (18 + row * 8) + "px",
            onclick: function () { focusStep(turn.index, s.index, tool.toolCallId); } }));
        });
      } else if (t.kind === "derived") {
        track.appendChild(h("span", { class: "bar derived", title: "wall time " + fmtMs(t.endedAt - t.startedAt) + " — model and tools together; this step was recorded before timing existed",
          style: "left:" + pct(t.startedAt, t0, span) + "%;width:" + ((t.endedAt - t.startedAt) / span) * 100 + "%",
          onclick: function () { focusStep(turn.index, s.index); } }));
      } else {
        track.appendChild(h("span", { class: "tl-none", text: "timing not recorded" }));
      }
      var lane = h("div", { class: "tl-lane", style: "min-height:" + Math.max(30, 20 + rows * 8 + 6) + "px" }, [label, track]);
      track.style.minHeight = lane.style.minHeight;
      return lane;
    });
    return h("div", { class: "tl" }, [ruler].concat(lanes));
  }

  /* --- step cards --- */
  function stepCard(turn, s) {
    var t = s.timing, sp = stepSpans(s);
    var head = [h("span", { class: "n", text: "step " + s.index })];
    if (t.kind === "recorded") {
      head.push(h("span", {}, [h("b", { text: fmtMs(sp.totalMs) }), " total"]));
      head.push(h("span", {}, ["model ", h("b", { text: fmtMs(sp.modelMs) }), sp.ttftMs !== undefined ? " (first token " + fmtMs(sp.ttftMs) + ")" : ""]));
      if (s.tools.length) head.push(h("span", {}, ["tools ", h("b", { text: fmtMs(sp.toolMs) })]));
      if (t.retryWaitMs) head.push(h("span", { class: "warn", text: "after " + fmtMs(t.retryWaitMs) + " retry wait" }));
    } else if (t.kind === "derived") {
      head.push(h("span", {}, [h("b", { text: fmtMs(t.endedAt - t.startedAt) }), " wall time"]));
      head.push(h("span", { class: "quiet", text: "model and tools not split" }));
    } else {
      head.push(h("span", { class: "quiet", text: "timing not recorded" }));
    }
    if (s.interrupted) head.push(h("span", { class: "warn", text: "interrupted" }));
    head.push(h("span", { class: "mono", text: shortModel(s.model) }));
    var u = usageText(s.usage);
    if (u) head.push(h("span", { class: "step-usage", text: u }));

    var body = [h("div", { class: "step-head" }, head)];
    if (s.reasoning) {
      var thought = s.reasoningMs && s.reasoningMs.length ? " for " + fmtMs(s.reasoningMs.reduce(function (a, b) { return a + b; }, 0)) : "";
      body.push(h("details", {}, [h("summary", { text: "thought" + thought }), h("div", { class: "reason", text: s.reasoning })]));
    }
    if (s.text) body.push(h("div", { class: "text", text: s.text }));
    if (s.tools.length) {
      body.push(h("ul", { class: "tools" }, s.tools.map(function (tool) {
        var dur = tool.timing ? (tool.timing.endedAt === undefined ? "did not return" : fmtMs(tool.timing.endedAt - tool.timing.startedAt))
                : tool.subagent && tool.subagent.durationMs !== undefined ? fmtMs(tool.subagent.durationMs) : "";
        var kids = [h("summary", {}, [
          h("span", { class: "name", text: tool.name }),
          h("span", { class: "input", text: tool.input }),
          h("span", { class: "dur" + (tool.error ? " err" : ""), text: (tool.error ? "error · " : "") + dur })
        ])];
        if (tool.subagent) {
          var sm = [tool.subagent.agent];
          if (tool.subagent.steps !== undefined) sm.push(tool.subagent.steps + (tool.subagent.steps === 1 ? " step" : " steps"));
          var su = usageText(tool.subagent.usage); if (su) sm.push(su);
          kids.push(h("div", { class: "sub-meta", text: "subagent · " + sm.join(" · ") }));
          if (tool.subagent.prompt) kids.push(h("div", { class: "sub-prompt", text: tool.subagent.prompt }));
        }
        if (tool.output !== undefined && tool.output !== "") kids.push(h("pre", { text: tool.output }));
        else if (!tool.subagent) kids.push(h("div", { class: "more", text: "no result recorded" }));
        var shown = (tool.output || "").length;
        if (tool.outputChars && tool.outputChars > shown) kids.push(h("div", { class: "more", text: "showing the first " + fmtTok(shown) + " of " + fmtTok(tool.outputChars) + " characters" }));
        return h("li", {}, [h("details", { class: "tool" + (tool.error ? " err" : "") + (tool.subagent ? " sub" : ""), id: "tool-" + turn.index + "-" + tool.toolCallId }, kids)]);
      })));
    }
    if (!s.text && !s.reasoning && !s.tools.length) body.push(h("p", { class: "empty", text: s.interrupted ? "nothing streamed before the interrupt" : "empty step" }));
    return h("article", { class: "step" + (t.kind === "derived" ? " derived-step" : t.kind === "none" ? " none-step" : ""), id: "step-" + turn.index + "-" + s.index }, body);
  }

  function focusStep(turnIdx, stepIdx, toolId) {
    var el = document.getElementById("step-" + turnIdx + "-" + stepIdx);
    if (!el) return;
    if (toolId) {
      var d = document.getElementById("tool-" + turnIdx + "-" + toolId);
      if (d) d.open = true;
    }
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    document.querySelectorAll(".step.hl").forEach(function (x) { x.classList.remove("hl"); });
    el.classList.add("hl");
    setTimeout(function () { el.classList.remove("hl"); }, 1800);
  }

  /* what the turn header says about its timing, beyond the bars */
  function timingNote(turn) {
    if (!turn.steps.length || turn.fullyRecorded) return "";
    var recorded = turn.steps.filter(function (s) { return s.timing.kind === "recorded"; }).length;
    var none = turn.steps.filter(function (s) { return s.timing.kind === "none"; }).length;
    if (recorded > 0) return " · partial timing";
    if (none === turn.steps.length) return " · timing not recorded";
    return " · wall time only";
  }

  function turnSection(turn) {
    var t0 = turnStart(turn), dur = turn.endedAt - t0, split = turnSplit(turn);
    var stats = [h("div", {}, [h("b", { text: fmtMs(dur) }), split ? " · model " + fmtMs(split.modelMs) + " · tools " + fmtMs(split.toolMs) : " wall time"])];
    stats.push(h("div", {}, [turn.steps.length + (turn.steps.length === 1 ? " step" : " steps"), " · ", turn.steps.reduce(function (n, s) { return n + s.tools.length; }, 0) + " tool calls"]));
    var u = usageText(turn.usage); if (u) stats.push(h("div", { text: u }));
    stats.push(h("div", { text: clock(turn.startedAt) }));
    var head = h("div", { class: "turn-head" }, [
      h("div", {}, [
        h("p", { class: "turn-n", text: "turn " + turn.index + timingNote(turn) }),
        h("p", { class: "turn-q" + (turn.user.text ? "" : " empty"), text: turn.user.text || "(no prompt recorded)" })
      ]),
      h("div", { class: "turn-stats" }, stats)
    ]);
    var kids = [head];
    if (turn.events.length) kids.push(h("ul", { class: "turn-events" }, turn.events.map(function (e) { return h("li", { text: e.label + " · " + clock(e.ts) }); })));
    if (turn.steps.length) {
      kids.push(timeline(turn));
      kids.push(h("div", { class: "steps" }, turn.steps.map(function (s) { return stepCard(turn, s); })));
    } else {
      kids.push(h("p", { class: "empty", text: "No reply was recorded for this turn." }));
    }
    return h("section", { class: "turn", id: "turn-" + turn.index }, kids);
  }

  app.textContent = "";
  app.appendChild(h("section", {}, [h("h2", { text: "turns" }), legend(), strip()]));
  model.turns.forEach(function (t) { app.appendChild(turnSection(t)); });
})();
`;
