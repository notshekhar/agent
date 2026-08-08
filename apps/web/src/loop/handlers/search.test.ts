import { describe, expect, it } from "vite-plus/test";

import { buildSnippet, matchSessions } from "./search.ts";
import type { LoopSessionRow } from "./shell.ts";

const row = (over: Partial<LoopSessionRow>): LoopSessionRow =>
  ({
    id: "01SESSION",
    cwd: "/w/one",
    createdAt: 1_700_000_000_000,
    mtime: 1_700_000_100_000,
    provider: "kimi",
    model: "kimi/k3",
    ...over,
  }) as LoopSessionRow;

describe("searching sessions", () => {
  it("finds a session by what the user named it", () => {
    const matches = matchSessions([row({ id: "a", name: "Fix the flaky test" })], "flaky", 10);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.snippet).toBe("Fix the flaky test");
    expect(matches[0]?.threadId).toBe("a");
  });

  it("finds one by what they opened it with", () => {
    const matches = matchSessions(
      [row({ id: "a", firstUserMessage: "why is the parser dropping escapes" })],
      "parser",
      10,
    );
    expect(matches[0]?.snippet).toContain("parser");
  });

  it("ignores case", () => {
    expect(matchSessions([row({ name: "Flaky Test" })], "FLAKY", 10)).toHaveLength(1);
  });

  it("reports the folder the session belongs to", () => {
    const matches = matchSessions([row({ cwd: "/w/project", name: "hit" })], "hit", 10);
    expect(matches[0]?.projectId).toBe("/w/project");
  });

  it("prefers the name over the opening message, and reports one hit per session", () => {
    const matches = matchSessions(
      [row({ id: "a", name: "hit in name", firstUserMessage: "hit in message" })],
      "hit",
      10,
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.snippet).toBe("hit in name");
  });

  it("returns the recent ones when the cap bites", () => {
    const rows = [
      row({ id: "old", name: "hit old", mtime: 1_000 }),
      row({ id: "new", name: "hit new", mtime: 9_000 }),
      row({ id: "mid", name: "hit mid", mtime: 5_000 }),
    ];
    expect(matchSessions(rows, "hit", 2).map((match) => match.threadId)).toEqual(["new", "mid"]);
  });

  it("skips a session whose cwd is unusable", () => {
    // The same rows the shell drops; a match with no project cannot be opened.
    expect(matchSessions([row({ cwd: "  ", name: "hit" })], "hit", 10)).toHaveLength(0);
  });

  it("finds nothing for an empty query rather than everything", () => {
    expect(matchSessions([row({ name: "anything" })], "   ", 10)).toHaveLength(0);
  });
});

describe("snippets", () => {
  it("leave a short text alone", () => {
    expect(buildSnippet("short enough", 0)).toBe("short enough");
  });

  it("collapse whitespace so a row stays one line", () => {
    expect(buildSnippet("two\n\nlines   here", 0)).toBe("two lines here");
  });

  it("centre on the match, so a long message still shows the word searched for", () => {
    const text = `${"a".repeat(500)}NEEDLE${"b".repeat(500)}`;
    const snippet = buildSnippet(text, 500);
    expect(snippet).toContain("NEEDLE");
    expect(snippet.length).toBeLessThanOrEqual(240);
  });

  it("mark a window that does not start at the beginning", () => {
    const text = `${"a".repeat(500)}NEEDLE`;
    expect(buildSnippet(text, 500).startsWith("…")).toBe(true);
  });

  it("do not mark a window that does start at the beginning", () => {
    const text = `NEEDLE${"b".repeat(500)}`;
    expect(buildSnippet(text, 0).startsWith("…")).toBe(false);
  });
});
