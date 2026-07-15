import { describe, expect, test } from "bun:test";
import { buildPage } from "../build-page";

describe("buildPage", () => {
    test("inlines a parseable script without HTML-comment corruption", async () => {
        const page = await buildPage();
        expect(page).toContain('<div id="overlay">');
        expect(page).not.toContain("injected by build.ts");

        const start = page.indexOf("<script>");
        const end = page.indexOf("</script>", start);
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        const script = page.slice(start + "<script>".length, end);
        expect(script.includes("<!--")).toBe(false);
        // Minified bundles often use `$` as an identifier; a string-form
        // String.replace would turn `$&&` into the HTML comment marker.
        expect(() => new Function(script)).not.toThrow();
    });

    test("string replace would corrupt $&& — function replace must be used", () => {
        const marker = "<!-- script injected by build.ts -->";
        const script = "if(x===$&&!y)";
        const broken = ("PRE" + marker + "POST").replace(marker, `<script>${script}</script>`);
        const fixed = ("PRE" + marker + "POST").replace(marker, () => `<script>${script}</script>`);
        expect(broken).toContain("injected by build.ts");
        expect(fixed).toBe(`PRE<script>${script}</script>POST`);
    });
});
