import { describe, expect, it } from "vite-plus/test";

import {
  parsePartialEditInput,
  parsePartialInput,
  parsePartialToolInput,
  toolStreamsItsInput,
} from "./streamingInput.ts";

describe("a write's input while it streams", () => {
  it("yields the fields completed so far", () => {
    expect(parsePartialToolInput('{"path":"a.ts","content":"hello"}')).toEqual({
      path: "a.ts",
      content: "hello",
    });
  });

  it("yields the growing text of a value that is still open", () => {
    // The whole point: the row shows the file filling in, not a blank until done.
    expect(parsePartialToolInput('{"path":"a.ts","content":"line one\\nline t')).toEqual({
      path: "a.ts",
      content: "line one\nline t",
    });
  });

  it("stops cleanly on a key that is itself mid-stream", () => {
    expect(parsePartialToolInput('{"path":"a.ts","cont')).toEqual({ path: "a.ts" });
  });

  it("stops before an escape split across chunks rather than mangling it", () => {
    expect(parsePartialToolInput('{"content":"a\\')).toEqual({ content: "a" });
    expect(parsePartialToolInput('{"content":"a\\u26')).toEqual({ content: "a" });
  });

  it("decodes escapes it has all of", () => {
    expect(parsePartialToolInput('{"content":"a\\tb\\u0041"}')).toEqual({ content: "a\tbA" });
  });

  it("skips non-string values instead of reading them as text", () => {
    expect(parsePartialToolInput('{"offset":12,"path":"a.ts"}')).toEqual({ path: "a.ts" });
  });

  it("has nothing to say before the object opens", () => {
    expect(parsePartialToolInput("")).toEqual({});
  });
});

describe("an edit's input while it streams", () => {
  it("reads the path and the replacement text out of the nested shape", () => {
    expect(
      parsePartialEditInput('{"path":"a.ts","edits":[{"oldText":"gone","newText":"kept"}]}'),
    ).toEqual({ path: "a.ts", content: "kept" });
  });

  it("joins several hunks with a separator", () => {
    const json =
      '{"path":"a.ts","edits":[{"oldText":"x","newText":"one"},{"oldText":"y","newText":"two"}]}';
    expect(parsePartialEditInput(json).content).toBe("one\n⋯\ntwo");
  });

  it("shows the last hunk while it is still arriving", () => {
    expect(parsePartialEditInput('{"path":"a.ts","edits":[{"oldText":"x","newText":"par').content).toBe(
      "par",
    );
  });

  it("leaves oldText out — the result diff renders it better", () => {
    expect(parsePartialEditInput('{"edits":[{"oldText":"gone"}]}').content).toBeUndefined();
  });
});

describe("which tools stream a preview", () => {
  it("is the same set the terminal buffers", () => {
    expect(["write", "edit", "plan"].map(toolStreamsItsInput)).toEqual([true, true, true]);
    expect(["read", "bash", "grep", "task"].map(toolStreamsItsInput)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it("picks edit's parser only for edit", () => {
    const json = '{"path":"a.ts","edits":[{"oldText":"x","newText":"new"}]}';
    expect(parsePartialInput("edit", json)).toEqual({ path: "a.ts", content: "new" });
    // The flat parser bails at the nested array, so it sees only the path.
    expect(parsePartialInput("write", json)).toEqual({ path: "a.ts" });
  });
});
