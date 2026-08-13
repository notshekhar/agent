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

const item = (id: string, name: string, extra: Partial<Item> = {}): Item => ({ id, name, ...extra });

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

  it("classifies an unknown verb_noun tool by its leading verb", () => {
    expect(kindIdOf("search_issues")).toBe("search");
    expect(kindIdOf("fetch_page")).toBe("web");
    // Ambiguous leading verbs are deliberately absent from the heuristic.
    expect(kindIdOf("get_user")).toBe("other");
    expect(kindIdOf("run_job")).toBe("other");
  });

  it("names the server for an MCP tool it cannot classify", () => {
    expect(kindIdOf("linear__create_issue")).toBe("edit");
    expect(kindIdOf("linear__frobnicate")).toBe("mcp");
  });
});

describe("what may be folded away", () => {
  it("folds kinds whose individual detail is noise", () => {
    expect(isGroupableTool({ name: "read", isError: false, isPartial: false })).toBe(true);
    expect(isGroupableTool({ name: "ls", isError: false, isPartial: false })).toBe(true);
  });

  it("keeps a command, an edit and an unknown tool visible", () => {
    expect(isGroupableTool({ name: "bash", isError: false, isPartial: false })).toBe(false);
    expect(isGroupableTool({ name: "edit", isError: false, isPartial: false })).toBe(false);
    expect(isGroupableTool({ name: "frobnicate", isError: false, isPartial: false })).toBe(false);
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
    expect(drawn([item("a", "read"), item("b", "bash"), item("c", "read")])).toEqual([
      "Read 1 file",
      "bash",
      "Read 1 file",
    ]);
  });

  it("leaves a running call outside the group in front of it", () => {
    expect(
      drawn([item("a", "read"), item("b", "read"), item("c", "read", { isPartial: true })]),
    ).toEqual(["Read 2 files", "read"]);
  });

  it("breaks the run around a row that is not a tool call at all", () => {
    expect(drawn([item("a", "read"), item("b", "approval", { notATool: true }), item("c", "read")])).toEqual([
      "Read 1 file",
      "approval",
      "Read 1 file",
    ]);
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
