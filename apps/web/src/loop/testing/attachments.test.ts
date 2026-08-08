/**
 * What a message with attachments looks like once it comes back off disk.
 *
 * loop's transcript stores the sentinel, not the picture: the RPC server writes
 * each attachment to a temp file and appends `[image:<path>]` to the input, and
 * `runTurn` persists that input verbatim. Everything here is about the seam
 * between that and a GUI that has to draw a bubble.
 */
import { describe, expect, it } from "vite-plus/test";

import { renderTranscript } from "./renderTranscript.ts";

const userEntry = (text: string) => ({
  type: "message",
  role: "user",
  content: text,
  ts: 1_700_000_001_000,
  id: "u1",
});

describe("a replayed message with attachments", () => {
  it("does not render loop's sentinel as prose", async () => {
    const view = await renderTranscript({
      history: [userEntry("look at this\n[image:/var/folders/x/loop-attach-9f2c.png]")],
    });
    const user = view.rows.find((row) => row.kind === "message" && row.message.role === "user");
    const message = user?.kind === "message" ? user.message : undefined;

    expect(message?.text).toBe("look at this");
    expect(message?.text).not.toContain("[image:");
  });

  it("carries the attachment through as a named chip", async () => {
    const view = await renderTranscript({
      history: [userEntry("two of them\n[image:/tmp/a.png]\n[image:/tmp/spec.pdf]")],
    });
    const user = view.rows.find((row) => row.kind === "message" && row.message.role === "user");
    const message = user?.kind === "message" ? user.message : undefined;

    expect(message?.attachments).toEqual([
      { type: "image", id: "attachment-0", name: "a.png", mimeType: "image/png", sizeBytes: 0 },
      {
        type: "file",
        id: "attachment-1",
        name: "spec.pdf",
        mimeType: "application/pdf",
        sizeBytes: 0,
      },
    ]);
  });

  it("keeps a message that is nothing but an attachment", async () => {
    // An image pasted with no words is an ordinary way to ask a question, and
    // a text-only emptiness check would have dropped the whole message.
    const view = await renderTranscript({ history: [userEntry("\n[image:/tmp/only.png]")] });
    const user = view.rows.find((row) => row.kind === "message" && row.message.role === "user");
    const message = user?.kind === "message" ? user.message : undefined;

    expect(message?.text).toBe("");
    expect(message?.attachments).toHaveLength(1);
  });

  it("leaves a message with no attachments untouched", async () => {
    const view = await renderTranscript({ history: [userEntry("just words")] });
    const user = view.rows.find((row) => row.kind === "message" && row.message.role === "user");
    const message = user?.kind === "message" ? user.message : undefined;

    expect(message?.text).toBe("just words");
    expect(message?.attachments).toBeUndefined();
  });
});
