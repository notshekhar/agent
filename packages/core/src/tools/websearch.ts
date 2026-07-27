/**
 * websearch: DuckDuckGo web search with no API key — scrapes the plain-HTML
 * endpoint (html.duckduckgo.com), which is unofficial and may rate-limit or
 * change markup. Opt-in via the `webSearch` setting (default off); attached
 * conditionally in runTurn like ask/task, so it's not part of createTools.
 * Failures return readable text instead of throwing, like fetch-url.
 */
import { tool } from "ai";
import { z } from "zod";
import { PRODUCT_NAME, REPO_SLUG } from "../brand";

const SEARCH_TIMEOUT_MS = 20_000;
const DEFAULT_RESULTS = 8;
const MAX_RESULTS = 10;

export interface WebsearchToolContext {
    abortSignal?: AbortSignal;
}

export interface WebSearchResult {
    title: string;
    url: string;
    snippet: string;
}

function decodeEntities(s: string): string {
    return s
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'");
}

/** Inner text of a markup fragment: tags dropped, entities decoded, whitespace collapsed. */
function stripTags(s: string): string {
    return decodeEntities(s.replace(/<[^>]+>/g, ""))
        .replace(/\s+/g, " ")
        .trim();
}

/** Resolve a DDG result href — a `//duckduckgo.com/l/?uddg=<encoded>&rut=…`
 * redirect wrapping the real URL — to its target. Direct hrefs pass through. */
function resolveHref(href: string): string {
    const decoded = decodeEntities(href);
    const uddg = /[?&]uddg=([^&]+)/.exec(decoded);
    if (uddg) {
        try {
            return decodeURIComponent(uddg[1]);
        } catch {
            return decoded;
        }
    }
    return decoded.startsWith("//") ? `https:${decoded}` : decoded;
}

/**
 * Parse DDG's HTML SERP into results. Each organic result is a
 * `<div class="result …">` block holding a `result__a` title link (a redirect
 * href, see resolveHref) and a `result__snippet`. Sponsored blocks carry a
 * `result--ad` class and redirect through duckduckgo.com/y.js — both checked,
 * belt and braces, since ads are indistinguishable from organic hits otherwise.
 */
export function parseSearchResults(html: string, limit: number): WebSearchResult[] {
    const out: WebSearchResult[] = [];
    // \b keeps `result__a` / `results_links` from splitting: only the block
    // div's leading `result` class is followed by a non-word char.
    const blocks = html.split(/<div[^>]+class="result\b/).slice(1);
    for (const block of blocks) {
        if (out.length >= limit) break;
        // The rest of the class attribute continues at the chunk start.
        const classRest = block.slice(0, block.indexOf('"'));
        if (classRest.includes("result--ad")) continue;
        const link = /class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
        if (!link) continue;
        const url = resolveHref(link[1]);
        if (/^https?:\/\/(www\.)?duckduckgo\.com\/y\.js/.test(url)) continue;
        const title = stripTags(link[2]);
        if (!title || !url) continue;
        const snip = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
        out.push({ title, url, snippet: snip ? stripTags(snip[1]) : "" });
    }
    return out;
}

/** `1. Title\n   url\n   snippet` per result — compact and link-forward. */
export function formatSearchResults(results: WebSearchResult[]): string {
    return results
        .map((r, i) => [`${i + 1}. ${r.title}`, `   ${r.url}`, ...(r.snippet ? [`   ${r.snippet}`] : [])].join("\n"))
        .join("\n\n");
}

export function createWebsearchTool(ctx: WebsearchToolContext) {
    return tool({
        description: `Search the web (DuckDuckGo). Returns the top results as numbered title/URL/snippet entries. To read a full page, pass its URL to the read tool.`,
        inputSchema: z.object({
            query: z.string().min(1).describe("Search query"),
            limit: z
                .number()
                .int()
                .positive()
                .max(MAX_RESULTS)
                .optional()
                .describe(`Maximum results to return (default ${DEFAULT_RESULTS}, max ${MAX_RESULTS})`),
        }),
        execute: async ({ query, limit }, options) => {
            const parentSignal = options?.abortSignal ?? ctx.abortSignal;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
            const onParentAbort = () => controller.abort();
            // Already-aborted signals never fire their listener — check first,
            // or a cancelled turn still issues the search (see fetch-url.ts).
            if (parentSignal?.aborted) controller.abort();
            else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
            try {
                const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
                    signal: controller.signal,
                    redirect: "follow",
                    headers: { "user-agent": `${PRODUCT_NAME}-agent/1.0 (+https://github.com/${REPO_SLUG})` },
                });
                if (!res.ok) return `[websearch failed: ${res.status} ${res.statusText}]`;
                const results = parseSearchResults(await res.text(), limit ?? DEFAULT_RESULTS);
                if (results.length === 0) {
                    // Zero parses also covers DDG serving a challenge/rate-limit
                    // page or changed markup — say so instead of a bare "nothing".
                    return `[no results for "${query}" — either nothing matched, or DuckDuckGo rate-limited the request]`;
                }
                return formatSearchResults(results);
            } catch (err) {
                if (controller.signal.aborted) return `[websearch timed out or aborted: "${query}"]`;
                return `[websearch error: ${err instanceof Error ? err.message : String(err)}]`;
            } finally {
                clearTimeout(timer);
                parentSignal?.removeEventListener("abort", onParentAbort);
            }
        },
    });
}
