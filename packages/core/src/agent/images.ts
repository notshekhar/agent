/**
 * Attachment detection in user input: image files and PDFs.
 * Looks for paths to supported files in the message text, reads them, and
 * returns ai-sdk `file` content blocks plus the cleaned-up text. Whether a
 * given model may actually receive them is the caller's job — see
 * filterAttachmentsByModalities (turn.ts) and the TUI's drop gate.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|pdf)\b/i;
// Sentinel form inserted by paste/Ctrl+I/Ctrl+V/`/attach`. Always preferred
// because a leading "/" path otherwise collides with slash commands.
const BRACKET_RE = /\[image:([^\]]+\.(?:png|jpe?g|gif|webp|bmp|pdf))\]/gi;
// Bare-path forms (drag-and-drop on terminals that forward path text):
//   /abs/foo.png   ./rel.png  ../rel.png   ~/foo.png
//   'foo bar.png'  "foo bar.png"
//   foo\ bar.png
const PATH_RE =
    /(?:'([^']+\.(?:png|jpe?g|gif|webp|bmp|pdf))'|"([^"]+\.(?:png|jpe?g|gif|webp|bmp|pdf))"|((?:~|\.{0,2}\/|\/)(?:\\.|[^\s,()'"])+?\.(?:png|jpe?g|gif|webp|bmp|pdf)))/gi;

// file:// URLs (Finder/browser drops on some terminals), percent-encoded.
const FILE_URL_RE = /file:\/\/(\/[^\s'"<>]+?\.(?:png|jpe?g|gif|webp|bmp|pdf))/gi;

export interface ExtractedImages {
    textWithoutPaths: string;
    images: Array<{ data: Buffer; mediaType: string; path: string }>;
}

function mediaTypeFromPath(p: string): string {
    const ext = p.toLowerCase().match(/\.([a-z]+)$/)?.[1];
    switch (ext) {
        case "jpg":
        case "jpeg":
            return "image/jpeg";
        case "gif":
            return "image/gif";
        case "webp":
            return "image/webp";
        case "bmp":
            return "image/bmp";
        case "pdf":
            return "application/pdf";
        case "png":
        default:
            return "image/png";
    }
}

/**
 * Providers whose ai-sdk integration accepts PDFs as INLINE file-part bytes.
 * A catalog "pdf" modality is NOT enough: xAI, for one, lists pdf but its API
 * wants a Files-API reference and the provider throws
 * AI_UnsupportedFunctionalityError on inline data. Images pass everywhere the
 * modality allows; PDFs need modality AND a provider on this list.
 */
const PDF_INLINE_PROVIDERS = new Set(["anthropic", "google", "openai", "bedrock"]);

/**
 * Split extracted attachments into what this model can actually receive and
 * what it can't. Images: catalog modalities must include "image" (unknown
 * modalities allow — don't block on missing info). PDFs: modalities must
 * include "pdf" AND the provider must support inline PDF bytes (see above) —
 * here unknown does NOT allow, because a wrong yes kills the whole turn.
 * Pure, for tests.
 */
export function filterAttachmentsByModalities(
    images: ExtractedImages["images"],
    modalities: string[] | undefined,
    provider?: string,
): { allowed: ExtractedImages["images"]; rejected: ExtractedImages["images"] } {
    const ok = (mediaType: string) => {
        if (mediaType === "application/pdf") {
            if (!provider || !PDF_INLINE_PROVIDERS.has(provider)) return false;
            return !Array.isArray(modalities) || modalities.includes("pdf");
        }
        return !Array.isArray(modalities) || modalities.includes("image");
    };
    return {
        allowed: images.filter((i) => ok(i.mediaType)),
        rejected: images.filter((i) => !ok(i.mediaType)),
    };
}

function expandHome(p: string): string {
    if (p.startsWith("~")) return (process.env.HOME ?? "") + p.slice(1);
    return p;
}

export function extractImagesFromInput(input: string, cwd: string): ExtractedImages {
    const images: ExtractedImages["images"] = [];
    const seen = new Set<string>();
    let cleaned = input;

    // Quick reject if no image extension present
    if (!IMAGE_EXT.test(input)) {
        return { textWithoutPaths: input, images: [] };
    }

    // Whole-input fallback FIRST: a drag-and-drop is nothing but the path, so
    // when the entire input is one path ending in an image extension, take it
    // verbatim — spaces and all. This is what catches macOS screenshot names
    // ("Screenshot 2026-07-15 at 1.23.45 PM.png") pasted WITHOUT shell
    // escaping (Finder copy-paste, terminals that don't escape on drop),
    // which the token-based PATH_RE below cannot safely match inside prose.
    const whole = input.trim();
    if (/^(?:~\/|\.{0,2}\/|\/)/.test(whole) && /\.(?:png|jpe?g|gif|webp|bmp|pdf)$/i.test(whole)) {
        const abs = resolve(cwd, expandHome(whole.replace(/\\(.)/g, "$1")));
        try {
            if (existsSync(abs) && statSync(abs).isFile()) {
                return {
                    textWithoutPaths: "",
                    images: [{ data: readFileSync(abs), mediaType: mediaTypeFromPath(abs), path: abs }],
                };
            }
        } catch {}
    }

    // file:// URLs — decode percent-escapes ("%20" spaces) before resolving.
    for (const m of input.matchAll(FILE_URL_RE)) {
        let decoded: string;
        try {
            decoded = decodeURIComponent(m[1] ?? "");
        } catch {
            continue; // malformed escapes — not a real file URL
        }
        const abs = resolve(cwd, decoded);
        if (seen.has(abs)) continue;
        seen.add(abs);
        if (!existsSync(abs)) continue;
        try {
            if (!statSync(abs).isFile()) continue;
            images.push({ data: readFileSync(abs), mediaType: mediaTypeFromPath(abs), path: abs });
            cleaned = cleaned.split(m[0]).join("");
        } catch {}
    }

    // [image:/path/to/foo.png] — sentinel form. We keep the bracketed token in
    // the text so the transcript is readable; only read bytes here.
    for (const m of input.matchAll(BRACKET_RE)) {
        const captured = m[1];
        if (!captured) continue;
        const abs = resolve(cwd, expandHome(captured));
        if (seen.has(abs)) continue;
        seen.add(abs);
        if (!existsSync(abs)) continue;
        try {
            if (!statSync(abs).isFile()) continue;
            const data = readFileSync(abs);
            images.push({ data, mediaType: mediaTypeFromPath(abs), path: abs });
        } catch {}
    }

    for (const m of input.matchAll(PATH_RE)) {
        const matchedText = m[0];
        // Capture group 1: single-quoted, 2: double-quoted, 3: bare/escaped
        const captured = m[1] ?? m[2] ?? m[3];
        if (!captured) continue;
        // Unescape backslash-escaped chars (drag-and-drop produces "foo\ bar.png")
        const unescaped = captured.replace(/\\(.)/g, "$1");
        const abs = resolve(cwd, expandHome(unescaped));
        if (seen.has(abs)) continue;
        seen.add(abs);
        if (!existsSync(abs)) continue;
        try {
            if (!statSync(abs).isFile()) continue;
            const data = readFileSync(abs);
            images.push({ data, mediaType: mediaTypeFromPath(abs), path: abs });
            cleaned = cleaned.split(matchedText).join("");
        } catch {}
    }

    cleaned = cleaned.replace(/[ \t]{2,}/g, " ").trim();
    return { textWithoutPaths: cleaned, images };
}
