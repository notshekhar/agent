import { describe, expect, test } from "bun:test";
import { parsePartialToolInput } from "../src/interactive/ui/streaming-input";

describe("parsePartialToolInput", () => {
    test("parses a complete write input", () => {
        const out = parsePartialToolInput('{"path":"src/a.ts","content":"hello\\nworld"}');
        expect(out).toEqual({ path: "src/a.ts", content: "hello\nworld" });
    });

    test("returns the streamed prefix of a still-open string value", () => {
        const out = parsePartialToolInput('{"path":"src/a.ts","content":"const x = 1;\\nconst y');
        expect(out.path).toBe("src/a.ts");
        expect(out.content).toBe("const x = 1;\nconst y");
    });

    test("handles the very start of the stream", () => {
        expect(parsePartialToolInput("")).toEqual({});
        expect(parsePartialToolInput('{"pa')).toEqual({});
        expect(parsePartialToolInput('{"path"')).toEqual({});
        expect(parsePartialToolInput('{"path":"sr')).toEqual({ path: "sr" });
    });

    test("keys inside string values are not mistaken for fields", () => {
        const out = parsePartialToolInput('{"path":"a.json","content":"{\\"path\\": \\"decoy\\"}"}');
        expect(out.path).toBe("a.json");
        expect(out.content).toBe('{"path": "decoy"}');
    });

    test("decodes escapes and drops a chunk-split escape tail", () => {
        expect(parsePartialToolInput('{"content":"tab\\there"}').content).toBe("tab\there");
        expect(parsePartialToolInput('{"content":"snow \\u2603"}').content).toBe("snow ☃");
        // Escape sequence cut mid-stream: the decoded prefix stops before it.
        expect(parsePartialToolInput('{"content":"line\\').content).toBe("line");
        expect(parsePartialToolInput('{"content":"snow \\u26').content).toBe("snow ");
    });

    test("skips non-string primitives and stops at nested values", () => {
        expect(parsePartialToolInput('{"count":3,"path":"a.ts"}')).toEqual({ path: "a.ts" });
        expect(parsePartialToolInput('{"nested":{"x":1},"path":"a.ts"}')).toEqual({});
    });

    test("whitespace-tolerant", () => {
        const out = parsePartialToolInput('{ "path" : "a.ts" ,\n  "content" : "x" }');
        expect(out).toEqual({ path: "a.ts", content: "x" });
    });
});
