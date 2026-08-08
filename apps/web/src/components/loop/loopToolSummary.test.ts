import { describe, expect, it } from "vite-plus/test";

import {
  formatDuration,
  formatTaskStatus,
  formatToolArgs,
  formatToolInvocation,
  readGutterPrefixes,
  readLineRangeText,
  visibleSubagentSteps,
} from "./loopToolSummary";

const CWD = "/Users/someone/project";
const summary = (tool: string, args: Record<string, unknown>) => formatToolArgs(tool, args, CWD);

describe("how a tool call reads", () => {
  it("shows file tools as a repo-relative path", () => {
    expect(summary("read", { path: "/Users/someone/project/src/app.ts" })).toBe("src/app.ts");
    expect(summary("write", { file_path: "/Users/someone/project/a.txt" })).toBe("a.txt");
    expect(summary("edit", { filePath: "/Users/someone/project/b.txt" })).toBe("b.txt");
    // The workspace root itself is "." rather than an empty string.
    expect(summary("ls", { path: CWD })).toBe(".");
    // A path outside the workspace stays absolute — it is not "../.." noise.
    expect(summary("read", { path: "/etc/hosts" })).toBe("/etc/hosts");
  });

  it("shows bash as the first line of the command", () => {
    expect(summary("bash", { command: "bun test\necho done" })).toBe("bun test");
  });

  it("truncates a long bash command to fit a row", () => {
    const result = summary("bash", { command: "x".repeat(200) });
    expect(result).toHaveLength(78);
    expect(result.endsWith("…")).toBe(true);
  });

  it("shows grep as pattern in path", () => {
    expect(summary("grep", { pattern: "TODO", path: "/Users/someone/project/src" })).toBe(
      "TODO in src",
    );
    expect(summary("grep", { pattern: "TODO" })).toBe("TODO");
  });

  it("shows the searchable argument for find, websearch and skill", () => {
    expect(summary("find", { pattern: "*.ts" })).toBe("*.ts");
    expect(summary("websearch", { query: "effect rpc" })).toBe("effect rpc");
    expect(summary("skill", { name: "wayfinder" })).toBe("wayfinder");
  });

  it("shows sql as connection · flattened query", () => {
    expect(summary("sql", { connectionId: "prod", query: "select *\n  from users" })).toBe(
      "prod · select * from users",
    );
  });

  it("shows plan as its first heading, never the raw document", () => {
    expect(summary("plan", { plan: "# Ship the thing\n\nStep one." })).toBe("Ship the thing");
  });

  it("says nothing when the input has not streamed yet", () => {
    expect(summary("read", {})).toBe("");
  });
});

/**
 * Tools loop does not ship — an extension's or an MCP server's. The CLI asks
 * the extension to render its own summary, which is ANSI-returning CLI code
 * that cannot run in a browser, so these have to read well generically.
 */
describe("a tool loop does not know", () => {
  it("leads with the argument that says what the call is about", () => {
    expect(summary("deploy", { env: "prod", command: "bun run ship" })).toBe("bun run ship");
    expect(summary("jira", { id: "ENG-42", verbose: true })).toBe("ENG-42");
  });

  it("prefers a path and shows it relative to the workspace", () => {
    expect(summary("lint", { path: `${CWD}/src/app.ts`, fix: true })).toBe("src/app.ts");
  });

  it("lets a lone string argument name itself", () => {
    expect(summary("translate", { intoLanguage: "Hindi" })).toBe("Hindi");
  });

  it("reads plain scalars as key=value rather than JSON punctuation", () => {
    expect(summary("resize", { width: 100, height: 40 })).toBe("width=100 height=40");
  });

  it("still falls back to JSON for a genuinely structured input", () => {
    expect(summary("mystery", { spec: { nested: true } })).toBe('{"spec":{"nested":true}}');
  });

  it("keeps the summary to one row", () => {
    expect(summary("mystery", { note: "y".repeat(200) })).toHaveLength(78);
    expect(summary("mystery", { note: "a\nb\nc" })).toBe("a b c");
  });

  it("says nothing when the input has not streamed yet", () => {
    expect(summary("read", {})).toBe("");
  });
});

describe("a read's line range", () => {
  it("is empty for a whole-file read", () => {
    expect(readLineRangeText({})).toBe("");
  });

  it("is :start when only an offset is given", () => {
    expect(readLineRangeText({ offset: 120 })).toBe(":120");
  });

  it("is :start-end when both are given", () => {
    expect(readLineRangeText({ offset: 120, limit: 61 })).toBe(":120-180");
  });

  it("starts at line 1 when only a limit is given", () => {
    expect(readLineRangeText({ limit: 50 })).toBe(":1-50");
  });

  it("rides the invocation label, so an offset read is distinguishable", () => {
    expect(
      formatToolInvocation("read", { path: `${CWD}/src/app.ts`, offset: 120, limit: 61 }, CWD),
    ).toBe("read src/app.ts:120-180");
  });
});

describe("a read's line-number gutter", () => {
  it("numbers from the call's offset, not from 1", () => {
    expect(readGutterPrefixes(["a", "b", "c"], { offset: 120 })).toEqual(["120", "121", "122"]);
  });

  it("right-aligns numbers of differing width", () => {
    const prefixes = readGutterPrefixes(["a", "b"], { offset: 9 });
    expect(prefixes).toEqual([" 9", "10"]);
  });

  it("does not number the tool's own trailing notice", () => {
    expect(readGutterPrefixes(["a", "b", "", "[5 more lines]"], {})).toEqual(["1", "2", "", ""]);
  });

  it("does not number a result that is only a notice", () => {
    expect(readGutterPrefixes(["[image file]"], {})).toEqual([""]);
  });

  it("has nothing to number for an empty result", () => {
    expect(readGutterPrefixes([], {})).toEqual([]);
  });
});

describe("durations", () => {
  it("reads to a tenth under ten seconds", () => {
    expect(formatDuration(500)).toBe("0.5s");
    expect(formatDuration(9940)).toBe("9.9s");
  });

  it("reads in whole seconds under a minute", () => {
    expect(formatDuration(41_000)).toBe("41s");
  });

  it("reads as minutes and seconds beyond one", () => {
    expect(formatDuration(83_000)).toBe("1m23s");
  });

  it("does not print 60s at the minute boundary", () => {
    // 119.7s: flooring minutes on the raw value while rounding seconds
    // produced "1m00s" for something that should read "2m00s".
    expect(formatDuration(119_700)).toBe("2m00s");
  });
});

describe("a subagent's status", () => {
  it("is its live activity while running", () => {
    expect(
      formatTaskStatus({ isPartial: true, interrupted: false, isError: false, statusText: "grep" }),
    ).toBe("grep");
    expect(formatTaskStatus({ isPartial: true, interrupted: false, isError: false })).toBe(
      "running",
    );
  });

  it("summarizes the run once it is done", () => {
    expect(
      formatTaskStatus({
        isPartial: false,
        interrupted: false,
        isError: false,
        stats: { steps: 12, durationMs: 41_000, usd: 0.043 },
      }),
    ).toBe("done · 12 steps · 41s · $0.0430");
  });

  it("reports only what the run recorded", () => {
    expect(
      formatTaskStatus({ isPartial: false, interrupted: false, isError: false, stats: { steps: 1 } }),
    ).toBe("done · 1 step");
    expect(formatTaskStatus({ isPartial: false, interrupted: false, isError: false })).toBe("done");
  });

  it("says failed and interrupted rather than done", () => {
    expect(formatTaskStatus({ isPartial: false, interrupted: false, isError: true })).toBe("failed");
    expect(formatTaskStatus({ isPartial: false, interrupted: true, isError: false })).toBe(
      "interrupted",
    );
  });
});

describe("visibleSubagentSteps", () => {
  const text = (value: string) => ({ kind: "text" as const, text: value });
  const tool = (name: string) => ({ kind: "tool" as const, name });

  it("drops the closing text a settled run already reported", () => {
    // loop keeps both copies — the streamed text and the tool result — and
    // rendering both put the answer on screen twice.
    const steps = [tool("grep"), text("checking the router"), text("It lives in auth.ts.")];
    expect(visibleSubagentSteps(steps, true, "It lives in auth.ts.")).toEqual([
      steps[0],
      steps[1],
    ]);
  });

  it("keeps narration the report does not contain", () => {
    const steps = [text("checking the router"), tool("read")];
    expect(visibleSubagentSteps(steps, true, "It lives in auth.ts.")).toEqual(steps);
  });

  it("keeps everything while the run is still going", () => {
    // Mid-run there is no report yet, and the streamed text is all there is.
    const steps = [text("It lives in auth.ts.")];
    expect(visibleSubagentSteps(steps, false, "It lives in auth.ts.")).toEqual(steps);
    expect(visibleSubagentSteps(steps, true, undefined)).toEqual(steps);
  });
});
