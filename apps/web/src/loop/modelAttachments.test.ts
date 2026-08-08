import { describe, expect, it } from "vite-plus/test";

import {
  classifyAttachment,
  isAttachableFileKind,
  resolveModelAttachmentSupport,
} from "./modelAttachments";

describe("resolveModelAttachmentSupport", () => {
  it("allows images when the catalog says nothing", () => {
    // core's rule: unknown modalities must not block an image, or every custom
    // endpoint and extension-registered model loses attachments it can read.
    expect(resolveModelAttachmentSupport(undefined, "anthropic").image).toBe(true);
  });

  it("still allows a PDF with no modalities, as long as the provider takes inline bytes", () => {
    // Matching core exactly: it is the PROVIDER half that refuses on missing
    // information, not the modality half.
    expect(resolveModelAttachmentSupport(undefined, "anthropic").file).toBe(true);
  });

  it("refuses images on a text-only model", () => {
    expect(resolveModelAttachmentSupport(["text"], "openai")).toEqual({
      image: false,
      file: false,
    });
  });

  it("needs both the pdf modality and a provider that takes inline bytes", () => {
    // xAI advertises pdf and then wants a Files-API reference; anthropic takes
    // the bytes. Same modality list, different answer.
    expect(resolveModelAttachmentSupport(["text", "image", "pdf"], "xai").file).toBe(false);
    expect(resolveModelAttachmentSupport(["text", "image", "pdf"], "anthropic").file).toBe(true);
  });

  it("refuses PDFs for a provider loop cannot name", () => {
    expect(resolveModelAttachmentSupport(["text", "image", "pdf"], undefined).file).toBe(false);
  });
});

describe("classifyAttachment", () => {
  const both = { image: true, file: true };
  const textOnly = { image: false, file: false };

  it("separates 'this model cannot' from 'loop cannot'", () => {
    expect(classifyAttachment("image/png", textOnly)).toEqual({
      ok: false,
      reason: "model-no-image",
    });
    expect(classifyAttachment("application/pdf", { image: true, file: false })).toEqual({
      ok: false,
      reason: "model-no-file",
    });
    // An image kind loop has no extension mapping for: refused whatever the
    // model says, because the RPC server would drop it without a word.
    expect(classifyAttachment("image/svg+xml", both)).toEqual({
      ok: false,
      reason: "unsupported-type",
    });
    expect(classifyAttachment("text/csv", both)).toEqual({
      ok: false,
      reason: "unsupported-type",
    });
  });

  it("accepts what loop can write and the model can read", () => {
    expect(classifyAttachment("image/jpeg", both)).toEqual({ ok: true });
    expect(classifyAttachment("APPLICATION/PDF", both)).toEqual({ ok: true });
  });
});

describe("isAttachableFileKind", () => {
  it("claims anything the user plainly meant to attach, model aside", () => {
    // The claim has to be broader than the accept, or a PNG dropped on a
    // text-only model falls through to the editor and nothing happens at all.
    expect(isAttachableFileKind("image/png")).toBe(true);
    expect(isAttachableFileKind("image/svg+xml")).toBe(true);
    expect(isAttachableFileKind("application/pdf")).toBe(true);
    expect(isAttachableFileKind("text/plain")).toBe(false);
  });
});
