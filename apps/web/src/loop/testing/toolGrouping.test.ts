import { describe, expect, it } from "vite-plus/test";

import { renderTranscript } from "./renderTranscript";

/**
 * Which tool calls the transcript folds into one row.
 *
 * A turn that reads six files puts six rows between the question and the
 * answer, and none of them is what anyone came to read. Runs of finished calls
 * whose individual detail is noise are gathered into a single row that draws as
 * "Read 3 files" and opens on a click — the same fold the terminal's live mode
 * makes, with the same vocabulary (`loopVerbGroup.ts`).
 *
 * These assert the ROWS, since that is where the fold is decided; the blocks a
 * row expands into stay one per call either way.
 */
const call = (name: string, input: unknown, id: string) => [
  { type: "tool-input-start", data: { toolName: name, toolCallId: id } },
  { type: "tool-call", data: { toolCallId: id, toolName: name, input } },
  { type: "tool-result", data: { toolCallId: id, output: { type: "text", value: "body" } } },
];

const running = (name: string, input: unknown, id: string) => [
  { type: "tool-input-start", data: { toolName: name, toolCallId: id } },
  { type: "tool-call", data: { toolCallId: id, toolName: name, input } },
];

const read = (path: string, id: string) => call("read", { path: `/w/project/${path}` }, id);

/** How many calls each work row stands for, in order. */
const rowSizes = async (events: ReadonlyArray<{ type: string; data?: unknown }>, live = false) => {
  const view = await renderTranscript({ events, running: live });
  return view.rows
    .filter((row) => row.kind === "work")
    .map((row) => (row.kind === "work" ? row.groupedEntries.length : 0));
};

describe("folding a run of tool calls", () => {
  it("gathers a run of finished reads into one row", async () => {
    expect(await rowSizes([...read("a.ts", "1"), ...read("b.ts", "2"), ...read("c.ts", "3")])).toEqual([3]);
  });

  it("keeps every call inside the row it folded them into", async () => {
    const view = await renderTranscript({
      events: [...read("a.ts", "1"), ...read("b.ts", "2")],
    });
    // The fold hides rows; it must not drop calls.
    expect(view.blocks.filter((block) => block.kind === "tool")).toHaveLength(2);
  });

  it("breaks the run around an edit, whose detail IS the information", async () => {
    const events = [
      ...read("a.ts", "1"),
      ...call("edit", { path: "/w/project/b.ts" }, "2"),
      ...read("c.ts", "3"),
    ];
    expect(await rowSizes(events)).toEqual([1, 1, 1]);
  });

  it("folds commands and MCP calls into the run rather than breaking it", async () => {
    const events = [
      ...read("a.ts", "1"),
      ...call("bash", { command: "npm test" }, "2"),
      ...call("sentry__list_errors", {}, "3"),
      ...read("c.ts", "4"),
    ];
    expect(await rowSizes(events)).toEqual([4]);
  });

  it("mixes kinds in one run and names each — reads and listings together", async () => {
    const events = [
      ...call("ls", { path: "/w/project" }, "1"),
      ...call("ls", { path: "/w/project/src" }, "2"),
      ...read("a.ts", "3"),
    ];
    expect(await rowSizes(events)).toEqual([3]);
  });

  it("leaves a running call in its own row, in front of the run behind it", async () => {
    const events = [...read("a.ts", "1"), ...read("b.ts", "2"), ...running("read", { path: "/w/project/c.ts" }, "3")];
    // Two finished reads folded; the live one still visible on its own.
    expect(await rowSizes(events, true)).toEqual([2, 1]);
  });

  it("folds the live call in once it lands", async () => {
    const events = [...read("a.ts", "1"), ...read("b.ts", "2"), ...read("c.ts", "3")];
    expect(await rowSizes(events, true)).toEqual([3]);
  });

  it("does not fold an edit — which file changed is the point", async () => {
    const events = [
      ...call("edit", { path: "/w/project/a.ts" }, "1"),
      ...call("edit", { path: "/w/project/b.ts" }, "2"),
    ];
    expect(await rowSizes(events)).toEqual([1, 1]);
  });
});
