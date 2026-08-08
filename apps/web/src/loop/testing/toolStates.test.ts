import { describe, expect, it } from "vite-plus/test";

import { renderTranscript } from "./renderTranscript";

/**
 * What the transcript shows AT EACH STAGE of a tool call.
 *
 * The terminal gives feedback the moment a tool starts and keeps updating it;
 * the report against the desktop app was that rows only appear once a call has
 * finished. These replay loop's real event order — `tool-input-start`, then
 * `tool-input-delta`s, then `tool-call`, then `tool-result` — and assert what
 * is on screen after each one, so a stage that renders nothing fails here
 * rather than being noticed by eye.
 */
const started = (name: string, id = "t1") => ({
  type: "tool-input-start",
  data: { toolName: name, toolCallId: id },
});
const delta = (text: string, id = "t1") => ({
  type: "tool-input-delta",
  data: { toolCallId: id, delta: text },
});
const called = (name: string, input: unknown, id = "t1") => ({
  type: "tool-call",
  data: { toolCallId: id, toolName: name, input },
});
const result = (value: string, id = "t1") => ({
  type: "tool-result",
  data: { toolCallId: id, output: { type: "text", value } },
});

const toolRow = (view: Awaited<ReturnType<typeof renderTranscript>>) =>
  view.blocks.find((block) => block.kind === "tool")?.tool;

describe("a tool call, stage by stage", () => {
  it("shows a row as soon as the tool STARTS, before any input has arrived", async () => {
    // The terminal prints the row here. Nothing else has happened yet — no
    // arguments, no output — so an empty screen at this point is the bug.
    const view = await renderTranscript({ events: [started("read")], running: true });
    const tool = toolRow(view);
    expect(tool).toBeDefined();
    expect(tool?.name).toBe("read");
    expect(tool?.state).toBe("running");
  });

  it("shows the path while a write's arguments are still streaming", async () => {
    // `write` buffers its input, so the path is known long before the call
    // lands and should be on screen — not a bare "write".
    const view = await renderTranscript({
      events: [started("write"), delta('{"path":"notes.txt","content":"Riv')],
      running: true,
    });
    const tool = toolRow(view);
    expect(tool?.state).toBe("running");
    expect(tool?.summary).toContain("notes.txt");
  });

  it("shows the file content as it streams, not only when the write completes", async () => {
    const view = await renderTranscript({
      events: [
        started("write"),
        delta('{"path":"notes.txt","content":"Rivers meander because'),
      ],
      running: true,
    });
    expect(toolRow(view)?.streamingContent).toContain("Rivers meander");
  });

  it("keeps the row running once the call lands but no result has come back", async () => {
    // The gap between `tool-call` and `tool-result` is where a long read or a
    // slow command lives — the row must still say it is working.
    const view = await renderTranscript({
      events: [started("read"), called("read", { path: "notes.txt" })],
      running: true,
    });
    const tool = toolRow(view);
    expect(tool?.state).toBe("running");
    expect(tool?.summary).toContain("notes.txt");
  });

  it("settles to success with its output once the result arrives", async () => {
    const view = await renderTranscript({
      events: [
        started("read"),
        called("read", { path: "notes.txt" }),
        result("Rivers meander because of erosion."),
      ],
      running: true,
    });
    const tool = toolRow(view);
    expect(tool?.state).toBe("success");
    expect(tool?.output).toContain("erosion");
  });

  it("does not leave a spinner behind when the turn ends mid-call", async () => {
    // Interrupted, not running forever.
    const view = await renderTranscript({
      events: [started("read"), called("read", { path: "notes.txt" })],
      running: false,
    });
    expect(toolRow(view)?.state).toBe("interrupted");
  });

  it("renders several tools in the order they ran", async () => {
    const view = await renderTranscript({
      events: [
        started("write", "a"),
        called("write", { path: "notes.txt", content: "hi" }, "a"),
        result("wrote 1 line", "a"),
        started("read", "b"),
        called("read", { path: "notes.txt" }, "b"),
        result("hi", "b"),
      ],
      running: true,
    });
    expect(view.shape.filter((s) => s.startsWith("tool"))).toEqual([
      "tool write notes.txt",
      "tool read notes.txt",
    ]);
  });
});

describe("what the transcript says while a call is executing", () => {
  it("keeps the streamed file content on screen until the result replaces it", async () => {
    // The gap between `tool-call` and `tool-result` is where the file is
    // actually being written. Dropping the preview there leaves a bare row.
    const view = await renderTranscript({
      events: [
        started("write"),
        delta('{"path":"notes.txt","content":"Rivers meander"}'),
        called("write", { path: "notes.txt", content: "Rivers meander" }),
      ],
      running: true,
    });
    const tool = toolRow(view);
    expect(tool?.state).toBe("running");
    expect(tool?.streamingContent).toContain("Rivers meander");
  });

  it("shows the command a hook rewrote, not the one the model wrote", async () => {
    // MEASURED: `tool-input-updated` (the rewrite that will run) precedes
    // `tool-call` (the model's original), so the raw one lands last.
    const view = await renderTranscript({
      events: [
        started("bash"),
        { type: "tool-input-updated", data: { toolCallId: "t1", toolName: "bash", input: { command: "rtk read poem.txt" } } },
        called("bash", { command: "cat poem.txt" }),
      ],
      running: true,
    });
    expect(toolRow(view)?.summary).toBe("rtk read poem.txt");
  });
});

describe("a call that failed", () => {
  it("reads the error rather than rendering empty braces", async () => {
    // `JSON.stringify(new Error("EACCES: permission denied"))` is `{}` — which
    // is exactly what a failed write used to show. loop's RPC server now
    // flattens the Error before it crosses the wire.
    const view = await renderTranscript({
      events: [
        started("write"),
        called("write", { path: "/etc/hosts", content: "x" }),
        {
          type: "tool-error",
          data: {
            toolCallId: "t1",
            toolName: "write",
            error: { name: "Error", message: "EACCES: permission denied, open '/etc/hosts'", code: "EACCES" },
          },
        },
      ],
      running: true,
    });
    const tool = toolRow(view);
    expect(tool?.state).toBe("error");
    expect(tool?.output).toContain("EACCES: permission denied");
  });
});

describe("hook output", () => {
  it("renders as its own row, in the order it happened", async () => {
    // A hook that rewrites or refuses a call speaks to the USER, and dropping
    // the event left the turn looking like it had misbehaved on its own.
    const view = await renderTranscript({
      events: [
        started("write"),
        called("write", { path: "a.ts", content: "x" }),
        { type: "hook-message", data: "prettier rewrote a.ts" },
        result("wrote 1 line"),
      ],
      running: true,
    });
    expect(view.shape).toEqual([
      "tool write a.ts",
      "hook prettier rewrote a.ts",
    ]);
  });
});
