/**
 * A tree row has to describe itself the way the transcript describes the same
 * entry, or navigating means matching two different vocabularies by eye.
 */
import { describe, expect, it } from "vite-plus/test";

import { treeRowSummary } from "./SessionTreeDialog";
import type { SessionTreeRow } from "../../loop/tree";

const CWD = "/w/project";
const row = (fields: Partial<SessionTreeRow>): SessionTreeRow => ({
  id: "e1",
  parentId: null,
  ts: 1_700_000_000_000,
  type: "message",
  indent: 0,
  depth: 0,
  onPath: true,
  childCount: 0,
  ...fields,
});

describe("treeRowSummary", () => {
  it("uses the message text, and marks where it was cut", () => {
    expect(treeRowSummary(row({ role: "user", text: "fix the router" }), CWD)).toBe(
      "fix the router",
    );
    expect(treeRowSummary(row({ role: "user", text: "a long one", truncated: true }), CWD)).toBe(
      "a long one…",
    );
  });

  it("falls back to the calls an entry made, in the transcript's own grammar", () => {
    // `read src/app.ts`, not `read {"path":"/w/project/src/app.ts"}` — the
    // same summary the tool row in the transcript prints.
    const summary = treeRowSummary(
      row({
        role: "assistant",
        tools: [
          { name: "read", input: { path: `${CWD}/src/app.ts` } },
          { name: "bash", input: { command: "git status" } },
        ],
      }),
      CWD,
    );
    expect(summary).toBe("read src/app.ts, bash git status");
  });

  it("names the entry types that are not messages", () => {
    expect(treeRowSummary(row({ type: "compact" }), CWD)).toBe("context compacted");
    expect(treeRowSummary(row({ type: "branch-summary" }), CWD)).toBe("branch summary");
  });

  it("falls back to the entry type rather than rendering an empty row", () => {
    expect(treeRowSummary(row({ type: "model-change" }), CWD)).toBe("model-change");
  });

  it("says what an empty message row actually is", () => {
    // Seen live: a turn cut off mid-flight leaves an assistant entry with no
    // text and no calls. Titling it "message" repeats the entry type and
    // tells you nothing the metadata line below it does not already say.
    expect(treeRowSummary(row({ role: "assistant" }), CWD)).toBe("(no output)");
    expect(treeRowSummary(row({ role: "assistant", interrupted: true }), CWD)).toBe("(cut off)");
  });
});
