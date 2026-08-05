/**
 * The transcript-to-conversation mapping.
 *
 * These run against synthetic loop payloads on purpose. Two of the three
 * mappings are impractical to prove against a live provider: the `plan` tool
 * only fires when a model decides to propose a plan, and reasoning text comes
 * back ENCRYPTED from several providers (`text: ""` plus an opaque
 * `reasoningEncryptedContent`), so a live turn can legitimately produce no
 * visible thinking at all. Pinning them here is the only way to know the
 * mapping is right rather than merely untriggered.
 */
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { buildThread } from "./thread.ts";

const globals = globalThis as { window?: Window & typeof globalThis };
const SESSION = "01SESSION";

const info = {
  cwd: "/w/project",
  provider: "kimi",
  model: "kimi/k3",
  createdAt: 1_700_000_000_000,
};

async function threadOf(entries: readonly unknown[], running = false) {
  const hadWindow = globals.window !== undefined;
  globals.window ??= globals as unknown as Window & typeof globalThis;
  const previous = window.loop;
  window.loop = {
    call: (method) =>
      method === "session.history"
        ? Promise.resolve({ sessionId: SESSION, info, entries, seq: entries.length, running })
        : Promise.resolve({}),
    onEvent: () => () => {},
    anchorCwd: () => Promise.resolve(undefined),
  };
  try {
    return await Effect.runPromise(buildThread(SESSION));
  } finally {
    if (previous === undefined) delete window.loop;
    else window.loop = previous;
    if (!hadWindow) delete globals.window;
  }
}

const userEntry = (text: string, id = "u1") => ({
  type: "message",
  role: "user",
  content: text,
  ts: 1_700_000_001_000,
  id,
});

describe("a loop transcript as a conversation", () => {
  it("keeps the user's text and the assistant's reply in order", async () => {
    const thread = await threadOf([
      userEntry("what is 12*13?"),
      {
        type: "message",
        role: "assistant",
        id: "a1",
        ts: 1_700_000_002_000,
        content: [{ type: "text", text: "156" }],
      },
    ]);
    expect(thread.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "what is 12*13?"],
      ["assistant", "156"],
    ]);
    expect(thread.projectId).toBe("/w/project");
  });

  it("renders loop's plan tool call as a proposed plan, not a tool row", async () => {
    // This is the whole reason the plan card needs no new loop protocol:
    // `input.plan` already IS the markdown document the card renders.
    const planMarkdown = "# Plan\n\n1. Do the thing\n2. Verify it";
    const thread = await threadOf([
      userEntry("plan this"),
      {
        type: "message",
        role: "assistant",
        id: "a1",
        ts: 1_700_000_002_000,
        content: [
          { type: "tool-call", toolName: "plan", toolCallId: "call-1", input: { plan: planMarkdown } },
        ],
      },
    ]);
    expect(thread.proposedPlans).toHaveLength(1);
    expect(thread.proposedPlans[0]?.planMarkdown).toBe(planMarkdown);
    expect(thread.activities.filter((a) => a.kind.startsWith("tool."))).toHaveLength(0);
  });

  it("renders reasoning as the kind the work log shows as thinking", async () => {
    const thread = await threadOf([
      userEntry("think"),
      {
        type: "message",
        role: "assistant",
        id: "a1",
        ts: 1_700_000_002_000,
        content: [
          { type: "reasoning", text: "Considering the options." },
          { type: "text", text: "Done." },
        ],
      },
    ]);
    const thinking = thread.activities.filter((a) => a.kind === "task.progress");
    expect(thinking).toHaveLength(1);
    expect((thinking[0]?.payload as { detail?: string }).detail).toBe("Considering the options.");
  });

  it("drops reasoning parts the provider returned encrypted", async () => {
    // Measured against a real kimi transcript: the part is present but its
    // text is empty, with the content in an opaque providerOptions field.
    // An empty thinking row is noise, so it must not be emitted.
    const thread = await threadOf([
      userEntry("think"),
      {
        type: "message",
        role: "assistant",
        id: "a1",
        ts: 1_700_000_002_000,
        content: [
          { type: "reasoning", text: "", providerOptions: { openai: { reasoningEncryptedContent: "gAAA" } } },
          { type: "text", text: "Done." },
        ],
      },
    ]);
    expect(thread.activities.filter((a) => a.kind === "task.progress")).toHaveLength(0);
  });

  it("attaches a tool's result to the row that called it", async () => {
    const thread = await threadOf([
      userEntry("run it"),
      {
        type: "message",
        role: "assistant",
        id: "a1",
        ts: 1_700_000_002_000,
        content: [
          {
            type: "tool-call",
            toolName: "bash",
            toolCallId: "call-1",
            input: { command: "echo hi" },
          },
        ],
      },
      {
        type: "message",
        role: "tool",
        id: "t1",
        ts: 1_700_000_003_000,
        content: [{ type: "tool-result", toolCallId: "call-1", output: { type: "text", value: "hi\n" } }],
      },
    ]);
    const tools = thread.activities.filter((a) => a.kind === "tool.bash");
    expect(tools).toHaveLength(1);
    expect(tools[0]?.summary).toBe("bash echo hi");
    // The result replaces the input as the row's detail once it arrives.
    expect((tools[0]?.payload as { detail?: string }).detail).toContain("hi");
  });

  it("reports a running session so the composer shows the turn in flight", async () => {
    const thread = await threadOf([userEntry("go")], true);
    expect(thread.session?.status).toBe("running");
  });

  it("titles a thread from the first thing the user asked", async () => {
    const thread = await threadOf([userEntry("fix the flaky test")]);
    expect(thread.title).toBe("fix the flaky test");
  });
});
