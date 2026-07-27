/**
 * Line selection for the read tool.
 *
 * Two paths, one set of semantics:
 * - files under LARGE_FILE_BYTES are read whole (cheap, and the total line
 *   count comes for free)
 * - larger files are streamed, so `read` on a multi-GB log costs a few KB of
 *   memory instead of buffering the file (and never trips V8's 2GB string cap)
 *
 * Lines are split on "\n" exactly like `content.split("\n")`, except the empty
 * element after a file's final newline is dropped: a 10-line file that ends
 * with a newline has 10 lines, not 11. `trailingNewline` records whether the
 * selection ran to that final newline so callers can render it back.
 */
import { createReadStream } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "./truncate";

/** Above this, read by streaming instead of buffering the whole file. */
export const LARGE_FILE_BYTES = 8 * 1024 * 1024;
const SNIFF_BYTES = 4096;

export interface LineSelection {
    /** The lines to show, already clipped to the line/byte budget. */
    lines: string[];
    /** 1-indexed line number of `lines[0]`. */
    startLine: number;
    /** Which budget stopped the selection, if any. */
    truncatedBy: "lines" | "bytes" | null;
    /** More lines exist after the last one shown. */
    hasMore: boolean;
    /** Total lines in the file — unknown (undefined) when a big file wasn't scanned to the end. */
    totalLines?: number;
    /** The selection reached the file's final newline, which the caller should render back. */
    trailingNewline: boolean;
    /** Set when the first selected line alone blows the byte budget: nothing is shown. */
    firstLineBytes?: number;
    /** The oversized first line was measured only up to a cap, so `firstLineBytes` is a lower bound. */
    firstLineClipped?: boolean;
}

export interface SelectLinesOptions {
    /** 1-indexed first line to show. */
    offset?: number;
    /** Maximum lines to show. */
    limit?: number;
    /** File size from a prior stat; decides buffered vs streamed. */
    size: number;
    maxLines?: number;
    maxBytes?: number;
    signal?: AbortSignal;
}

/**
 * Accumulates lines until a budget is hit. Shared by both read paths so
 * truncation behaves identically whether the file was buffered or streamed.
 */
class LineBudget {
    readonly kept: string[] = [];
    truncatedBy: "lines" | "bytes" | null = null;
    firstLineBytes?: number;
    private bytes = 0;

    constructor(
        private readonly maxLines: number,
        private readonly maxBytes: number,
    ) {}

    /** Returns false when the line didn't fit — the budget is spent. */
    push(line: string): boolean {
        if (this.kept.length >= this.maxLines) {
            this.truncatedBy = "lines";
            return false;
        }
        const lineBytes = Buffer.byteLength(line, "utf-8");
        const cost = lineBytes + (this.kept.length > 0 ? 1 : 0); // +1 for the newline
        if (this.bytes + cost > this.maxBytes) {
            this.truncatedBy = "bytes";
            if (this.kept.length === 0) this.firstLineBytes = lineBytes;
            return false;
        }
        this.kept.push(line);
        this.bytes += cost;
        return true;
    }
}

function beyondEof(offset: number, totalLines: number): Error {
    return new Error(`Offset ${offset} is beyond end of file (${totalLines} lines total)`);
}

/** True when the first few KB contain a NUL byte — the same test git uses. */
export async function looksBinary(path: string): Promise<boolean> {
    const handle = await open(path, "r");
    try {
        const buf = Buffer.alloc(SNIFF_BYTES);
        const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0);
        return buf.subarray(0, bytesRead).includes(0);
    } finally {
        await handle.close();
    }
}

export async function selectLines(path: string, options: SelectLinesOptions): Promise<LineSelection> {
    const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    return options.size > LARGE_FILE_BYTES
        ? selectStreaming(path, options, maxLines, maxBytes)
        : selectBuffered(path, options, maxLines, maxBytes);
}

async function selectBuffered(
    path: string,
    options: SelectLinesOptions,
    maxLines: number,
    maxBytes: number,
): Promise<LineSelection> {
    const text = (await readFile(path)).toString("utf-8");
    if (options.signal?.aborted) throw new Error("Operation aborted");
    const raw = text.split("\n");
    // A file's final newline terminates its last line; it doesn't start a new one.
    const fileEndsWithNewline = raw.length > 1 && raw[raw.length - 1] === "";
    const all = fileEndsWithNewline ? raw.slice(0, -1) : raw;
    const totalLines = all.length;

    const startLine = options.offset ? options.offset - 1 : 0;
    if (startLine >= totalLines) throw beyondEof(options.offset ?? 1, totalLines);

    const end = options.limit === undefined ? totalLines : Math.min(startLine + options.limit, totalLines);
    const budget = new LineBudget(maxLines, maxBytes);
    let stoppedEarly = false;
    for (let i = startLine; i < end; i++) {
        if (!budget.push(all[i])) {
            stoppedEarly = true;
            break;
        }
    }
    const hasMore = stoppedEarly || end < totalLines;
    return {
        lines: budget.kept,
        startLine: startLine + 1,
        truncatedBy: budget.truncatedBy,
        hasMore,
        totalLines,
        trailingNewline: fileEndsWithNewline && !hasMore,
        firstLineBytes: budget.firstLineBytes,
    };
}

/**
 * Yields lines without holding the file in memory. `meta.endsWithNewline` is
 * only meaningful once the generator has run to completion.
 *
 * A line longer than `lineCap` chars is yielded clipped and flagged: it can
 * never fit the byte budget anyway, and the cap is what keeps a single-line
 * multi-GB file (minified bundles, one-line JSON dumps) from being buffered.
 */
async function* streamLines(
    path: string,
    lineCap: number,
    meta: { endsWithNewline: boolean; clippedLine: boolean },
    signal?: AbortSignal,
): AsyncGenerator<string> {
    const stream = createReadStream(path);
    const decoder = new TextDecoder("utf-8");
    let pending = "";
    let clipped = false;
    let yielded = false;
    try {
        for await (const chunk of stream) {
            if (signal?.aborted) throw new Error("Operation aborted");
            pending += decoder.decode(chunk as Buffer, { stream: true });
            let nl = pending.indexOf("\n");
            while (nl !== -1) {
                meta.clippedLine = clipped;
                yield pending.slice(0, nl);
                yielded = true;
                clipped = false;
                pending = pending.slice(nl + 1);
                nl = pending.indexOf("\n");
            }
            if (pending.length > lineCap) {
                // Past the cap the rest of this line can't change any decision.
                pending = pending.slice(0, lineCap);
                clipped = true;
            }
        }
        pending += decoder.decode();
        meta.endsWithNewline = yielded && pending === "";
        if (pending !== "") {
            meta.clippedLine = clipped;
            yield pending;
        }
    } finally {
        stream.destroy();
    }
}

async function selectStreaming(
    path: string,
    options: SelectLinesOptions,
    maxLines: number,
    maxBytes: number,
): Promise<LineSelection> {
    const startLine = options.offset ? options.offset - 1 : 0;
    const wanted = options.limit === undefined ? Infinity : options.limit;
    const budget = new LineBudget(maxLines, maxBytes);
    const meta = { endsWithNewline: false, clippedLine: false };
    // +1 char so a clipped line always exceeds the byte budget it's tested against.
    const iterator = streamLines(path, maxBytes + 1, meta, options.signal);

    let seen = 0;
    let hasMore = false;
    let firstLineClipped = false;
    for await (const line of iterator) {
        seen++;
        if (seen <= startLine) continue;
        if (budget.kept.length >= wanted) {
            hasMore = true; // the line we just pulled is past the user's limit
            break;
        }
        if (!budget.push(line)) {
            if (budget.kept.length === 0) firstLineClipped = meta.clippedLine;
            hasMore = true;
            break;
        }
    }
    // Only trust the end-of-file flags if the stream actually ran to the end.
    const reachedEof = !hasMore;
    if (reachedEof && seen <= startLine) throw beyondEof(options.offset ?? 1, seen);

    return {
        lines: budget.kept,
        startLine: startLine + 1,
        truncatedBy: budget.truncatedBy,
        hasMore,
        totalLines: reachedEof ? seen : undefined,
        trailingNewline: reachedEof && meta.endsWithNewline,
        firstLineBytes: budget.firstLineBytes,
        firstLineClipped: firstLineClipped || undefined,
    };
}
