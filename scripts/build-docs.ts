/**
 * Renders site/docs/*.md into static HTML pages under site/docs/.
 *
 * The site has no build step and no dependencies, and the docs shouldn't
 * change that: this is a small CommonMark subset (the subset the docs
 * actually use) rendered to plain HTML at deploy time, so the published
 * pages need no JavaScript and no CDN. Authoring stays in markdown.
 *
 * Page order and titles come from the `<!-- title: ... -->` and
 * `<!-- order: N -->` comments at the top of each source file, so adding a
 * page is dropping a .md in the directory.
 *
 * Run: bun scripts/build-docs.ts   (the pages workflow runs it before upload)
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(HERE, "..", "site", "docs");

// ---------------------------------------------------------------- markdown --

/** HTML-escape. Applied to every text run before any markup is added. */
function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Inline markup. Code spans are extracted first and restored last so their
 * contents can never be re-parsed as emphasis or links — `**` inside a code
 * span is two asterisks, not bold. The placeholder is NUL-delimited because
 * no source text can contain a NUL, so a bare number in prose ("64 bytes")
 * can never be mistaken for a slot.
 */
function inline(src: string): string {
    const spans: string[] = [];
    let text = src.replace(/`([^`]+)`/g, (_m, code: string) => {
        spans.push(`<code>${esc(code)}</code>`);
        return `\u0000${spans.length - 1}\u0000`;
    });

    text = esc(text);
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
        // Only the schemes a doc page has any business linking to.
        const safe = /^(https?:|mailto:|#|\.\/|[a-z0-9-]+\.html)/i.test(href);
        return safe ? `<a href="${href}">${label}</a>` : label;
    });
    text = text.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    text = text.replace(/(^|[\s(])_([^_]+)_(?=[\s.,)]|$)/g, "$1<i>$2</i>");
    // Backslash escapes, resolved after the markup they were there to suppress.
    text = text.replace(/\\([\\`*_|[\]])/g, "$1");

    return text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => spans[Number(i)]!);
}

/** A slug for heading anchors — stable across builds, used by the on-page nav. */
function slug(text: string): string {
    return text
        .toLowerCase()
        .replace(/`/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}

interface Heading {
    level: number;
    text: string;
    id: string;
}

interface Rendered {
    html: string;
    headings: Heading[];
}

/** Block-level render. Line-driven; every branch consumes at least one line. */
function markdown(src: string): Rendered {
    const lines = src.replace(/\r\n/g, "\n").split("\n");
    const out: string[] = [];
    const headings: Heading[] = [];
    let i = 0;

    const isBlank = (s: string) => s.trim() === "";

    while (i < lines.length) {
        const line = lines[i]!;

        if (isBlank(line) || line.startsWith("<!--")) {
            i++;
            continue;
        }

        // Fenced code. The info string picks up nothing — highlighting would
        // need a lexer per language, and these blocks are shell and JSON.
        if (line.startsWith("```")) {
            const body: string[] = [];
            i++;
            while (i < lines.length && !lines[i]!.startsWith("```")) body.push(lines[i++]!);
            i++; // closing fence
            out.push(`<pre class="code"><code>${esc(body.join("\n"))}</code></pre>`);
            continue;
        }

        const heading = line.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
            const level = heading[1]!.length;
            const text = heading[2]!.trim();
            const id = slug(text);
            // h1 is the page title, rendered by the shell; only h2/h3 are
            // deep-linked, and only h2 reaches the sidebar.
            if (level > 1) headings.push({ level, text, id });
            out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
            i++;
            continue;
        }

        if (/^(---|\*\*\*)\s*$/.test(line)) {
            out.push("<hr />");
            i++;
            continue;
        }

        // Table: a header row followed by a delimiter row.
        if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]!)) {
            // Cells split on unescaped pipes only, and `\|` becomes a literal
            // pipe — a cell documenting `a|b` syntax has no other way to say so.
            const cells = (row: string) =>
                row
                    .trim()
                    .replace(/^\||\|$/g, "")
                    .split(/(?<!\\)\|/)
                    .map((c) => c.trim().replace(/\\\|/g, "|"));
            const head = cells(line);
            i += 2;
            const rows: string[][] = [];
            while (i < lines.length && lines[i]!.includes("|") && !isBlank(lines[i]!)) rows.push(cells(lines[i++]!));
            const th = head.map((c) => `<th>${inline(c)}</th>`).join("");
            const tb = rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("");
            out.push(`<div class="tablewrap"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`);
            continue;
        }

        if (line.startsWith("> ")) {
            const body: string[] = [];
            while (i < lines.length && lines[i]!.startsWith("> ")) body.push(lines[i++]!.slice(2));
            out.push(`<blockquote>${inline(body.join(" "))}</blockquote>`);
            continue;
        }

        const bullet = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (bullet) {
            const list = renderList(lines, i, bullet[1]!.length, /^\d/.test(bullet[2]!));
            out.push(list.html);
            i = list.next;
            continue;
        }

        // Paragraph: everything up to a blank line or the start of another block.
        const para: string[] = [];
        while (i < lines.length && !isBlank(lines[i]!) && !/^(#{1,4}\s|```|>\s|\s*([-*]|\d+\.)\s)/.test(lines[i]!)) {
            para.push(lines[i++]!);
        }
        if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
        else i++; // defensive: never spin on a line no branch claimed
    }

    return { html: out.join("\n"), headings };
}

/**
 * One list, possibly nested. `depth` is the indent (in spaces) items at this
 * level start at; a deeper indent recurses, a shallower one ends the list.
 * Returns the line index it stopped at so the caller resumes there.
 */
function renderList(lines: string[], from: number, depth: number, ordered: boolean): { html: string; next: number } {
    let i = from;
    const items: string[] = [];

    while (i < lines.length) {
        const m = lines[i]!.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (!m) {
            // A blank line inside a list is allowed if another item follows.
            if (lines[i]!.trim() === "" && /^\s*([-*]|\d+\.)\s+/.test(lines[i + 1] ?? "")) {
                i++;
                continue;
            }
            break;
        }
        const indent = m[1]!.length;
        if (indent < depth) break;
        if (indent > depth) {
            const nested = renderList(lines, i, indent, /^\d/.test(m[2]!));
            i = nested.next;
            // Nest inside the item that opened it rather than as a sibling.
            if (items.length) items[items.length - 1] += nested.html;
            else items.push(nested.html);
            continue;
        }
        items.push(inline(m[3]!));
        i++;
    }

    const tag = ordered ? "ol" : "ul";
    return { html: `<${tag}>${items.map((it) => `<li>${it}</li>`).join("")}</${tag}>`, next: i };
}

// -------------------------------------------------------------------- pages --

interface Page {
    file: string;
    out: string;
    title: string;
    blurb: string;
    order: number;
    body: string;
    headings: Heading[];
}

function meta(src: string, key: string): string | undefined {
    return src.match(new RegExp(`^<!--\\s*${key}:\\s*(.+?)\\s*-->`, "m"))?.[1];
}

function loadPages(): Page[] {
    return readdirSync(DOCS_DIR)
        .filter((f) => f.endsWith(".md"))
        .map((file) => {
            const src = readFileSync(join(DOCS_DIR, file), "utf8");
            const { html, headings } = markdown(src);
            return {
                file,
                out: file.replace(/\.md$/, ".html"),
                title: meta(src, "title") ?? src.match(/^#\s+(.*)$/m)?.[1] ?? file,
                blurb: meta(src, "blurb") ?? "",
                order: Number(meta(src, "order") ?? 999),
                body: html,
                headings,
            };
        })
        .sort((a, b) => a.order - b.order || a.file.localeCompare(b.file));
}

const STYLE = `
:root {
  --bg:#16181a; --raised:#1c1f21; --line:#2a2e31; --text:#d4d4d4;
  --muted:#808080; --dim:#505050; --accent:#8abeb7; --green:#b5bd68;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace;
}
*,*::before,*::after { box-sizing:border-box; }
html { -webkit-text-size-adjust:100%; scroll-padding-top:2rem; }
body {
  margin:0; background:var(--bg); color:var(--text); font-family:var(--mono);
  font-size:15px; line-height:1.7; font-variant-ligatures:none; -webkit-font-smoothing:antialiased;
}
a { color:var(--accent); text-decoration:none; }
a:hover { text-decoration:underline; text-underline-offset:3px; }
:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }

.nav {
  display:flex; flex-wrap:wrap; align-items:baseline; justify-content:space-between; gap:1rem;
  max-width:82rem; margin:0 auto; padding:1.75rem clamp(1.25rem,4vw,2.5rem);
  font-size:13px; color:var(--muted);
}
.nav b { color:var(--text); font-weight:600; }
.nav .here { color:var(--dim); }

.shell {
  display:grid; grid-template-columns:19rem minmax(0,1fr);
  gap:0 clamp(2rem,5vw,4rem);
  max-width:82rem; margin:0 auto; padding:0 clamp(1.25rem,4vw,2.5rem) 6rem;
  align-items:start;
}

/* The sidebar sticks on wide screens; on narrow ones it collapses into a
   plain block above the content rather than a drawer needing JS. */
.side { position:sticky; top:1.5rem; border-inline-end:1px solid var(--line); padding-inline-end:1.5rem; }
.side h2 { font-size:11px; letter-spacing:.18em; text-transform:uppercase; color:var(--dim); margin:1.75rem 0 .75rem; font-weight:400; }
.side h2:first-child { margin-top:.5rem; }
.side ul { list-style:none; margin:0; padding:0; }
.side li { margin:0 0 .1rem; }
.side a { display:block; padding:.28rem .6rem; font-size:13px; color:var(--muted); border-left:2px solid transparent; }
.side a:hover { color:var(--accent); text-decoration:none; background:var(--raised); }
.side a.on { color:var(--accent); border-left-color:var(--accent); background:var(--raised); }
.side .sub a { padding-left:1.5rem; font-size:12.5px; color:var(--dim); }
.side .sub a:hover { color:var(--muted); }
/* Must follow the .side .sub a rule above: equal specificity, so source order
   decides, and otherwise the section you're reading keeps the dim colour. */
.side .sub a.on { color:var(--accent); border-left-color:var(--accent); background:var(--raised); }

.doc { min-width:0; padding-top:.5rem; max-width:74ch; }
.doc h1 { font-size:clamp(1.8rem,4.5vw,2.4rem); letter-spacing:-.03em; margin:0 0 .4rem; font-weight:700; }
.doc .blurb { margin:0 0 2.5rem; color:var(--muted); font-size:13.5px; }
.doc h2 {
  font-size:1.15rem; letter-spacing:-.01em; margin:3rem 0 1rem; font-weight:600;
  padding-top:1.25rem; border-top:1px solid var(--line);
}
.doc h3 { font-size:.95rem; color:var(--accent); margin:2rem 0 .6rem; font-weight:600; }
.doc h4 { font-size:.9rem; color:var(--text); margin:1.5rem 0 .5rem; font-weight:600; }
.doc p { margin:0 0 1.1rem; }
.doc ul, .doc ol { margin:0 0 1.1rem; padding-left:1.4rem; }
.doc li { margin:0 0 .45rem; }
.doc li > ul, .doc li > ol { margin:.45rem 0 .2rem; }
.doc hr { border:none; border-top:1px solid var(--line); margin:2.5rem 0; }
.doc blockquote {
  margin:0 0 1.1rem; padding:.9rem 1.2rem; color:var(--muted); font-size:13.5px;
  border:1px solid var(--line); border-left:2px solid var(--accent); background:var(--raised);
}
code { border:1px solid var(--line); background:var(--raised); color:var(--text); padding:.05em .4em; font-size:12.5px; }
pre.code {
  margin:0 0 1.35rem; padding:1rem 1.1rem; border:1px solid var(--line); background:var(--raised);
  overflow-x:auto; font-size:12.5px; line-height:1.6; scrollbar-width:thin;
}
pre.code code { border:none; background:none; padding:0; font-size:inherit; }
.tablewrap { overflow-x:auto; margin:0 0 1.35rem; scrollbar-width:thin; }
table { border-collapse:collapse; font-size:13px; min-width:100%; }
th, td { text-align:left; padding:.55rem .9rem; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--dim); font-weight:400; font-size:11.5px; letter-spacing:.06em; text-transform:uppercase; white-space:nowrap; }
td code { white-space:nowrap; }

.pager { display:flex; justify-content:space-between; gap:1rem; margin-top:4rem; padding-top:1.5rem; border-top:1px solid var(--line); font-size:13px; }
.pager span { color:var(--dim); }

.foot { border-top:1px solid var(--line); margin-top:4rem; padding:1.75rem clamp(1.25rem,4vw,2.5rem) 4rem; font-size:12.5px; color:var(--dim); max-width:82rem; margin-inline:auto; }
.foot a { color:var(--muted); }

@media (max-width:900px) {
  .shell { grid-template-columns:minmax(0,1fr); gap:2.5rem 0; }
  .side { position:static; border-inline-end:none; border-bottom:1px solid var(--line); padding-inline-end:0; padding-bottom:1.5rem; }
  .side .sub { display:none; }
}
`.trim();

/**
 * Marks the section you're reading in the sidebar. The page is fully readable
 * without it — this only ever adds a highlight — so it stays a progressive
 * enhancement rather than something the content depends on.
 */
const SCROLLSPY = `<script>
(function () {
  "use strict";

  var links = Array.prototype.slice.call(document.querySelectorAll(".side .sub a"));
  var sections = links
    .map(function (a) { return { link: a, el: document.getElementById(a.hash.slice(1)) }; })
    .filter(function (s) { return s.el; });
  if (!sections.length) return;

  var current = null;

  function sync() {
    /* The section that owns the top of the viewport: the last heading at or
       above the read line, so one stays lit until the next one reaches it. */
    var line = 140;
    var active = sections[0];
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].el.getBoundingClientRect().top <= line) active = sections[i];
    }
    /* A short last section can't be scrolled up to the line — at the bottom of
       the page, award it explicitly or it would never light up. */
    var doc = document.documentElement;
    if (window.innerHeight + window.scrollY >= doc.scrollHeight - 2) {
      active = sections[sections.length - 1];
    }
    if (active === current) return;
    if (current) {
      current.link.classList.remove("on");
      current.link.removeAttribute("aria-current");
    }
    active.link.classList.add("on");
    active.link.setAttribute("aria-current", "location");
    current = active;
  }

  /* Scroll fires far faster than the highlight can change; collapse a burst
     into one measurement per frame so reading never fights layout. */
  var queued = false;
  function onScroll() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; sync(); });
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  window.addEventListener("hashchange", onScroll);
  sync();
})();
</script>`;

function sidebar(pages: Page[], current: Page): string {
    const items = pages
        .map((p) => {
            const on = p === current;
            const link = `<li><a href="${p.out}"${on ? ' class="on" aria-current="page"' : ""}>${esc(p.title)}</a></li>`;
            // Only the page you're on expands into its own sections — a full
            // tree of every heading in the guide is noise, not navigation.
            if (!on) return link;
            const subs = p.headings
                .filter((h) => h.level === 2)
                .map((h) => `<li><a href="#${h.id}">${esc(h.text)}</a></li>`)
                .join("");
            return subs ? `${link}<li><ul class="sub">${subs}</ul></li>` : link;
        })
        .join("");
    return `<nav class="side" aria-label="Documentation"><h2>Guide</h2><ul>${items}</ul></nav>`;
}

function pager(pages: Page[], current: Page): string {
    const idx = pages.indexOf(current);
    const prev = pages[idx - 1];
    const next = pages[idx + 1];
    return `<div class="pager">
  ${prev ? `<a href="${prev.out}">← ${esc(prev.title)}</a>` : "<span></span>"}
  ${next ? `<a href="${next.out}">${esc(next.title)} →</a>` : "<span></span>"}
</div>`;
}

function page(pages: Page[], p: Page): string {
    const desc = p.blurb || `${p.title} — loop documentation.`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(p.title)} — loop docs</title>
<meta name="description" content="${esc(desc)}" />
<meta property="og:title" content="${esc(p.title)} — loop docs" />
<meta property="og:description" content="${esc(desc)}" />
<meta property="og:type" content="article" />
<meta property="og:url" content="__SITE_URL__/docs/${p.out}" />
<meta property="og:site_name" content="loop" />
<meta property="og:image" content="__SITE_URL__/og.png" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="theme-color" content="#16181a" />
<link rel="icon" href="../favicon.svg" type="image/svg+xml" />
<link rel="icon" href="../favicon-32.png" sizes="32x32" type="image/png" />
<link rel="alternate icon" href="../favicon.ico" sizes="48x48 32x32 16x16" />
<link rel="apple-touch-icon" href="../apple-touch-icon.png" />
<style>
${STYLE}
</style>
</head>
<body>

<nav class="nav">
  <span><a href="../"><b>loop</b></a> <span class="here">/ docs</span></span>
  <a href="https://github.com/notshekhar/loop">github.com/notshekhar/loop</a>
</nav>

<div class="shell">
${sidebar(pages, p)}
  <main class="doc">
    <h1>${esc(p.title)}</h1>
    ${p.blurb ? `<p class="blurb">${inline(p.blurb)}</p>` : ""}
${p.body}
${pager(pages, p)}
  </main>
</div>

<footer class="foot">
  <p>MIT licensed · <a href="https://github.com/notshekhar/loop">github.com/notshekhar/loop</a> · <a href="../">home</a></p>
</footer>

${SCROLLSPY}

</body>
</html>
`;
}

function main() {
    const pages = loadPages();
    if (!pages.length) throw new Error(`no .md sources in ${DOCS_DIR}`);
    for (const p of pages) writeFileSync(join(DOCS_DIR, p.out), page(pages, p));
    console.log(`built ${pages.length} doc page(s) → ${DOCS_DIR}`);
}

main();
