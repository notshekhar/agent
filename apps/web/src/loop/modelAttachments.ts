/**
 * What a model will actually accept as an attachment.
 *
 * Ported from `packages/core/src/agent/images.ts`
 * (`filterAttachmentsByModalities` + `PDF_INLINE_PROVIDERS`). **KEEP IN SYNC.**
 * It is duplicated rather than imported because core is a Bun/node package the
 * renderer cannot load, and duplicated rather than asked for over RPC because
 * the composer needs the answer on every keystroke of a paste.
 *
 * The rule core enforces, and therefore the rule the UI must show:
 *
 *   - **Images** need the catalog to list an `image` input modality. Missing
 *     modality information ALLOWS — a model loop knows nothing about should not
 *     be assumed blind, and core does not assume it either.
 *   - **PDFs** need the same modality treatment for `pdf` AND a provider whose
 *     ai-sdk integration takes inline PDF bytes. The provider half is the part
 *     that refuses on missing information: xAI advertises pdf and then throws
 *     `AI_UnsupportedFunctionalityError` on inline data, so a provider nobody
 *     can name is a no rather than a guess — a wrong yes kills the whole turn
 *     instead of dropping one attachment.
 *
 * This is only the gate the composer draws with. core re-runs the same decision
 * on the bytes it receives, so a stale capability here can never send a model
 * something it cannot read — it can only offer, or fail to offer, the affordance.
 */

/**
 * Providers whose ai-sdk integration accepts PDFs as INLINE file-part bytes.
 * Mirrors core's `PDF_INLINE_PROVIDERS`.
 */
const PDF_INLINE_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  "google",
  "openai",
  "bedrock",
]);

export interface ModelAttachmentSupport {
  /** png/jpeg/gif/webp/bmp may be attached. */
  readonly image: boolean;
  /** PDFs may be attached. */
  readonly file: boolean;
}

export const NO_ATTACHMENT_SUPPORT: ModelAttachmentSupport = { image: false, file: false };

/**
 * Resolve support from a catalog entry's input modalities and its provider id.
 *
 * `modalities` is `undefined` for a model loop has no catalog entry for — a
 * custom endpoint, or one added by an extension without declaring any. That is
 * the "allow images, refuse PDFs" case above, not a reason to disable attaching.
 */
export function resolveModelAttachmentSupport(
  modalities: readonly string[] | undefined,
  provider: string | undefined,
): ModelAttachmentSupport {
  const image = !Array.isArray(modalities) || modalities.includes("image");
  const file =
    provider !== undefined &&
    PDF_INLINE_PROVIDERS.has(provider) &&
    (!Array.isArray(modalities) || modalities.includes("pdf"));
  return { image, file };
}

/**
 * The exact media types loop can write to disk for a turn — core's
 * `ATTACHMENT_EXT_BY_TYPE` (`packages/core/src/rpc/server.ts`). Anything else
 * is dropped there with no message, so the composer refuses it here instead.
 */
const SUPPORTED_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

/**
 * Whether a dropped or pasted file was *meant* as an attachment, regardless of
 * the model.
 *
 * This is the claim test, kept separate from the accept test on purpose: a PNG
 * dropped on a text-only model has to be claimed so the composer can say why it
 * cannot be attached. Letting it fall through to the editor instead is a
 * silent no-op — a clipboard file leaves no text behind — and silently doing
 * nothing is the failure this whole change is about.
 */
export function isAttachableFileKind(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase();
  return normalized.startsWith("image/") || normalized === "application/pdf";
}

/**
 * Whether a file may be attached, and why not when it may not.
 *
 * The reason is worth carrying: "this model cannot read images" and "loop
 * cannot attach a .docx to anything" are different problems for the user, and
 * a single "unsupported file" message leaves them guessing which one they hit.
 */
export type AttachmentRejection = "model-no-image" | "model-no-file" | "unsupported-type";

export function classifyAttachment(
  mimeType: string,
  support: ModelAttachmentSupport,
): { readonly ok: true } | { readonly ok: false; readonly reason: AttachmentRejection } {
  const normalized = mimeType.toLowerCase();
  if (normalized.startsWith("image/")) {
    if (!SUPPORTED_IMAGE_MIME_TYPES.has(normalized)) {
      return { ok: false, reason: "unsupported-type" };
    }
    return support.image ? { ok: true } : { ok: false, reason: "model-no-image" };
  }
  if (normalized === "application/pdf") {
    return support.file ? { ok: true } : { ok: false, reason: "model-no-file" };
  }
  return { ok: false, reason: "unsupported-type" };
}

/** One sentence for the user, given what the model does take. */
export function describeAttachmentRejection(
  reason: AttachmentRejection,
  fileName: string,
  modelName: string,
  support: ModelAttachmentSupport,
): string {
  switch (reason) {
    case "model-no-image":
      return `${modelName} cannot read images. Switch to a model that supports images to attach '${fileName}'.`;
    case "model-no-file":
      return `${modelName} cannot read PDFs. Switch to a model that supports files to attach '${fileName}'.`;
    case "unsupported-type":
      return support.file
        ? `'${fileName}' cannot be attached. Attach images or PDFs.`
        : `'${fileName}' cannot be attached. Attach images.`;
  }
}
