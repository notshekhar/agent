/**
 * Shared diff computation utilities for the edit tool.
 * Used by both edit.ts (for execution) and tool-execution.ts (for preview rendering).
 */

import * as Diff from "diff";
export function detectLineEnding(content: string): "\r\n" | "\n" {
    const crlfIdx = content.indexOf("\r\n");
    const lfIdx = content.indexOf("\n");
    if (lfIdx === -1) return "\n";
    if (crlfIdx === -1) return "\n";
    return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
    return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
    return (
        text
            .normalize("NFKC")
            // Strip trailing whitespace per line
            .split("\n")
            .map((line) => line.trimEnd())
            .join("\n")
            // Smart single quotes → '
            .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
            // Smart double quotes → "
            .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
            // Various dashes/hyphens → -
            // U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
            // U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
            .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
            // Special spaces → regular space
            // U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
            // U+205F medium math space, U+3000 ideographic space
            .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
    );
}

/**
 * One code point's fuzzy-normalized form, borrowed from the function above so
 * the fold tables have exactly one definition. That function strips trailing
 * whitespace per line, which would erase a lone whitespace code point, so the
 * input is folded between two digits and unwrapped: "0" is stable under NFKC
 * and no combining mark composes with it.
 */
function normalizeCodePoint(cp: string): string {
    if (cp === "\n") return "\n";
    return normalizeForFuzzyMatch(`0${cp}0`).slice(1, -1);
}

interface NormalizedWithMap {
    text: string;
    /** Per output char, the [start, end) span of the source that produced it. */
    spanStart: number[];
    spanEnd: number[];
}

/**
 * Fuzzy-normalize while recording where every output character came from.
 *
 * The map is what keeps a fuzzy match honest. The match is found in normalized
 * space, then translated back to the exact span it covers in the REAL content,
 * so only that span is ever rewritten. Normalizing the file and writing the
 * result back instead would reflow every smart quote, dash, half-width kana and
 * trailing space in it — changes the model never asked for, and invisible in
 * the diff, since the diff would be computed against the normalized copy too.
 */
function normalizeWithMap(text: string): NormalizedWithMap {
    const out: string[] = [];
    const spanStart: number[] = [];
    const spanEnd: number[] = [];
    let lineStart = 0;
    let index = 0;
    const dropTrailingSpace = () => {
        while (out.length > lineStart && /\s/.test(out[out.length - 1])) {
            out.pop();
            spanStart.pop();
            spanEnd.pop();
        }
    };
    // Iterating a string yields whole code points, so surrogate pairs stay intact.
    for (const cp of text) {
        const next = index + cp.length;
        if (cp === "\n") {
            dropTrailingSpace();
            out.push("\n");
            spanStart.push(index);
            spanEnd.push(next);
            lineStart = out.length;
        } else {
            for (const ch of normalizeCodePoint(cp)) {
                out.push(ch);
                spanStart.push(index);
                spanEnd.push(next);
            }
        }
        index = next;
    }
    dropTrailingSpace();
    return { text: out.join(""), spanStart, spanEnd };
}

/** Fuzzy-folded text, folded identically to the mapped normalizer. */
function fuzzyText(text: string): string {
    return normalizeWithMap(text).text;
}

/** Where an edit landed — always a span of the real, unnormalized content. */
export interface MatchSpan {
    start: number;
    end: number;
    usedFuzzyMatch: boolean;
}

/**
 * Locate `oldText` in `content`, exact first then fuzzy. The returned span is
 * always an offset range into `content` itself, never into a normalized copy,
 * so a replacement can only ever touch the region that actually matched.
 */
export function findMatchSpan(content: string, oldText: string): MatchSpan | null {
    const exact = content.indexOf(oldText);
    if (exact !== -1) return { start: exact, end: exact + oldText.length, usedFuzzyMatch: false };

    const map = normalizeWithMap(content);
    const needle = fuzzyText(oldText);
    if (needle.length === 0) return null;
    const at = map.text.indexOf(needle);
    if (at === -1) return null;
    return { start: map.spanStart[at], end: map.spanEnd[at + needle.length - 1], usedFuzzyMatch: true };
}

export interface Edit {
    oldText: string;
    newText: string;
}

interface MatchedEdit {
    editIndex: number;
    matchIndex: number;
    matchLength: number;
    newText: string;
}

export interface AppliedEditsResult {
    baseContent: string;
    newContent: string;
    /**
     * Indexes (into the caller's `edits`) that matched only after fuzzy
     * normalization — the replaced span was NOT byte-identical to the
     * `oldText` asked for. The model's picture of the file is wrong exactly
     * there, so `edit` shows it the diff in this case and stays quiet in the
     * ordinary one (see DIFF_SEPARATOR).
     */
    fuzzyEditIndexes: number[];
}

/**
 * Splits the model-facing head of a file-mutation result from the UI-only tail.
 *
 * `edit` and `write` both return ONE string so nothing downstream has to learn
 * a new shape — the `tool-result` event, the CLI renderer and the desktop's all
 * take `output` as text. Their `toModelOutput` cuts here: everything before the
 * separator is what the model is told, everything after is for human eyes only.
 *
 * A blank line is a safe marker because `generateDiffString` prefixes EVERY
 * line it emits (`+12 `, `-12 `, ` 12 `), so a diff never contains one — and a
 * head built from single-newline joins never does either.
 */
export const DIFF_SEPARATOR = "\n\n";

/** The head of such a result: what the model is allowed to see. */
export function modelFacingResult(output: unknown): string {
    const text = String(output);
    const cut = text.indexOf(DIFF_SEPARATOR);
    return cut === -1 ? text : text.slice(0, cut);
}

/** Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it */
export function stripBom(content: string): { bom: string; text: string } {
    return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

/** Non-overlapping occurrences, without allocating: split() on a large file
 * builds an array holding every piece of it just to count the separators. */
function countIn(haystack: string, needle: string): number {
    if (needle.length === 0) return 0;
    let count = 0;
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++;
    return count;
}

/**
 * How many places an edit could land, counted in the space the match was
 * actually made in.
 *
 * An exact match must be counted exactly: folding first (smart quotes, dashes,
 * NBSP) can fuse text that is distinct in the file, so a literally unique
 * oldText would be rejected as ambiguous — and no amount of added context can
 * fix that, because the collision only exists after folding. A fuzzy match has
 * no exact anchor, so its ambiguity is judged in fuzzy space, where the
 * model's approximate text is what has to be resolved.
 */
function countOccurrences(content: string, oldText: string, fuzzy: boolean): number {
    return fuzzy ? countIn(fuzzyText(content), fuzzyText(oldText)) : countIn(content, oldText);
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
    if (totalEdits === 1) {
        return new Error(
            `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
        );
    }
    return new Error(
        `Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
    );
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
    if (totalEdits === 1) {
        return new Error(
            `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
        );
    }
    return new Error(
        `Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
    );
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
    if (totalEdits === 1) {
        return new Error(`oldText must not be empty in ${path}.`);
    }
    return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
    if (totalEdits === 1) {
        return new Error(
            `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
        );
    }
    return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * then applied in reverse order so offsets remain stable. Fuzzy matches are
 * resolved back to the span they cover in that same content, so the file is
 * never rewritten in normalized space and untouched regions stay byte-identical.
 */
export function applyEditsToNormalizedContent(
    normalizedContent: string,
    edits: Edit[],
    path: string,
): AppliedEditsResult {
    const normalizedEdits = edits.map((edit) => ({
        oldText: normalizeToLF(edit.oldText),
        newText: normalizeToLF(edit.newText),
    }));

    for (let i = 0; i < normalizedEdits.length; i++) {
        if (normalizedEdits[i].oldText.length === 0) {
            throw getEmptyOldTextError(path, i, normalizedEdits.length);
        }
    }

    // The file as it actually is — never a normalized copy of it.
    const baseContent = normalizedContent;

    const matchedEdits: MatchedEdit[] = [];
    const fuzzyEditIndexes: number[] = [];
    for (let i = 0; i < normalizedEdits.length; i++) {
        const edit = normalizedEdits[i];
        const span = findMatchSpan(baseContent, edit.oldText);
        if (!span) {
            throw getNotFoundError(path, i, normalizedEdits.length);
        }

        const occurrences = countOccurrences(baseContent, edit.oldText, span.usedFuzzyMatch);
        if (occurrences > 1) {
            throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
        }

        if (span.usedFuzzyMatch) fuzzyEditIndexes.push(i);
        matchedEdits.push({
            editIndex: i,
            matchIndex: span.start,
            matchLength: span.end - span.start,
            newText: edit.newText,
        });
    }

    matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
    for (let i = 1; i < matchedEdits.length; i++) {
        const previous = matchedEdits[i - 1];
        const current = matchedEdits[i];
        if (previous.matchIndex + previous.matchLength > current.matchIndex) {
            throw new Error(
                `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
            );
        }
    }

    let newContent = baseContent;
    for (let i = matchedEdits.length - 1; i >= 0; i--) {
        const edit = matchedEdits[i];
        newContent =
            newContent.substring(0, edit.matchIndex) +
            edit.newText +
            newContent.substring(edit.matchIndex + edit.matchLength);
    }

    if (baseContent === newContent) {
        throw getNoChangeError(path, normalizedEdits.length);
    }

    return { baseContent, newContent, fuzzyEditIndexes };
}

/**
 * Generate a unified diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
    oldContent: string,
    newContent: string,
    contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
    const parts = Diff.diffLines(oldContent, newContent);
    const output: string[] = [];

    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");
    const maxLineNum = Math.max(oldLines.length, newLines.length);
    const lineNumWidth = String(maxLineNum).length;

    let oldLineNum = 1;
    let newLineNum = 1;
    let lastWasChange = false;
    let firstChangedLine: number | undefined;

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const raw = part.value.split("\n");
        if (raw[raw.length - 1] === "") {
            raw.pop();
        }

        if (part.added || part.removed) {
            // Capture the first changed line (in the new file)
            if (firstChangedLine === undefined) {
                firstChangedLine = newLineNum;
            }

            // Show the change
            for (const line of raw) {
                if (part.added) {
                    const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
                    output.push(`+${lineNum} ${line}`);
                    newLineNum++;
                } else {
                    // removed
                    const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
                    output.push(`-${lineNum} ${line}`);
                    oldLineNum++;
                }
            }
            lastWasChange = true;
        } else {
            // Context lines - only show a few before/after changes
            const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
            const hasLeadingChange = lastWasChange;
            const hasTrailingChange = nextPartIsChange;

            if (hasLeadingChange && hasTrailingChange) {
                if (raw.length <= contextLines * 2) {
                    for (const line of raw) {
                        const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
                        output.push(` ${lineNum} ${line}`);
                        oldLineNum++;
                        newLineNum++;
                    }
                } else {
                    const leadingLines = raw.slice(0, contextLines);
                    const trailingLines = raw.slice(raw.length - contextLines);
                    const skippedLines = raw.length - leadingLines.length - trailingLines.length;

                    for (const line of leadingLines) {
                        const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
                        output.push(` ${lineNum} ${line}`);
                        oldLineNum++;
                        newLineNum++;
                    }

                    output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
                    oldLineNum += skippedLines;
                    newLineNum += skippedLines;

                    for (const line of trailingLines) {
                        const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
                        output.push(` ${lineNum} ${line}`);
                        oldLineNum++;
                        newLineNum++;
                    }
                }
            } else if (hasLeadingChange) {
                const shownLines = raw.slice(0, contextLines);
                const skippedLines = raw.length - shownLines.length;

                for (const line of shownLines) {
                    const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
                    output.push(` ${lineNum} ${line}`);
                    oldLineNum++;
                    newLineNum++;
                }

                if (skippedLines > 0) {
                    output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
                    oldLineNum += skippedLines;
                    newLineNum += skippedLines;
                }
            } else if (hasTrailingChange) {
                const skippedLines = Math.max(0, raw.length - contextLines);
                if (skippedLines > 0) {
                    output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
                    oldLineNum += skippedLines;
                    newLineNum += skippedLines;
                }

                for (const line of raw.slice(skippedLines)) {
                    const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
                    output.push(` ${lineNum} ${line}`);
                    oldLineNum++;
                    newLineNum++;
                }
            } else {
                // Skip these context lines entirely
                oldLineNum += raw.length;
                newLineNum += raw.length;
            }

            lastWasChange = false;
        }
    }

    return { diff: output.join("\n"), firstChangedLine };
}

