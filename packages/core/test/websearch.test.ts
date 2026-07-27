import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createWebsearchTool, formatSearchResults, parseSearchResults } from "../src/tools/websearch";

const here = dirname(fileURLToPath(import.meta.url));
// A real html.duckduckgo.com response for "bun ffi dlopen" (2026-07-06),
// including one sponsored result — markup drift shows up here as failures.
const FIXTURE = readFileSync(join(here, "fixtures", "ddg-search.html"), "utf-8");

describe("parseSearchResults", () => {
    test("extracts organic results with decoded target URLs", () => {
        const results = parseSearchResults(FIXTURE, 10);
        expect(results.length).toBeGreaterThanOrEqual(5);
        // First organic hit: the uddg redirect decoded to the real URL.
        expect(results[0]).toEqual({
            title: "bun:ffi dlopen function | API Reference | Bun",
            url: "https://bun.com/reference/bun/ffi/dlopen",
            snippet: expect.stringContaining("just-in-time compiling C wrappers"),
        });
        for (const r of results) {
            expect(r.url).toMatch(/^https?:\/\//);
            expect(r.title.length).toBeGreaterThan(0);
        }
    });

    test("skips sponsored results", () => {
        // The fixture's first block is an ad (result--ad, y.js redirect).
        expect(FIXTURE).toContain("result--ad");
        const results = parseSearchResults(FIXTURE, 10);
        for (const r of results) {
            expect(r.url).not.toContain("duckduckgo.com/y.js");
            expect(r.title).not.toContain("Firstcry");
        }
    });

    test("respects the limit", () => {
        expect(parseSearchResults(FIXTURE, 3)).toHaveLength(3);
    });

    test("returns [] for non-result HTML", () => {
        expect(parseSearchResults("<html><body>challenge page</body></html>", 10)).toEqual([]);
        expect(parseSearchResults("", 10)).toEqual([]);
    });
});

describe("websearch abort handling", () => {
    test("a signal that aborted before the call cancels the search", async () => {
        const controller = new AbortController();
        controller.abort();
        const real = globalThis.fetch;
        let seen: AbortSignal | undefined;
        globalThis.fetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
            seen = init?.signal;
            if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
            return new Response(FIXTURE, { headers: { "content-type": "text/html" } });
        }) as typeof fetch;
        try {
            const tool = createWebsearchTool({ abortSignal: controller.signal });
            const exec = (tool as unknown as { execute: (i: unknown, o: unknown) => Promise<string> }).execute;
            // Already-aborted signals never fire their listener, so the search
            // used to go out anyway after the turn was cancelled.
            expect(await exec({ query: "bun ffi" }, {} as never)).toBe('[websearch timed out or aborted: "bun ffi"]');
            expect(seen?.aborted).toBe(true);
        } finally {
            globalThis.fetch = real;
        }
    });
});

describe("formatSearchResults", () => {
    test("numbers results and indents url + snippet", () => {
        const text = formatSearchResults([
            { title: "A", url: "https://a.example", snippet: "first" },
            { title: "B", url: "https://b.example", snippet: "" },
        ]);
        expect(text).toBe("1. A\n   https://a.example\n   first\n\n2. B\n   https://b.example");
    });
});
