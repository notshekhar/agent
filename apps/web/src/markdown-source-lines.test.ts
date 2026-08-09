import { describe, expect, test } from "vite-plus/test";

import {
  MARKDOWN_SOURCE_LINE_END,
  MARKDOWN_SOURCE_LINE_START,
  mergeMarkdownSourceRanges,
  rehypeMarkdownSourceLines,
  resolveMarkdownSourceRange,
  type SourceLineElement,
} from "./markdown-source-lines";

const block = (line: number, endLine: number) => ({
  type: "element",
  tagName: "p",
  properties: { className: ["prose"] },
  position: { start: { line }, end: { line: endLine } },
});

describe("rehypeMarkdownSourceLines", () => {
  test("stamps top-level blocks with their source range", () => {
    const tree = { children: [block(1, 3), block(5, 5)] };
    rehypeMarkdownSourceLines()(tree);
    expect(tree.children[0]!.properties).toMatchObject({
      className: ["prose"],
      [MARKDOWN_SOURCE_LINE_START]: 1,
      [MARKDOWN_SOURCE_LINE_END]: 3,
    });
    expect(tree.children[1]!.properties).toMatchObject({
      [MARKDOWN_SOURCE_LINE_START]: 5,
      [MARKDOWN_SOURCE_LINE_END]: 5,
    });
  });

  test("leaves nodes without a position alone", () => {
    const text = { type: "text", value: "\n" };
    const tree = { children: [text] };
    rehypeMarkdownSourceLines()(tree);
    expect(text).toEqual({ type: "text", value: "\n" });
  });
});

/** The element chain the walk reads, without a DOM to build it in. */
function element(
  attributes: Record<string, string>,
  parentElement: SourceLineElement | null = null,
): SourceLineElement {
  return { getAttribute: (name) => attributes[name] ?? null, parentElement };
}

describe("resolveMarkdownSourceRange", () => {
  test("walks up from a text node to the stamped block", () => {
    const root = element({});
    const paragraph = element(
      { [MARKDOWN_SOURCE_LINE_START]: "4", [MARKDOWN_SOURCE_LINE_END]: "6" },
      root,
    );
    const emphasis = element({}, paragraph);
    // A text node: no getAttribute of its own, so the walk starts at its parent.
    const textNode = { parentElement: emphasis };

    expect(resolveMarkdownSourceRange(textNode, root)).toEqual({ startLine: 4, endLine: 6 });
  });

  test("is null outside any stamped block", () => {
    const root = element({});
    expect(resolveMarkdownSourceRange(element({}, root), root)).toBeNull();
  });
});

describe("mergeMarkdownSourceRanges", () => {
  test("spans both ends of a multi-block selection", () => {
    expect(
      mergeMarkdownSourceRanges({ startLine: 9, endLine: 11 }, { startLine: 2, endLine: 4 }),
    ).toEqual({ startLine: 2, endLine: 11 });
  });

  test("tolerates one end resolving to nothing", () => {
    expect(mergeMarkdownSourceRanges(null, { startLine: 3, endLine: 3 })).toEqual({
      startLine: 3,
      endLine: 3,
    });
    expect(mergeMarkdownSourceRanges(null, null)).toBeNull();
  });
});
