/**
 * Stamp rendered markdown blocks with the source lines they came from.
 *
 * Rendered markdown has no line numbers, which is why commenting only worked
 * in the source view: a comment is a line range, and there was nothing to
 * derive one from once the text became prose. The mdast positions survive the
 * trip into hast, so every top-level block already knows where it started and
 * ended — this just writes that onto the element for the DOM to read back.
 *
 * Top-level blocks only. A comment anchored to one word inside a paragraph
 * would still resolve to the paragraph's lines, so descending further costs
 * attributes on every `<em>` in the document and buys nothing.
 */
/**
 * The slice of hast this needs, spelled out rather than imported: `hast`'s
 * types are a transitive dependency of react-markdown, not one this package
 * declares, and importing them here would make the build depend on hoisting.
 */
interface HastNode {
  type: string;
  properties?: Record<string, unknown>;
  position?: { start: { line: number }; end: { line: number } };
}

export const MARKDOWN_SOURCE_LINE_START = "data-md-line-start";
export const MARKDOWN_SOURCE_LINE_END = "data-md-line-end";

export function rehypeMarkdownSourceLines() {
  return (tree: { children: HastNode[] }): void => {
    for (const node of tree.children) {
      if (node.type !== "element") continue;
      const start = node.position?.start.line;
      const end = node.position?.end.line;
      if (start === undefined || end === undefined) continue;
      node.properties = {
        ...node.properties,
        [MARKDOWN_SOURCE_LINE_START]: start,
        [MARKDOWN_SOURCE_LINE_END]: end,
      };
    }
  };
}

/**
 * The bits of an element this walk reads. Duck-typed rather than `Element`,
 * so the logic can be exercised without a DOM.
 */
export interface SourceLineElement {
  getAttribute(name: string): string | null;
  readonly parentElement: SourceLineElement | null;
}

/**
 * The source range a DOM node sits in, or null when it is outside the
 * rendering. Walks up to the nearest stamped block, which is where the
 * attributes live.
 */
export function resolveMarkdownSourceRange(
  node: { getAttribute?: unknown; parentElement: SourceLineElement | null } | null,
  root: SourceLineElement,
): { startLine: number; endLine: number } | null {
  // A text node has no attributes of its own; start at its parent.
  let element: SourceLineElement | null =
    typeof node?.getAttribute === "function"
      ? (node as unknown as SourceLineElement)
      : (node?.parentElement ?? null);
  while (element && element !== root) {
    const start = element.getAttribute(MARKDOWN_SOURCE_LINE_START);
    const end = element.getAttribute(MARKDOWN_SOURCE_LINE_END);
    if (start !== null && end !== null) {
      const startLine = Number.parseInt(start, 10);
      const endLine = Number.parseInt(end, 10);
      if (Number.isFinite(startLine) && Number.isFinite(endLine)) {
        return { startLine, endLine };
      }
    }
    element = element.parentElement;
  }
  return null;
}

/** The union of two block ranges — a selection that spans several paragraphs. */
export function mergeMarkdownSourceRanges(
  first: { startLine: number; endLine: number } | null,
  second: { startLine: number; endLine: number } | null,
): { startLine: number; endLine: number } | null {
  if (!first) return second;
  if (!second) return first;
  return {
    startLine: Math.min(first.startLine, second.startLine),
    endLine: Math.max(first.endLine, second.endLine),
  };
}
