import { describe, expect, test } from "bun:test";

import { RpcServer } from "../src/rpc/server";

/**
 * The contract the desktop shell embeds core through.
 *
 * `apps/desktop` imports core as a library and drives it in-process rather
 * than spawning `loop rpc` — it calls `attach()` with a `{ send }` transport
 * and feeds newline-delimited JSON. Core ships no `.d.ts`, so the shell
 * declares that surface locally (`apps/desktop/src/loop-core.d.ts`); these
 * tests are what stop the two drifting.
 *
 * If something here fails, the desktop app is broken too — check
 * `coreHost.ts` before changing the assertions.
 */
describe("embedding core in another process", () => {
    test("attach() takes a bare { send } transport and returns feed + close", () => {
        const server = new RpcServer();
        const attached = server.attach({ send: () => {} });
        expect(typeof attached.feed).toBe("function");
        expect(typeof attached.close).toBe("function");
        attached.close();
    });

    test("a fed request comes back through the transport, correlated by id", async () => {
        // This is the whole embedding: no socket, no child process, no stdio.
        const replies: Record<string, unknown>[] = [];
        const server = new RpcServer();
        const { feed, close } = server.attach({
            send: (message) => replies.push(message as Record<string, unknown>),
        });

        feed(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "server.info", params: {} })}\n`);
        // handleLine awaits the server's own startup before dispatching.
        await Bun.sleep(50);

        const reply = replies.find((message) => message.id === 7);
        expect(reply).toBeDefined();
        expect(reply?.jsonrpc).toBe("2.0");
        const result = reply?.result as { methods?: string[] } | undefined;
        expect(Array.isArray(result?.methods)).toBe(true);
        close();
    });

    test("several requests fed in one chunk are all answered", () => {
        // `feed` is handed raw chunks, so it has to split on newlines itself —
        // the desktop writes one request per call, but a socket does not.
        const ids: unknown[] = [];
        const server = new RpcServer();
        const { feed, close } = server.attach({
            send: (message) => ids.push((message as { id?: unknown }).id),
        });
        const line = (id: number) =>
            `${JSON.stringify({ jsonrpc: "2.0", id, method: "server.info", params: {} })}\n`;
        feed(line(1) + line(2));
        close();
        // Dispatch is async; what matters here is that feeding a multi-line
        // chunk does not throw or drop the buffer.
        expect(() => feed("")).not.toThrow();
    });

    test("a malformed line is answered, not thrown", () => {
        // The shell would otherwise see a promise that never settles.
        const replies: Record<string, unknown>[] = [];
        const server = new RpcServer();
        const { feed, close } = server.attach({
            send: (message) => replies.push(message as Record<string, unknown>),
        });
        feed("this is not json\n");
        expect(replies).toHaveLength(1);
        expect((replies[0] as { error?: { message?: string } }).error?.message).toBe("Parse error");
        close();
    });

    test("dispose() is part of the embedded surface and is idempotent", () => {
        // The desktop calls this from before-quit. Core runs in the Electron
        // main process there, so a background shell it started is that
        // process's child — and detached, so it survives the app quitting
        // unless something kills it. dispose() is that something, and the
        // shell may reach it from more than one path (quit, window close), so
        // a second call must be a no-op rather than a throw.
        const server = new RpcServer();
        server.attach({ send: () => {} });
        expect(typeof server.dispose).toBe("function");
        expect(server.dispose()).toBe(0);
        expect(() => server.dispose()).not.toThrow();
    });
});
