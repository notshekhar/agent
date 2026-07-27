import { describe, expect, test } from "bun:test";
import { fetchUrlAsText, isHttpUrl } from "../src/tools/utils/fetch-url";

describe("isHttpUrl", () => {
    test("matches http and https, case-insensitive, trims", () => {
        expect(isHttpUrl("http://example.com")).toBe(true);
        expect(isHttpUrl("https://example.com/page")).toBe(true);
        expect(isHttpUrl("  HTTPS://EXAMPLE.com ")).toBe(true);
    });

    test("rejects local paths and other schemes", () => {
        expect(isHttpUrl("/Users/x/file.ts")).toBe(false);
        expect(isHttpUrl("./rel/path.md")).toBe(false);
        expect(isHttpUrl("file:///etc/hosts")).toBe(false);
        expect(isHttpUrl("ftp://host/x")).toBe(false);
        expect(isHttpUrl("notaurl")).toBe(false);
    });
});

describe("fetchUrlAsText abort handling", () => {
    /**
     * Run with a fetch that never touches the network, recording the signal it
     * was handed. A request is only "not sent" if its signal is already
     * aborted when fetch receives it — that's what fetch guarantees.
     */
    async function withStubbedFetch(
        fn: () => Promise<string>,
    ): Promise<{ seen: AbortSignal | undefined; out: string }> {
        const real = globalThis.fetch;
        let seen: AbortSignal | undefined;
        globalThis.fetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
            seen = init?.signal;
            if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
            return new Response("ok", { headers: { "content-type": "text/plain" } });
        }) as typeof fetch;
        try {
            return { out: await fn(), seen };
        } finally {
            globalThis.fetch = real;
        }
    }

    test("a signal that aborted before the call cancels the request", async () => {
        const controller = new AbortController();
        controller.abort();
        // An already-aborted signal fires no "abort" event, so merely
        // subscribing let a cancelled turn still put the request on the wire.
        const { seen, out } = await withStubbedFetch(() => fetchUrlAsText("https://example.com", controller.signal));
        expect(seen?.aborted).toBe(true);
        expect(out).toBe("[fetch timed out or aborted: https://example.com]");
    });

    test("a live signal still fetches normally", async () => {
        const { seen, out } = await withStubbedFetch(() =>
            fetchUrlAsText("https://example.com", new AbortController().signal),
        );
        expect(seen?.aborted).toBe(false);
        expect(out).toContain("ok");
    });
});
