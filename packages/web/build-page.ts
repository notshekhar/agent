/** Bundle the browser app and inline it (with styles) into the HTML
 * template — the single self-contained page `loop serve` responds with.
 * Shared by this package's build (standalone artifact) and Core's build
 * (baked in via define). */
import { join } from "node:path";

const src = join(import.meta.dir, "src");

export async function buildPage(): Promise<string> {
    const result = await Bun.build({
        entrypoints: [join(src, "main.ts")],
        target: "browser",
        format: "iife",
        minify: true,
    });
    if (!result.success) {
        throw new Error(`web UI bundle failed:\n${result.logs.map((l) => l.message).join("\n")}`);
    }
    const [template, styles, script] = await Promise.all([
        Bun.file(join(src, "index.html")).text(),
        Bun.file(join(src, "styles.css")).text(),
        result.outputs[0]!.text(),
    ]);
    return template
        .replace("<!-- styles injected by build.ts -->", `<style>${styles}</style>`)
        .replace("<!-- script injected by build.ts -->", `<script>${script}</script>`);
}
