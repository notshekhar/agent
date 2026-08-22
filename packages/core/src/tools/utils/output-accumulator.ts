import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate";

export interface OutputAccumulatorOptions {
    maxLines?: number;
    maxBytes?: number;
    tempFilePrefix?: string;
}

export interface OutputSnapshot {
    content: string;
    truncation: TruncationResult;
    fullOutputPath?: string;
}

function defaultTempFilePath(prefix: string): string {
    const id = randomBytes(8).toString("hex");
    return join(tmpdir(), `${prefix}-${id}.log`);
}

function byteLength(text: string): number {
    return Buffer.byteLength(text, "utf-8");
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
 * tail for display snapshots, and opens a temp file when the full output needs
 * to be preserved.
 */
export class OutputAccumulator {
    private readonly maxLines: number;
    private readonly maxBytes: number;
    private readonly maxRollingBytes: number;
    private readonly tempFilePrefix: string;
    private readonly decoder = new TextDecoder();

    private rawChunks: Buffer[] = [];
    private tailText = "";
    private tailBytes = 0;
    private tailStartsAtLineBoundary = true;
    private totalRawBytes = 0;
    private totalDecodedBytes = 0;
    private totalLines = 1;
    private currentLineBytes = 0;
    private finished = false;

    private tempFilePath: string | undefined;
    private tempFileStream: WriteStream | undefined;
    /**
     * The full-output file could not be written — an unwritable TMPDIR, a full
     * disk. A one-way latch: once it fails we stop reaching for it, because
     * every later append would open (and fail) a fresh file.
     *
     * Losing the file is a degradation, never an error. The decoded tail is
     * held in memory and is what the snapshot renders, so the command still
     * reports its output — just without a path to the rest of it.
     */
    private tempFileFailed = false;

    constructor(options: OutputAccumulatorOptions = {}) {
        this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
        this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
        this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
        this.tempFilePrefix = options.tempFilePrefix ?? "loop-output";
    }

    append(data: Buffer): void {
        if (this.finished) {
            throw new Error("Cannot append to a finished output accumulator");
        }

        this.totalRawBytes += data.length;
        this.appendDecodedText(this.decoder.decode(data, { stream: true }));

        // The tail above is tracked either way; only the full-output copy is
        // given up on. Returning BEFORE the buffering below matters: without
        // it a failed temp file would send every later chunk back into
        // `rawChunks`, waiting for a flush that can never come — unbounded
        // memory, which is the exact thing this class exists to avoid.
        if (this.tempFileFailed) {
            return;
        }
        if (this.tempFileStream || this.shouldUseTempFile()) {
            this.ensureTempFile();
            this.tempFileStream?.write(data);
        } else if (data.length > 0) {
            this.rawChunks.push(data);
        }
    }

    finish(): void {
        if (this.finished) {
            return;
        }
        this.finished = true;
        this.appendDecodedText(this.decoder.decode());
        if (this.shouldUseTempFile()) {
            this.ensureTempFile();
        }
    }

    snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
        const tailTruncation = truncateTail(this.getSnapshotText(), {
            maxLines: this.maxLines,
            maxBytes: this.maxBytes,
        });
        const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
        const truncatedBy = truncated
            ? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
            : null;
        const truncation: TruncationResult = {
            ...tailTruncation,
            truncated,
            truncatedBy,
            totalLines: this.totalLines,
            totalBytes: this.totalDecodedBytes,
            maxLines: this.maxLines,
            maxBytes: this.maxBytes,
        };

        if (options.persistIfTruncated && truncation.truncated) {
            this.ensureTempFile();
        }

        return {
            content: truncation.content,
            truncation,
            fullOutputPath: this.tempFilePath,
        };
    }

    /**
     * Flush and close the full-output file. Settles exactly once, and never
     * rejects.
     *
     * Both halves of that are load-bearing, and the old shape had neither.
     * `end()` on a stream Node already destroyed emits no 'finish' AT ALL, so
     * waiting on that one event waited forever — the bash tool awaits this
     * before returning, so a temp file that failed mid-command hung the call
     * (and the turn behind it) rather than ending it. And rejecting on a late
     * write error surfaced an ENOSPC about a scratch file in place of the
     * output the command actually produced. Losing the copy is not the
     * command's failure, so 'close' and 'error' end the wait like 'finish'.
     */
    async closeTempFile(): Promise<void> {
        const stream = this.tempFileStream;
        this.tempFileStream = undefined;
        if (!stream || stream.destroyed) {
            return;
        }

        await new Promise<void>((resolve) => {
            const done = () => {
                stream.off("finish", done);
                stream.off("close", done);
                stream.off("error", done);
                resolve();
            };
            stream.once("finish", done);
            stream.once("close", done);
            stream.once("error", done);
            stream.end();
        });
    }

    getLastLineBytes(): number {
        return this.currentLineBytes;
    }

    private appendDecodedText(text: string): void {
        if (text.length === 0) {
            return;
        }

        const bytes = byteLength(text);
        this.totalDecodedBytes += bytes;
        this.tailText += text;
        this.tailBytes += bytes;
        if (this.tailBytes > this.maxRollingBytes * 2) {
            this.trimTail();
        }

        let newlines = 0;
        let lastNewline = -1;
        for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
            newlines++;
            lastNewline = i;
        }
        if (newlines === 0) {
            this.currentLineBytes += bytes;
        } else {
            this.totalLines += newlines;
            this.currentLineBytes = byteLength(text.slice(lastNewline + 1));
        }
    }

    private trimTail(): void {
        const buffer = Buffer.from(this.tailText, "utf-8");
        if (buffer.length <= this.maxRollingBytes) {
            this.tailBytes = buffer.length;
            return;
        }

        let start = buffer.length - this.maxRollingBytes;
        while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
            start++;
        }

        this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
        this.tailText = buffer.subarray(start).toString("utf-8");
        this.tailBytes = byteLength(this.tailText);
    }

    private getSnapshotText(): string {
        if (this.tailStartsAtLineBoundary) {
            return this.tailText;
        }

        const firstNewline = this.tailText.indexOf("\n");
        return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
    }

    private shouldUseTempFile(): boolean {
        return (
            this.totalRawBytes > this.maxBytes ||
            this.totalDecodedBytes > this.maxBytes ||
            this.totalLines > this.maxLines
        );
    }

    private ensureTempFile(): void {
        if (this.tempFilePath || this.tempFileFailed) {
            return;
        }
        const filePath = defaultTempFilePath(this.tempFilePrefix);
        let stream: WriteStream;
        try {
            stream = createWriteStream(filePath);
        } catch {
            this.failTempFile();
            return;
        }
        // The open and every write are asynchronous, so a failure arrives as an
        // 'error' event long after this returns. A WriteStream with no 'error'
        // listener turns that into an unhandled error event: the interactive UI
        // absorbs it with a process-level handler, but print mode, RPC and the
        // gateway daemons install none — so one command with 50KB of output on
        // a full disk took the whole process down.
        stream.on("error", () => this.failTempFile());
        this.tempFilePath = filePath;
        this.tempFileStream = stream;
        for (const chunk of this.rawChunks) {
            stream.write(chunk);
        }
        this.rawChunks = [];
    }

    /**
     * Give up on the full-output file.
     *
     * The PATH is dropped with it, deliberately: a snapshot that still carried
     * it would point the user — and the model — at a file that was never
     * written, which is worse than admitting there is no full copy. Node
     * destroys a stream that errors, so there is nothing left to close either.
     */
    private failTempFile(): void {
        this.tempFileFailed = true;
        this.tempFilePath = undefined;
        this.tempFileStream = undefined;
        this.rawChunks = [];
    }
}
