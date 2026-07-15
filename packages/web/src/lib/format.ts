export const TRUNCATE = 4000;

export function escapeHtml(value: unknown): string {
    return String(value).replace(
        /[&<>"]/g,
        (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]!,
    );
}

export function truncate(value: unknown): string {
    const text = String(value);
    return text.length > TRUNCATE ? `${text.slice(0, TRUNCATE)}\n… (${text.length - TRUNCATE} more chars)` : text;
}

/** Deliberately small, safe markdown subset for streamed agent text. */
export function renderMarkdown(text: unknown): string {
    const parts = String(text).split(/```/);
    return parts
        .map((part, index) => {
            if (index % 2 === 1) {
                const body = part.replace(/^[a-zA-Z0-9_-]*\n/, "");
                return `<span class="codewrap"><pre><code>${escapeHtml(body)}</code></pre><button class="copy-btn">copy</button></span>`;
            }
            return escapeHtml(part)
                .replace(/`([^`\n]+)`/g, "<code>$1</code>")
                .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
                .replace(
                    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
                    '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
                )
                .replace(/(^|\n)#{1,3} ([^\n]+)/g, '$1<span class="h">$2</span>')
                .replace(/(^|\n)- /g, "$1&#8226; ");
        })
        .join("");
}

export function pretty(value: unknown): string {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

export function toolOutputText(value: any): string {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map(toolOutputText).filter(Boolean).join("\n");
    if (typeof value === "object") {
        if (typeof value.value === "string") return value.value;
        if (typeof value.text === "string") return value.text;
        if (typeof value.output === "string") return value.output;
    }
    return pretty(value);
}

export function basename(path: unknown): string {
    const text = String(path).replace(/\/+$/, "");
    return text.split("/").at(-1) || text;
}

export function hueOf(value: string): number {
    let hash = 0;
    for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
    return hash % 360;
}

export function relativeTime(timestamp: number): string {
    const elapsed = Date.now() - timestamp;
    if (elapsed < 60_000) return "now";
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
    if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
    return `${Math.floor(elapsed / 86_400_000)}d`;
}

export function dayGroup(timestamp: number): string {
    const day = (value: number) => Math.floor((value - new Date(value).getTimezoneOffset() * 60_000) / 86_400_000);
    const today = day(Date.now());
    const target = day(timestamp);
    if (target === today) return "Today";
    if (target === today - 1) return "Yesterday";
    return "Older";
}

export function sessionTitle(session: any): string {
    return session.name || (session.firstUserMessage || "").split("\n")[0] || "(no prompt yet)";
}

export function formatTokens(n: number): string {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(n);
}
