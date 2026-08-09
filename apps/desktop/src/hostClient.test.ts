import { describe, expect, test } from "bun:test";

import { HostClient, type HostProcess } from "./hostClient";
import type { FromHost, HostNotification, ToHost } from "./hostProtocol";

/**
 * A utility process this test drives.
 *
 * The real one cannot be used here: `utilityProcess.fork` needs a running
 * Electron app, so a test that spawned one would either be skipped or hang.
 * The contract that matters is the message protocol, and that is entirely
 * observable through this.
 */
class FakeHost implements HostProcess {
  sent: ToHost[] = [];
  killed = false;
  #message: ((message: FromHost) => void) | null = null;
  #exit: ((code: number) => void) | null = null;
  readonly stderr = null;

  transferred: unknown[][] = [];

  postMessage(message: ToHost, transfer?: readonly unknown[]): void {
    this.sent.push(message);
    if (transfer) this.transferred.push([...transfer]);
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  on(event: "message" | "exit", listener: ((m: FromHost) => void) & ((c: number) => void)): void {
    if (event === "message") this.#message = listener;
    else this.#exit = listener;
  }
  /** The host answering a request. */
  reply(message: FromHost): void {
    this.#message?.(message);
  }
  die(code = 1): void {
    this.#exit?.(code);
  }
  /** The last request's id, so a test can answer it without guessing. */
  lastRequestId(): number {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const message = this.sent[i];
      if (message?.kind === "request") return message.id;
    }
    throw new Error("no request was sent");
  }
}

function started(callbacks: Record<string, (params: unknown) => Promise<unknown>> = {}) {
  const processes: FakeHost[] = [];
  const client = new HostClient(() => {
    const fake = new FakeHost();
    processes.push(fake);
    return fake;
  }, callbacks);
  client.start();
  return { client, processes, current: () => processes[processes.length - 1]! };
}

describe("HostClient", () => {
  test("a call round-trips through the host", async () => {
    const { client, current } = started();
    const pending = client.call("git.status", { cwd: "/w" });
    const sent = current().sent[0];
    expect(sent).toMatchObject({ kind: "request", method: "git.status", params: { cwd: "/w" } });
    current().reply({ kind: "response", id: current().lastRequestId(), ok: true, value: { isRepo: true } });
    expect(await pending).toEqual({ isRepo: true });
  });

  test("a failed call rejects with the host's own message", async () => {
    const { client, current } = started();
    const pending = client.call("git.status", {});
    current().reply({
      kind: "response",
      id: current().lastRequestId(),
      ok: false,
      error: "not a repository",
    });
    await expect(pending).rejects.toThrow("not a repository");
  });

  test("concurrent calls settle independently", async () => {
    const { client, current } = started();
    const first = client.call("a", {});
    const second = client.call("b", {});
    const ids = current().sent.filter((m) => m.kind === "request").map((m) => m.id);
    // Answered out of order, which the id is what makes safe.
    current().reply({ kind: "response", id: ids[1]!, ok: true, value: "second" });
    current().reply({ kind: "response", id: ids[0]!, ok: true, value: "first" });
    expect(await first).toBe("first");
    expect(await second).toBe("second");
  });

  test("notifications are re-emitted for main to forward", async () => {
    const { client, current } = started();
    const seen: HostNotification[] = [];
    client.on("notify", (message) => seen.push(message));
    current().reply({ kind: "notify", channel: "loop:terminal", payload: { data: "hi" } });
    expect(seen).toEqual([{ kind: "notify", channel: "loop:terminal", payload: { data: "hi" } }]);
  });

  /**
   * The reverse direction: writing a commit message means asking loop's core,
   * which lives in main. Without this the host would have to hold a model
   * client of its own.
   */
  test("the host can ask main a question and get an answer", async () => {
    const { client, current } = started({
      "core.commitMessage": async (params) => ({ message: `for ${(params as { cwd: string }).cwd}` }),
    });
    current().reply({ kind: "callback", id: 7, method: "core.commitMessage", params: { cwd: "/w" } });
    await Bun.sleep(0);
    expect(current().sent).toContainEqual({
      kind: "callbackResponse",
      id: 7,
      ok: true,
      value: { message: "for /w" },
    });
  });

  test("a callback main cannot answer comes back as a failure, not a hang", async () => {
    const { client, current } = started();
    current().reply({ kind: "callback", id: 9, method: "core.unknown", params: {} });
    await Bun.sleep(0);
    expect(current().sent).toContainEqual({
      kind: "callbackResponse",
      id: 9,
      ok: false,
      error: "main cannot answer core.unknown",
    });
  });

  /**
   * A dead host cannot answer anything it was already holding. Leaving those
   * promises pending is how a panel ends up spinning forever.
   */
  test("in-flight calls fail when the host dies", async () => {
    const { client, current } = started();
    const pending = client.call("git.status", {});
    const lost: number[] = [];
    client.on("lost", () => lost.push(1));
    current().die(3);
    await expect(pending).rejects.toThrow(/exited with 3/);
    expect(lost).toHaveLength(1);
  });

  test("the host is restarted after it dies", async () => {
    const { client, processes, current } = started();
    current().die(1);
    expect(client.running).toBe(false);
    await Bun.sleep(600);
    expect(processes).toHaveLength(2);
    expect(client.running).toBe(true);
  });

  test("stopping is final — no restart, and the child is killed", async () => {
    const { client, processes, current } = started();
    const child = current();
    client.stop();
    expect(child.killed).toBe(true);
    child.die(0);
    await Bun.sleep(600);
    expect(processes).toHaveLength(1);
    await expect(client.call("anything", {})).rejects.toThrow(/not running/);
  });
});

/**
 * The direct terminal pipe.
 *
 * A port is only valid for the pair holding it, so both ends being replaceable
 * is the whole complication: a renderer reload kills the far end, a host
 * restart the near one. `ready` is what makes the second case recoverable.
 */
describe("HostClient terminal port", () => {
  test("transfers the port alongside a port message", () => {
    const { client, current } = started();
    const port = { fake: "port1" };
    client.transferPort(port);
    expect(current().sent).toContainEqual({ kind: "port" });
    expect(current().transferred).toEqual([[port]]);
  });

  test("ready fires on start, so main can wire a port immediately", () => {
    const readies: number[] = [];
    const client = new HostClient(() => new FakeHost());
    client.on("ready", () => readies.push(1));
    client.start();
    expect(readies).toHaveLength(1);
  });

  /**
   * The restarted host is a different process and holds no port. Without a
   * second `ready`, terminal output would silently fall back to the ipc road
   * forever — working, but with main back in the hot path it was moved out of.
   */
  test("ready fires again after a restart, so the new host gets a port", async () => {
    const processes: FakeHost[] = [];
    const client = new HostClient(() => {
      const fake = new FakeHost();
      processes.push(fake);
      return fake;
    });
    let ports = 0;
    client.on("ready", () => {
      ports += 1;
      client.transferPort({});
    });
    client.start();
    processes[0]!.die(1);
    await Bun.sleep(600);
    expect(ports).toBe(2);
    // The port went to the NEW process, not the corpse of the old one.
    expect(processes[1]!.transferred).toHaveLength(1);
  });

  test("transferring with no host running is a no-op rather than a throw", () => {
    const client = new HostClient(() => new FakeHost());
    expect(() => client.transferPort({})).not.toThrow();
  });
});
