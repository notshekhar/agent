import { describe, expect, test } from "bun:test";
import { Markdown } from "../src/components/markdown";
import { defaultMarkdownTheme } from "./test-themes";

const W = 60;

/**
 * The contract of the incremental streaming path: at EVERY prefix of a
 * streamed document, the incrementally-rendered frame must be byte-identical
 * to what a cold render of that same prefix produces. If it ever isn't, the
 * transcript would show something the finished message does not.
 */
function assertStreamMatchesCold(doc: string, chunk: number): void {
    const streamed = new Markdown("", 1, 0, defaultMarkdownTheme);
    streamed.setStreaming(true);
    for (let end = chunk; ; end = Math.min(end + chunk, doc.length)) {
        const prefix = doc.slice(0, end);
        streamed.setText(prefix);
        const incremental = streamed.render(W);
        const cold = new Markdown(prefix, 1, 0, defaultMarkdownTheme).render(W);
        expect({ at: end, lines: incremental }).toEqual({ at: end, lines: cold });
        if (end === doc.length) break;
    }
    // And the finished document, once the stream is over.
    streamed.setStreaming(false);
    expect(streamed.render(W)).toEqual(new Markdown(doc, 1, 0, defaultMarkdownTheme).render(W));
}

const PROSE =
    "First paragraph of the answer, long enough to wrap across the width at least once or twice.\n\n" +
    "Second paragraph with `inline code` and **bold** and *italic* text in it.\n\n" +
    "Third paragraph, plain.\n\n" +
    "Fourth and final paragraph of prose.";

const MIXED =
    "# Heading\n\n" +
    "Intro paragraph before the list.\n\n" +
    "- first bullet\n- second bullet\n\n" +
    "A paragraph between the two lists.\n\n" +
    "1. one\n2. two\n\n" +
    "```ts\nconst x: number = 1;\nconsole.log(x);\n```\n\n" +
    "> a blockquote line\n> continued\n\n" +
    "---\n\n" +
    "Closing paragraph.";

/** The loose-list trap: a blank line does NOT end a list, so a naive freeze
 * across one would restart the numbering at 1. */
const LOOSE_LIST = "Intro.\n\n1. one\n\n2. two\n\n3. three\n\nAfter the list.";

/** A fence that is still open when the stream pauses mid-block. */
const LONG_FENCE =
    "Before.\n\n```python\n" + "print('a line of code')\n".repeat(12) + "```\n\nAfter the block, some prose.";

/** Setext headings: text that retroactively turns the line above it into a
 * heading — only possible with no blank line between, which is exactly what a
 * freeze boundary requires. */
const SETEXT = "Some intro.\n\nA title line\n===\n\nBody paragraph after the setext heading.";

describe("Markdown streaming stays identical to a full render", () => {
    const docs: Array<[string, string]> = [
        ["prose paragraphs", PROSE],
        ["mixed blocks", MIXED],
        ["loose ordered list", LOOSE_LIST],
        ["long fenced code", LONG_FENCE],
        ["setext heading", SETEXT],
    ];

    for (const [name, doc] of docs) {
        for (const chunk of [1, 7, 40]) {
            test(`${name}, ${chunk}-char chunks`, () => {
                assertStreamMatchesCold(doc, chunk);
            });
        }
    }

    test("a width change mid-stream re-renders instead of reusing the old head", () => {
        const md = new Markdown("", 1, 0, defaultMarkdownTheme);
        md.setStreaming(true);
        md.setText(PROSE.slice(0, 200));
        md.render(W);
        md.setText(PROSE);
        expect(md.render(40)).toEqual(new Markdown(PROSE, 1, 0, defaultMarkdownTheme).render(40));
        expect(md.render(W)).toEqual(new Markdown(PROSE, 1, 0, defaultMarkdownTheme).render(W));
    });

    test("text that is not an extension of the head falls back to a full render", () => {
        const md = new Markdown("", 1, 0, defaultMarkdownTheme);
        md.setStreaming(true);
        md.setText(PROSE);
        md.render(W);
        md.setText(MIXED); // a different document entirely (a /retry, a replay)
        expect(md.render(W)).toEqual(new Markdown(MIXED, 1, 0, defaultMarkdownTheme).render(W));
    });

    test("a non-streaming component never builds a head", () => {
        const md = new Markdown(PROSE.slice(0, 120), 1, 0, defaultMarkdownTheme);
        md.render(W);
        md.setText(PROSE);
        expect(md.render(W)).toEqual(new Markdown(PROSE, 1, 0, defaultMarkdownTheme).render(W));
    });

    test("the tail is what gets lexed, not the whole document", () => {
        // The point of the exercise: a frame's cost stops growing with the
        // message. 200 paragraphs, one delta, measured against a cold render
        // of the same text.
        const doc = Array.from({ length: 200 }, (_, i) => `Paragraph number ${i} with some words in it.`).join("\n\n");
        const md = new Markdown(doc, 1, 0, defaultMarkdownTheme);
        md.setStreaming(true);
        md.render(W);

        const t0 = performance.now();
        md.setText(doc + " and a few more words arriving.");
        md.render(W);
        const incremental = performance.now() - t0;

        const t1 = performance.now();
        new Markdown(doc + " and a few more words arriving.", 1, 0, defaultMarkdownTheme).render(W);
        const cold = performance.now() - t1;

        expect(incremental).toBeLessThan(cold / 4);
    });
});
