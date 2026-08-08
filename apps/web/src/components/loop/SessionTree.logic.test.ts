/**
 * Filtering a session tree. The rules exist because real data is mostly tool
 * calls: an unfiltered list is complete and unusable.
 */
import { describe, expect, it } from "vite-plus/test";

import { filterTreeRows, treeRowSearchText, treeSummary } from "./SessionTree.logic";
import type { SessionTreeRow } from "../../loop/tree";

const row = (fields: Partial<SessionTreeRow> & { id: string }): SessionTreeRow => ({
  parentId: null,
  ts: 1_700_000_000_000,
  type: "message",
  indent: 0,
  depth: 0,
  onPath: true,
  childCount: 0,
  ...fields,
});

const SESSION: readonly SessionTreeRow[] = [
  row({ id: "s", type: "session-info" }),
  row({ id: "u1", role: "user", text: "fix the auth bug" }),
  row({ id: "a1", role: "assistant", text: "Looking at the router." }),
  row({ id: "t1", role: "tool", tools: [{ name: "grep", input: { pattern: "login" } }] }),
  row({ id: "u2", role: "user", text: "now ship it" }),
];

describe("filterTreeRows", () => {
  it("hides bookkeeping entries by default", () => {
    const kept = filterTreeRows({ rows: SESSION, mode: "default", query: "", leafId: null });
    expect(kept.map((r) => r.id)).toEqual(["u1", "a1", "t1", "u2"]);
  });

  it("narrows to prompts, which is how you actually navigate", () => {
    const kept = filterTreeRows({ rows: SESSION, mode: "prompts", query: "", leafId: null });
    expect(kept.map((r) => r.id)).toEqual(["u1", "u2"]);
  });

  it("drops tool rows but keeps the replies", () => {
    const kept = filterTreeRows({ rows: SESSION, mode: "no-tools", query: "", leafId: null });
    expect(kept.map((r) => r.id)).toEqual(["u1", "a1", "u2"]);
  });

  it("shows everything in `all`, bookkeeping included", () => {
    const kept = filterTreeRows({ rows: SESSION, mode: "all", query: "", leafId: null });
    expect(kept).toHaveLength(SESSION.length);
  });

  it("never hides where the session currently is", () => {
    // You must always be able to see the leaf, or "Go here" has no anchor and
    // the view lies about where you are.
    const kept = filterTreeRows({ rows: SESSION, mode: "prompts", query: "zzz", leafId: "t1" });
    expect(kept.map((r) => r.id)).toEqual(["t1"]);
  });

  it("searches text, tool names and tool arguments", () => {
    const byArg = filterTreeRows({ rows: SESSION, mode: "default", query: "login", leafId: null });
    expect(byArg.map((r) => r.id)).toEqual(["t1"]);
    const byName = filterTreeRows({ rows: SESSION, mode: "default", query: "grep", leafId: null });
    expect(byName.map((r) => r.id)).toEqual(["t1"]);
    const byText = filterTreeRows({ rows: SESSION, mode: "default", query: "AUTH", leafId: null });
    expect(byText.map((r) => r.id)).toEqual(["u1"]);
  });

  it("renormalises indentation so a filtered list has no gaps", () => {
    // Hiding intermediate rows leaves survivors carrying indents computed
    // against rows that are gone — 0 then 3 reads as broken nesting.
    const deep = [
      row({ id: "a", role: "user", indent: 0 }),
      row({ id: "b", role: "tool", indent: 1 }),
      row({ id: "c", role: "user", indent: 2 }),
      row({ id: "d", role: "user", indent: 5 }),
    ];
    const kept = filterTreeRows({ rows: deep, mode: "prompts", query: "", leafId: null });
    expect(kept.map((r) => [r.id, r.indent])).toEqual([
      ["a", 0],
      ["c", 1],
      ["d", 2],
    ]);
  });

  it("leaves rows untouched when nothing needed renormalising", () => {
    const kept = filterTreeRows({ rows: SESSION, mode: "all", query: "", leafId: null });
    expect(kept[0]).toBe(SESSION[0]);
  });
});

describe("treeRowSearchText", () => {
  it("survives an input that cannot be stringified", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const text = treeRowSearchText(
      row({ id: "x", role: "tool", tools: [{ name: "bash", input: cyclic }] }),
    );
    expect(text).toContain("bash");
  });
});

describe("treeSummary", () => {
  it("counts conversation entries, not bookkeeping", () => {
    expect(treeSummary(SESSION, 0)).toBe("4 entries");
    expect(treeSummary(SESSION, 2)).toBe("2 branch points · 4 entries");
    expect(treeSummary(SESSION, 1)).toBe("1 branch point · 4 entries");
  });
});
