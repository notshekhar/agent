/**
 * The surface an embedder drives core through.
 *
 * `apps/desktop` imports core as a library and runs it in-process instead of
 * spawning `loop rpc`. It cannot typecheck against core's SOURCE — that would
 * check core under the desktop's stricter flags (`noUncheckedIndexedAccess`,
 * `exactOptionalPropertyTypes`), reporting hundreds of errors in code that is
 * correct under its own settings. So the `./embed` export resolves `types` to
 * this file while the bundler still resolves the real `.ts`.
 *
 * `test/rpc-embedding.test.ts` asserts the runtime still matches.
 */
declare module "@notshekhar/loop-core/embed" {
  export interface EmbeddedTransport {
    send(message: unknown): void;
  }

  export class RpcServer {
    constructor();
    /**
     * Wire a transport to this server. `feed` takes newline-delimited JSON
     * requests; replies and notifications come back through `transport.send`.
     */
    attach(transport: EmbeddedTransport): {
      feed: (chunk: Buffer | string) => void;
      close: () => void;
    };
    disconnect(transport: EmbeddedTransport): void;
    /**
     * The hosting process is going away: abort live turns, drop subscribers,
     * and kill everything bash started. Returns the number of background
     * shells killed. Idempotent.
     */
    dispose(): number;
  }
}
