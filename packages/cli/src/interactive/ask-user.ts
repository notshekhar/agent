/**
 * Interactive answer flow for the ask tool. The core tool's execute awaits
 * AskUserBridge.ask(); this module renders each question as an arrow-key menu
 * (options + an automatic "Other" free-text entry, Space-toggling for
 * multiSelect) using the same building blocks as selectors.ts. Left/Right
 * moves between questions (answers are kept and pre-selected on revisit), and
 * a final review screen shows every answer with a Submit row — nothing is
 * sent to the model until the user submits. Registered via setAskUserBridge
 * in app.ts — interactive mode only.
 */
import {
    Container,
    Editor,
    type EditorTheme,
    isKeyRelease,
    SelectList,
    type SelectItem,
    Text,
} from "@notshekhar/loop-tui";
import type { AskAnswer, AskQuestion, AskUserBridge } from "@notshekhar/loop-core";
import chalk from "chalk";
import { isEsc, isLeft, isRight } from "./keys";
import type { SelectorHost } from "./selectors";
import { DynamicBorder } from "./ui/messages";
import { getSelectListTheme } from "./ui/theme";

const OTHER = "__other__";
const DONE = "__done__";
const NOTE = "__note__";
const BACK = "__back__";
const NEXT = "__next__";
const SUBMIT = "__submit__";

/** Outcome of showing one question. "back"/"next" are ←/→ navigation —
 * "next" clamps at the last question, so navigation alone never reaches the
 * review. "cancel" is Esc: the user is dismissing the whole prompt, not this
 * one question — with nothing answered the ask resolves declined right away,
 * otherwise the review shows so no answer is sent unseen. "skip" is the
 * editing-from-review Esc: keep the committed answer, back to the review.
 * Navigating/cancelling a multi-select with ticked boxes carries them along
 * as `answer` (a tick IS a selection). */
type AskOneResult =
    | { kind: "answer"; answer: AskAnswer }
    | { kind: "back"; answer?: AskAnswer }
    | { kind: "next"; answer?: AskAnswer }
    | { kind: "cancel"; answer?: AskAnswer }
    | { kind: "skip" };

/** Per-question UI state that survives ←/→ navigation within one ask() call:
 * the cursor row on a single-select, the ticked boxes on a multi-select. */
type SingleState = { cursor?: number };
type MultiState = { selected: Set<number>; customs: string[] };

type ReviewResult = { kind: "submit" } | { kind: "back" } | { kind: "edit"; index: number };

/** Digit quick-pick: "1".."9" → option index, when within the option count. */
function digitIndex(data: string, optionCount: number): number | null {
    if (data.length !== 1 || data < "1" || data > "9") return null;
    const i = data.charCodeAt(0) - "1".charCodeAt(0);
    return i < optionCount ? i : null;
}

type TuiWithInput = {
    addInputListener?: (cb: (d: string) => { consume: boolean } | undefined) => () => void;
};

export interface AskUserDeps {
    host: SelectorHost;
    editorTheme: EditorTheme;
}

export function createAskUserBridge(deps: AskUserDeps): AskUserBridge {
    const { host, editorTheme } = deps;

    /** Header chip + question text + list/editor + help line, per question. */
    const buildWrapper = (q: AskQuestion, progress: string, body: SelectList | Editor, help: string): Container => {
        const wrapper = new Container();
        wrapper.addChild(
            new Text(chalk.bold.cyan(` [${q.header}]`) + (progress ? chalk.dim(`  ${progress}`) : ""), 0, 0),
        );
        wrapper.addChild(new Text(` ${q.question}`, 0, 0));
        wrapper.addChild(new DynamicBorder());
        wrapper.addChild(body as never);
        wrapper.addChild(new DynamicBorder());
        wrapper.addChild(new Text(chalk.dim(` ${help}`), 0, 0));
        return wrapper;
    };

    /** Arrow-key list for one question; resolves the picked item, null on Esc/abort. */
    const showList = (
        q: AskQuestion,
        progress: string,
        items: SelectItem[],
        help: string,
        signal: AbortSignal | undefined,
        opts?: {
            initialIndex?: number;
            wire?: (list: SelectList, finish: (v: SelectItem | null) => void) => (() => void) | undefined;
        },
    ): Promise<SelectItem | null> =>
        new Promise((resolve) => {
            const list = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());
            if (opts?.initialIndex) list.setSelectedIndex(opts.initialIndex);
            const close = host.showSelector(buildWrapper(q, progress, list, help), list);
            let done = false;
            let cleanup: (() => void) | undefined;
            const onAbort = () => finish(null);
            const finish = (v: SelectItem | null) => {
                if (done) return;
                done = true;
                signal?.removeEventListener("abort", onAbort);
                try {
                    cleanup?.();
                } catch {}
                close();
                resolve(v);
            };
            signal?.addEventListener("abort", onAbort);
            list.onSelect = (item) => finish(item);
            list.onCancel = () => finish(null);
            cleanup = opts?.wire?.(list, finish);
        });

    /** Free-text prompt for "Other" — like promptOnce, but closes on abort. */
    const promptText = (q: AskQuestion, progress: string, signal: AbortSignal | undefined): Promise<string> =>
        new Promise((resolve) => {
            const editor = new Editor(host.tui, editorTheme, { paddingX: 1 });
            const wrapper = buildWrapper(
                q,
                progress,
                editor,
                "Enter to submit · Shift+Enter newline · Esc back to options",
            );
            const close = host.showSelector(wrapper, editor as never);
            let done = false;
            let removeEsc: (() => void) | undefined;
            const onAbort = () => finish("");
            const finish = (v: string) => {
                if (done) return;
                done = true;
                signal?.removeEventListener("abort", onAbort);
                try {
                    removeEsc?.();
                } catch {}
                close();
                resolve(v);
            };
            signal?.addEventListener("abort", onAbort);
            // The editor has no onCancel; intercept Esc at the TUI level while
            // this prompt is showing (same pattern as promptOnce).
            const addInput = (host.tui as unknown as TuiWithInput).addInputListener;
            if (typeof addInput === "function") {
                removeEsc = addInput.call(host.tui, (data: string) => {
                    if (isKeyRelease(data)) return undefined;
                    if (isEsc(data)) {
                        finish("");
                        return { consume: true };
                    }
                    return undefined;
                });
            }
            editor.onSubmit = (text) => finish(text.trim());
        });

    /** Help line tail shared by both question kinds. */
    const navHelp = (nav: boolean, editing: boolean): string =>
        editing ? "Esc keep current answer" : `${nav ? "←→ switch question · " : ""}Esc dismiss`;

    /** Single-choice question. The cursor row persists across ←/→ visits
     * (falling back to the committed answer's row), so the list looks exactly
     * as it was left — but only Enter/digits/Tab select; moving the cursor or
     * navigating away never commits anything. */
    const askSingle = async (
        q: AskQuestion,
        progress: string,
        prev: AskAnswer | null,
        state: SingleState,
        nav: boolean,
        editing: boolean,
        signal: AbortSignal | undefined,
    ): Promise<AskOneResult> => {
        while (true) {
            if (signal?.aborted) return { kind: "skip" };
            const items: SelectItem[] = [
                ...q.options.map((o, i) => ({ value: String(i), label: o.label, description: o.description })),
                { value: OTHER, label: "Other", description: "type a custom answer" },
            ];
            // Revisit: restore the cursor where it was left, else on the
            // previously picked option ("Other" for a free-typed answer).
            let initialIndex = state.cursor ?? 0;
            if (state.cursor === undefined && prev && !prev.declined && prev.answers.length > 0) {
                if (prev.custom) initialIndex = q.options.length;
                else {
                    const idx = q.options.findIndex((o) => o.label === prev.answers[0]);
                    if (idx >= 0) initialIndex = idx;
                }
            }
            initialIndex = Math.min(initialIndex, items.length - 1);
            let lastCursor = initialIndex;
            // Tab picks the highlighted option AND opens a note prompt for it —
            // the index rides outside the loop because finish() only carries an item.
            let noteIndex = -1;
            const pick = await showList(
                q,
                progress,
                items,
                `↑↓ navigate · Enter select · 1-9 quick pick · Tab select+note · ${navHelp(nav, editing)}`,
                signal,
                {
                    initialIndex,
                    wire: (list, finish) => {
                        let current: SelectItem = items[initialIndex] ?? items[0];
                        list.onSelectionChange = (item) => {
                            current = item;
                            const idx = items.findIndex((x) => x.value === item.value);
                            if (idx >= 0) lastCursor = idx;
                        };
                        const addInput = (host.tui as unknown as TuiWithInput).addInputListener;
                        if (typeof addInput !== "function") return undefined;
                        return addInput.call(host.tui, (data: string) => {
                            // Kitty protocol: a physical press also emits a
                            // release event, and matchesKey-based checks
                            // (isLeft/isRight) match both — act on press only,
                            // or one arrow press jumps two questions.
                            if (isKeyRelease(data)) return undefined;
                            const i = digitIndex(data, q.options.length);
                            if (i !== null) {
                                finish(items[i]);
                                return { consume: true };
                            }
                            if (data === "\t" && current.value !== OTHER) {
                                noteIndex = Number(current.value);
                                finish({ value: NOTE, label: "" });
                                return { consume: true };
                            }
                            if (isLeft(data)) {
                                finish({ value: BACK, label: "" });
                                return { consume: true };
                            }
                            if (isRight(data)) {
                                finish({ value: NEXT, label: "" });
                                return { consume: true };
                            }
                            return undefined;
                        });
                    },
                },
            );
            state.cursor = lastCursor;
            if (!pick || signal?.aborted) return editing || signal?.aborted ? { kind: "skip" } : { kind: "cancel" };
            if (pick.value === BACK) return { kind: "back" };
            if (pick.value === NEXT) return { kind: "next" };
            if (pick.value === NOTE) {
                const label = q.options[noteIndex].label;
                const note = await promptText(
                    { ...q, question: `${q.question} — note for "${label}"` },
                    progress,
                    signal,
                );
                if (signal?.aborted) return { kind: "skip" };
                if (!note) continue; // Esc/empty → back to the options
                state.cursor = noteIndex;
                return { kind: "answer", answer: { answers: [label], note } };
            }
            if (pick.value === OTHER) {
                const text = await promptText(q, progress, signal);
                if (signal?.aborted) return { kind: "skip" };
                if (!text) continue; // Esc/empty → back to the options
                state.cursor = q.options.length;
                return { kind: "answer", answer: { answers: [text], custom: true } };
            }
            // Digit quick-pick doesn't move the visible cursor first — park it
            // on the picked row so a revisit shows what was chosen.
            state.cursor = Number(pick.value);
            return { kind: "answer", answer: { answers: [q.options[Number(pick.value)].label] } };
        }
    };

    /** Multi-choice question: Enter/Space toggles, "done" confirms (≥1 pick).
     * The checkbox state lives in the caller's per-question `state`, so ←/→
     * keeps the ticks — and since a tick IS a selection, navigating away with
     * ≥1 of them commits the current set as the answer. */
    const askMulti = async (
        q: AskQuestion,
        progress: string,
        state: MultiState,
        nav: boolean,
        editing: boolean,
        signal: AbortSignal | undefined,
    ): Promise<AskOneResult> => {
        const { selected, customs } = state;
        const count = () => selected.size + customs.length;
        const buildAnswer = (): AskAnswer => {
            const labels = q.options.filter((_, i) => selected.has(i)).map((o) => o.label);
            return {
                answers: [...labels, ...customs],
                custom: labels.length === 0 && customs.length > 0 ? true : undefined,
            };
        };
        while (true) {
            if (signal?.aborted) return { kind: "skip" };
            const doneItem = (): SelectItem => ({
                value: DONE,
                label: `done (${count()} selected)`,
                description: count() === 0 ? "pick at least one" : "confirm these answers",
            });
            const box = (on: boolean) => (on ? "[x]" : "[ ]");
            // Options lead, "done" sits last — the cursor starts on the first
            // real choice instead of an empty confirm row.
            const items: SelectItem[] = [
                ...q.options.map((o, i) => ({
                    value: String(i),
                    label: `${box(selected.has(i))} ${o.label}`,
                    description: o.description,
                })),
                ...customs.map((text, i) => ({
                    value: `custom:${i}`,
                    label: `[x] ${text}`,
                    description: "custom answer — Enter/Space removes it",
                })),
                { value: OTHER, label: "Other", description: "type a custom answer" },
                doneItem(),
            ];
            const doneIdx = items.length - 1;
            // Enter/Space toggles in place (labels mutated so the cursor stays
            // put); Enter on "done"/"Other" falls through to the outer loop.
            const pick = await showList(
                q,
                progress,
                items,
                `↑↓ navigate · Enter/Space toggle · 1-9 toggle · done confirms · ${navHelp(nav, editing)}`,
                signal,
                {
                    wire: (list, finish) => {
                        let current: SelectItem = items[0];
                        list.onSelectionChange = (item) => (current = item);
                        const toggle = (item: SelectItem): boolean => {
                            if (item.value === DONE || item.value === OTHER) return false;
                            if (item.value.startsWith("custom:")) {
                                // Removing a row shifts indices — rebuild via the outer loop.
                                customs.splice(Number(item.value.slice(7)), 1);
                                finish({ value: "__rebuild__", label: "" });
                                return true;
                            }
                            const i = Number(item.value);
                            if (selected.has(i)) selected.delete(i);
                            else selected.add(i);
                            item.label = `${box(selected.has(i))} ${q.options[i].label}`;
                            Object.assign(items[doneIdx], doneItem());
                            host.tui.requestRender();
                            return true;
                        };
                        list.onSelect = (item) => {
                            if (item.value === DONE) {
                                if (count() === 0) return; // need at least one — keep open
                                finish(item);
                                return;
                            }
                            if (item.value === OTHER) {
                                finish(item);
                                return;
                            }
                            toggle(item);
                        };
                        const addInput = (host.tui as unknown as TuiWithInput).addInputListener;
                        if (typeof addInput !== "function") return undefined;
                        return addInput.call(host.tui, (data: string) => {
                            if (isKeyRelease(data)) return undefined; // Kitty press+release — see askSingle
                            if (data === " ") {
                                toggle(current);
                                return { consume: true };
                            }
                            const i = digitIndex(data, q.options.length);
                            if (i !== null) {
                                toggle(items[i]);
                                return { consume: true };
                            }
                            if (isLeft(data)) {
                                finish({ value: BACK, label: "" });
                                return { consume: true };
                            }
                            if (isRight(data)) {
                                finish({ value: NEXT, label: "" });
                                return { consume: true };
                            }
                            return undefined;
                        });
                    },
                },
            );
            if (!pick || signal?.aborted) {
                if (editing || signal?.aborted) return { kind: "skip" };
                return { kind: "cancel", answer: count() > 0 ? buildAnswer() : undefined };
            }
            // Ticked boxes travel with navigation — the review shows exactly
            // what is ticked, whether it was confirmed with "done" or not.
            if (pick.value === BACK) return { kind: "back", answer: count() > 0 ? buildAnswer() : undefined };
            if (pick.value === NEXT) return { kind: "next", answer: count() > 0 ? buildAnswer() : undefined };
            if (pick.value === "__rebuild__") continue;
            if (pick.value === OTHER) {
                const text = await promptText(q, progress, signal);
                if (signal?.aborted) return { kind: "skip" };
                if (text) customs.push(text);
                continue;
            }
            // done
            return { kind: "answer", answer: buildAnswer() };
        }
    };

    /** One review row's answer text. */
    const summarize = (a: AskAnswer | null): string => {
        if (!a || a.declined || a.answers.length === 0) return "(skipped)";
        let s = a.custom ? `"${a.answers.join("; ")}"` : a.answers.join(", ");
        if (a.note) s += ` — note: "${a.note}"`;
        return s;
    };

    /** Confirmation screen: every question with its answer, Submit last.
     * Nothing resolves back to the model until Submit is picked. */
    const showReview = async (
        questions: AskQuestion[],
        answers: (AskAnswer | null)[],
        signal: AbortSignal | undefined,
    ): Promise<ReviewResult> => {
        const items: SelectItem[] = [
            ...questions.map((qq, i) => ({
                value: String(i),
                label: `${i + 1}. ${qq.header}`,
                description: summarize(answers[i]),
            })),
            { value: SUBMIT, label: "Submit answers", description: "send these answers" },
        ];
        const reviewQ: AskQuestion = {
            header: "Review",
            question: "Check your answers — Enter on a row changes it, Submit sends them.",
            options: [],
        };
        const pick = await showList(
            reviewQ,
            "",
            items,
            "↑↓ navigate · Enter change/submit · 1-9 change question · Esc back to questions",
            signal,
            {
                // The fast path is Enter-to-submit: start the cursor on Submit.
                initialIndex: items.length - 1,
                wire: (_list, finish) => {
                    const addInput = (host.tui as unknown as TuiWithInput).addInputListener;
                    if (typeof addInput !== "function") return undefined;
                    return addInput.call(host.tui, (data: string) => {
                        if (isKeyRelease(data)) return undefined; // Kitty press+release — see askSingle
                        const i = digitIndex(data, questions.length);
                        if (i !== null) {
                            finish(items[i]);
                            return { consume: true };
                        }
                        if (isLeft(data)) {
                            finish({ value: BACK, label: "" });
                            return { consume: true };
                        }
                        return undefined;
                    });
                },
            },
        );
        if (!pick || pick.value === BACK) return { kind: "back" };
        if (pick.value === SUBMIT) return { kind: "submit" };
        return { kind: "edit", index: Number(pick.value) };
    };

    // Serialize concurrent ask() calls (parallel tool calls in one step) —
    // there is only one showSelector slot.
    let chain: Promise<unknown> = Promise.resolve();

    return {
        ask(questions, opts) {
            const run = async (): Promise<AskAnswer[]> => {
                const signal = opts?.signal;
                const n = questions.length;
                const answers: (AskAnswer | null)[] = Array.from({ length: n }, () => null);
                // UI state per question, kept across ←/→ so a revisited
                // question looks exactly as it was left.
                const singleStates: SingleState[] = questions.map(() => ({}));
                const multiStates = new Map<number, MultiState>();
                const getMultiState = (idx: number): MultiState => {
                    let s = multiStates.get(idx);
                    if (!s) {
                        s = { selected: new Set(), customs: [] };
                        const a = answers[idx];
                        if (a && !a.declined) {
                            for (const ans of a.answers) {
                                const oi = questions[idx].options.findIndex((o) => o.label === ans);
                                if (oi >= 0) s.selected.add(oi);
                                else s.customs.push(ans);
                            }
                        }
                        multiStates.set(idx, s);
                    }
                    return s;
                };
                // i walks the questions; i === n is the review screen. ←/→
                // only move between questions (→ clamps at the last one — the
                // review is reached by answering the last question), and the
                // loop ends via the review's Submit or an Esc dismissal with
                // nothing answered — so answers can be revised freely before
                // anything reaches the model.
                let i = 0;
                let editing = false; // current question was opened from the review screen
                while (!signal?.aborted) {
                    if (i >= n) {
                        const r = await showReview(questions, answers, signal);
                        if (signal?.aborted) break;
                        if (r.kind === "submit") break;
                        if (r.kind === "back") {
                            i = n - 1;
                            continue;
                        }
                        i = r.index;
                        editing = true;
                        continue;
                    }
                    const q = questions[i];
                    const progress = n > 1 ? `question ${i + 1}/${n}` : "";
                    const res = q.multiSelect
                        ? await askMulti(q, progress, getMultiState(i), n > 1, editing, signal)
                        : await askSingle(q, progress, answers[i], singleStates[i], n > 1, editing, signal);
                    if (signal?.aborted) break;
                    if (res.kind !== "skip" && res.answer) answers[i] = res.answer;
                    if (editing) {
                        // Whatever happened, an edit returns to the review. A
                        // cancelled multi-select edit (Esc, nothing committed)
                        // reverts its ticks to the committed answer so the
                        // boxes keep matching what the review shows.
                        if (q.multiSelect && !(res.kind !== "skip" && res.answer)) multiStates.delete(i);
                        i = n;
                        editing = false;
                        continue;
                    }
                    if (res.kind === "cancel") {
                        // Esc = dismiss the prompt. Nothing answered → the
                        // whole ask resolves declined right now (the model
                        // proceeds on its own). Something answered → land on
                        // the review, so partial answers still get confirmed
                        // (or walked back) before anything is sent.
                        const anyAnswered = answers.some((a) => a && !a.declined && a.answers.length > 0);
                        if (!anyAnswered) break;
                        i = n;
                        continue;
                    }
                    if (res.kind === "back") {
                        i = Math.max(0, i - 1);
                        continue;
                    }
                    if (res.kind === "next") {
                        i = Math.min(n - 1, i + 1);
                        continue;
                    }
                    i++;
                }
                return answers.map((a) => a ?? { answers: [], declined: true });
            };
            const p = chain.then(run, run);
            chain = p.catch(() => {});
            return p;
        },
    };
}
