/**
 * The trace page's markdown renderer (src/trace/markdown.ts) is a string of
 * browser JS, so it is exercised here the way the browser does: evaluated
 * against a stub DOM that implements only what it touches, then serialized.
 *
 * The stub's appendChild MOVES a node the way a real one does — the renderer
 * unwraps a single-paragraph list item by draining `p.firstChild` in a loop,
 * and a stub that copied instead of moved would spin forever.
 */
import { describe, expect, test } from "bun:test";
import { TRACE_MD_JS } from "../src/trace/markdown";

class StubNode {
    tag: string;
    nodeName: string;
    children: StubNode[] = [];
    attrs: Record<string, string> = {};
    style: Record<string, string> = {};
    parent: StubNode | null = null;
    own = "";
    private cls = "";

    constructor(tag: string) {
        this.tag = tag;
        this.nodeName = tag.charAt(0) === "#" ? tag : tag.toUpperCase();
    }
    set className(v: string) {
        this.cls = v;
    }
    get className(): string {
        return this.cls;
    }
    get classList() {
        return { add: (c: string) => { this.cls = this.cls ? `${this.cls} ${c}` : c; } };
    }
    setAttribute(k: string, v: string) {
        this.attrs[k] = v;
    }
    set textContent(v: string) {
        this.own = v;
        this.children = [];
    }
    get textContent(): string {
        return this.own + this.children.map((c) => c.textContent).join("");
    }
    removeChild(c: StubNode) {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        c.parent = null;
        return c;
    }
    appendChild(c: StubNode): StubNode {
        if (c.tag === "#frag") {
            for (const k of c.children.slice()) this.appendChild(k);
            c.children.length = 0;
            return c;
        }
        c.parent?.removeChild(c);
        c.parent = this;
        this.children.push(c);
        return c;
    }
    get childNodes() {
        return this.children;
    }
    get firstChild(): StubNode | undefined {
        return this.children[0];
    }
    html(): string {
        if (this.tag === "#text") return this.own;
        if (this.tag === "#frag") return this.children.map((c) => c.html()).join("");
        const cls = this.cls ? ` class="${this.cls}"` : "";
        const attrs = Object.entries(this.attrs)
            .map(([k, v]) => ` ${k}="${v}"`)
            .join("");
        return `<${this.tag}${cls}${attrs}>${this.own}${this.children.map((c) => c.html()).join("")}</${this.tag}>`;
    }
}

/** Evaluate the renderer once against a stub DOM and hand back its globals. */
function loadRenderer() {
    const win: { __mdRender?: (t: string) => StubNode; __mdPlain?: (t: string) => string } = {};
    const doc = {
        createElement: (t: string) => new StubNode(t),
        createTextNode: (s: string) => {
            const n = new StubNode("#text");
            n.own = s;
            return n;
        },
        createDocumentFragment: () => new StubNode("#frag"),
    };
    new Function("window", "document", TRACE_MD_JS)(win, doc);
    return {
        html: (src: string) => win.__mdRender!(src).html(),
        plain: (src: string) => win.__mdPlain!(src),
        /** Node names at the top level, or inside the nth top-level node. */
        nodes: (src: string, nth?: number) => {
            const root = win.__mdRender!(src);
            const level = nth === undefined ? root.children : root.children[nth]!.children;
            return level.map((c) => c.nodeName);
        },
    };
}

const md = loadRenderer();

describe("trace markdown", () => {
    test("paragraphs and inline emphasis", () => {
        expect(md.html("plain **bold** and *slanted* and ~~gone~~")).toBe(
            '<p class="md-p">plain <strong>bold</strong> and <em>slanted</em> and <del>gone</del></p>',
        );
    });

    test("inline code keeps its punctuation literal", () => {
        expect(md.html("call `a **b** c` here")).toContain("<code>a **b** c</code>");
    });

    test("headings opt out of the page's bare-h2 chrome", () => {
        expect(md.html("## Why")).toBe('<h2 class="md-h">Why</h2>');
    });

    test("fenced code carries its language and keeps whitespace", () => {
        const out = md.html(["```ts", "const a = 1;", "  indented", "```"].join("\n"));
        expect(out).toContain('data-lang="ts"');
        expect(out).toContain("const a = 1;\n  indented");
    });

    test("bullet lists render every item, not just the first", () => {
        // the marker-type guard was once inverted, which broke out of the loop
        // on item one and left the cursor where it was — an infinite loop
        const out = md.html("- one\n- two\n- three");
        expect(out.match(/<li/g)?.length).toBe(3);
    });

    test("ordered lists keep their start and do not swallow bullets", () => {
        const out = md.html("3. three\n4. four\n\n- bullet");
        expect(out).toContain('<ol class="md-list" start="3">');
        expect(out).toContain('<ul class="md-list">');
    });

    test("nested lists nest", () => {
        const out = md.html("- outer\n  - inner\n- outer two");
        expect(out).toContain('<ul class="md-list"><li class="md-li">outer<ul class="md-list">');
    });

    test("task items become disabled checkboxes, checked by attribute", () => {
        // an innerHTML round trip in the search highlighter drops properties,
        // so the checked state has to be an attribute
        const out = md.html("- [x] done\n- [ ] todo");
        expect(out).toContain('<input type="checkbox" disabled="" checked="">');
        expect(out).toContain('<input type="checkbox" disabled="">');
    });

    test("tables render a head, a body and per-column alignment", () => {
        const out = md.html(["| a | b |", "| --- | ---: |", "| 1 | 2 |"].join("\n"));
        expect(out).toContain('<div class="md-table-wrap">');
        expect(out).toContain("<th>a</th>");
        expect(out).toContain("<td>1</td>");
    });

    test("blockquotes recurse", () => {
        expect(md.html("> **quoted**")).toBe(
            '<blockquote class="md-quote"><p class="md-p"><strong>quoted</strong></p></blockquote>',
        );
    });

    test("links and bare urls open safely", () => {
        const out = md.html("see [docs](https://example.com/a) and https://example.com/b");
        expect(out).toContain('rel="noreferrer noopener"');
        expect(out).toContain('target="_blank"');
        expect(out).toContain('href="https://example.com/b"');
    });

    test("a javascript: url is inert text, never an anchor", () => {
        const out = md.html("[click](javascript:alert(1))");
        expect(out).not.toContain("<a");
        expect(out).not.toContain("javascript:");
    });

    test("raw html in model output stays a text node", () => {
        // the renderer only ever calls createTextNode / textContent, so markup
        // in model output can never become markup in the page
        const src = "<img src=x onerror=alert(1)> and <b>b</b>";
        expect(md.plain(src)).toBe(src);
        expect(md.nodes(src)).toEqual(["P"]);
        expect(md.nodes(src, 0)).toEqual(["#text"]);
    });

    test("an unclosed link does not blow up the scanner", () => {
        const src = `a ](${"x".repeat(400)}`;
        const t0 = performance.now();
        md.html(src);
        expect(performance.now() - t0).toBeLessThan(500);
    });

    test("plain text is what search matches against", () => {
        expect(md.plain("a **bold** `code` [link](https://x.dev)")).toBe("a bold code link");
    });

    test("empty input renders nothing", () => {
        expect(md.html("")).toBe("");
        expect(md.html("   \n\n  ")).toBe("");
    });
});
