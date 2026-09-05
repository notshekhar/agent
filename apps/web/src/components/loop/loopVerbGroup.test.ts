import { describe, expect, it } from "vite-plus/test";

import { groupToolRuns, kindIdOf, isGroupableTool, verbGroupLabel } from "./loopVerbGroup";

interface Item {
  id: string;
  name: string;
  isError?: boolean;
  isPartial?: boolean;
  /** A row that is not a loop tool call at all (an approval, a hook line). */
  notATool?: boolean;
}

const item = (id: string, name: string, extra: Partial<Item> = {}): Item => ({
  id,
  name,
  ...extra,
});

const runs = (items: readonly Item[]) =>
  groupToolRuns(items, (entry) =>
    entry.notATool
      ? null
      : {
          name: entry.name,
          isError: entry.isError === true,
          isPartial: entry.isPartial === true,
        },
  );

/** `["Read 2 files", "bash", …]` — what the timeline would draw. */
const drawn = (items: readonly Item[]) =>
  runs(items).map((run) => (run.kind === "group" ? run.label : run.item.name));

describe("classifying a tool", () => {
  it("knows loop's builtins", () => {
    expect(kindIdOf("read")).toBe("file");
    expect(kindIdOf("ls")).toBe("dir");
    expect(kindIdOf("grep")).toBe("search");
    expect(kindIdOf("bash")).toBe("command");
    expect(kindIdOf("edit")).toBe("edit");
  });

  it("describes a tool it did not write by where it came from", () => {
    // A name is not evidence of what a tool does, so nothing is inferred from
    // it — one server's tools all classify the same way regardless of spelling.
    expect(kindIdOf("linear__create_issue")).toBe("mcp");
    expect(kindIdOf("linear__frobnicate")).toBe("mcp");
    expect(kindIdOf("sentry__list_errors")).toBe("mcp");
    expect(kindIdOf("search_issues")).toBe("extension");
    expect(kindIdOf("get_user")).toBe("extension");
  });
});

describe("what may be folded away", () => {
  it("folds kinds whose individual detail is noise", () => {
    expect(isGroupableTool({ name: "read", isError: false, isPartial: false })).toBe(true);
    expect(isGroupableTool({ name: "ls", isError: false, isPartial: false })).toBe(true);
  });

  it("folds commands, edits and third-party calls too", () => {
    for (const name of ["bash", "edit", "write", "linear__frobnicate", "frobnicate"]) {
      expect(isGroupableTool({ name, isError: false, isPartial: false })).toBe(true);
    }
  });

  it("keeps the plan surfaces visible", () => {
    // A plan is a document the rest of the turn is judged against, so it is
    // never reduced to a count. An answered `ask` is not in that set: it is
    // history like any other call, and a pending one is isPartial anyway.
    expect(isGroupableTool({ name: "enter_plan_mode", isError: false, isPartial: false })).toBe(
      false,
    );
    expect(isGroupableTool({ name: "ask", isError: false, isPartial: false })).toBe(true);
  });

  it("never folds a running call — it is the one worth watching", () => {
    expect(isGroupableTool({ name: "read", isError: false, isPartial: true })).toBe(false);
  });

  it("never folds plan, which is an approval surface", () => {
    expect(isGroupableTool({ name: "plan", isError: false, isPartial: false })).toBe(false);
  });

  it("folds a failed call — the header reports the failure instead", () => {
    expect(isGroupableTool({ name: "read", isError: true, isPartial: false })).toBe(true);
  });
});

describe("the header a run reads as", () => {
  it("names every kind with its own count, in first-seen order", () => {
    const { text } = verbGroupLabel([
      { toolName: "ls", isError: false, isRunning: false },
      { toolName: "ls", isError: false, isRunning: false },
      { toolName: "read", isError: false, isRunning: false },
    ]);
    expect(text).toBe("Listed 2 dirs, Read 1 file");
  });

  it("merges tools that share a kind", () => {
    const { text } = verbGroupLabel([
      { toolName: "grep", isError: false, isRunning: false },
      { toolName: "glob", isError: false, isRunning: false },
    ]);
    expect(text).toBe("Searched 2 patterns");
  });

  it("counts the failures it is hiding", () => {
    const { failed } = verbGroupLabel([
      { toolName: "read", isError: false, isRunning: false },
      { toolName: "read", isError: true, isRunning: false },
    ]);
    expect(failed).toBe(1);
  });

  it("never borrows a builtin's noun for a tool it did not write", () => {
    const { text } = verbGroupLabel([
      { toolName: "sentry__list_errors", isError: false, isRunning: false },
      { toolName: "sentry__get_error", isError: false, isRunning: false },
    ]);
    expect(text).toBe("Called 2 MCP tools");
  });

  it("separates MCP from extension calls — different sources", () => {
    const { text } = verbGroupLabel([
      { toolName: "linear__frobnicate", isError: false, isRunning: false },
      { toolName: "frobnicate", isError: false, isRunning: false },
    ]);
    expect(text).toBe("Called 1 MCP tool, Called 1 extension tool");
  });
});

describe("folding a work log", () => {
  it("folds a run of finished reads into one header", () => {
    expect(drawn([item("a", "read"), item("b", "read"), item("c", "read")])).toEqual([
      "Read 3 files",
    ]);
  });

  it("folds from one member, so the second call joins an existing header", () => {
    expect(drawn([item("a", "read")])).toEqual(["Read 1 file"]);
  });

  it("breaks the run around a call that keeps its own row", () => {
    expect(drawn([item("a", "read"), item("b", "enter_plan_mode"), item("c", "read")])).toEqual([
      "Read 1 file",
      "enter_plan_mode",
      "Read 1 file",
    ]);
  });

  it("an answered question folds into the run like any other call", () => {
    expect(drawn([item("a", "read"), item("b", "ask"), item("c", "read")])).toEqual([
      "Read 2 files, Asked 1 question",
    ]);
  });

  it("folds a mixed run into one header with a segment per kind", () => {
    expect(
      drawn([
        item("a", "read"),
        item("b", "bash"),
        item("c", "edit"),
        item("d", "linear__frobnicate"),
      ]),
    ).toEqual(["Read 1 file, Ran 1 command, Edited 1 file, Called 1 MCP tool"]);
  });

  it("leaves a running call outside the group in front of it", () => {
    expect(
      drawn([item("a", "read"), item("b", "read"), item("c", "read", { isPartial: true })]),
    ).toEqual(["Read 2 files", "read"]);
  });

  it("breaks the run around a row that is not a tool call at all", () => {
    expect(
      drawn([item("a", "read"), item("b", "approval", { notATool: true }), item("c", "read")]),
    ).toEqual(["Read 1 file", "approval", "Read 1 file"]);
  });

  it("keeps the head of a run stable as calls join it", () => {
    const before = runs([item("a", "read"), item("b", "read")]);
    const after = runs([item("a", "read"), item("b", "read"), item("c", "read")]);
    // The open/closed state is keyed on the head, so a call landing must not
    // change which item that is.
    expect(before[0]?.kind === "group" && before[0].items[0]?.id).toBe("a");
    expect(after[0]?.kind === "group" && after[0].items[0]?.id).toBe("a");
  });

  it("keeps every entry — a fold hides rows, it does not drop them", () => {
    const entries = [item("a", "read"), item("b", "bash"), item("c", "grep"), item("d", "ls")];
    const seen = runs(entries).flatMap((run) => (run.kind === "group" ? run.items : [run.item]));
    expect(seen.map((entry) => entry.id)).toEqual(["a", "b", "c", "d"]);
  });
});
