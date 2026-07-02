/**
 * Interactive answer flow for the ask tool. The core tool's execute awaits
 * AskUserBridge.ask(); this module renders each question as an arrow-key menu
 * (options + an automatic "Other" free-text entry, Space-toggling for
 * multiSelect) using the same building blocks as selectors.ts. Registered via
 * setAskUserBridge in app.ts — interactive mode only.
 */
import { Container, Editor, type EditorTheme, SelectList, type SelectItem, Text } from "@notshekhar/loop-tui";
import type { AskAnswer, AskQuestion, AskUserBridge } from "@notshekhar/loop-core";
import chalk from "chalk";
import { isEsc } from "./keys";
import type { SelectorHost } from "./selectors";
import { DynamicBorder } from "./ui/messages";
import { getSelectListTheme } from "./ui/theme";

const OTHER = "__other__";
const DONE = "__done__";

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
        wire?: (list: SelectList, finish: (v: SelectItem | null) => void) => (() => void) | undefined,
    ): Promise<SelectItem | null> =>
        new Promise((resolve) => {
            const list = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());
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
            cleanup = wire?.(list, finish);
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
                    if (isEsc(data)) {
                        finish("");
                        return { consume: true };
                    }
                    return undefined;
                });
            }
            editor.onSubmit = (text) => finish(text.trim());
        });

    /** Single-choice question. Resolves the answer, or null when declined. */
    const askSingle = async (
        q: AskQuestion,
        progress: string,
        signal: AbortSignal | undefined,
    ): Promise<AskAnswer | null> => {
        while (true) {
            if (signal?.aborted) return null;
            const items: SelectItem[] = [
                ...q.options.map((o, i) => ({ value: String(i), label: o.label, description: o.description })),
                { value: OTHER, label: "Other", description: "type a custom answer" },
            ];
            const pick = await showList(q, progress, items, "↑↓ navigate · Enter select · Esc skip", signal);
            if (!pick || signal?.aborted) return null;
            if (pick.value === OTHER) {
                const text = await promptText(q, progress, signal);
                if (signal?.aborted) return null;
                if (!text) continue; // Esc/empty → back to the options
                return { answers: [text], custom: true };
            }
            return { answers: [q.options[Number(pick.value)].label] };
        }
    };

    /** Multi-choice question: Enter/Space toggles, "done" confirms (≥1 pick). */
    const askMulti = async (
        q: AskQuestion,
        progress: string,
        signal: AbortSignal | undefined,
    ): Promise<AskAnswer | null> => {
        const selected = new Set<number>();
        const customs: string[] = [];
        const count = () => selected.size + customs.length;
        while (true) {
            if (signal?.aborted) return null;
            const doneItem = (): SelectItem => ({
                value: DONE,
                label: `done (${count()} selected)`,
                description: count() === 0 ? "pick at least one" : "confirm these answers",
            });
            const box = (on: boolean) => (on ? "[x]" : "[ ]");
            const items: SelectItem[] = [
                doneItem(),
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
            ];
            // Enter/Space toggles in place (labels mutated so the cursor stays
            // put); Enter on "done"/"Other" falls through to the outer loop.
            const pick = await showList(
                q,
                progress,
                items,
                "↑↓ navigate · Enter/Space toggle · done confirms · Esc skip",
                signal,
                (list, finish) => {
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
                        Object.assign(items[0], doneItem());
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
                        if (data === " ") {
                            toggle(current);
                            return { consume: true };
                        }
                        return undefined;
                    });
                },
            );
            if (!pick || signal?.aborted) return null;
            if (pick.value === "__rebuild__") continue;
            if (pick.value === OTHER) {
                const text = await promptText(q, progress, signal);
                if (signal?.aborted) return null;
                if (text) customs.push(text);
                continue;
            }
            // done
            const labels = q.options.filter((_, i) => selected.has(i)).map((o) => o.label);
            return {
                answers: [...labels, ...customs],
                custom: labels.length === 0 && customs.length > 0 ? true : undefined,
            };
        }
    };

    // Serialize concurrent ask() calls (parallel tool calls in one step) —
    // there is only one showSelector slot.
    let chain: Promise<unknown> = Promise.resolve();

    return {
        ask(questions, opts) {
            const run = async (): Promise<AskAnswer[]> => {
                const signal = opts?.signal;
                const answers: AskAnswer[] = [];
                let declined = false;
                for (let i = 0; i < questions.length; i++) {
                    if (declined || signal?.aborted) {
                        answers.push({ answers: [], declined: true });
                        continue;
                    }
                    const q = questions[i];
                    const progress = questions.length > 1 ? `question ${i + 1}/${questions.length}` : "";
                    const a = q.multiSelect
                        ? await askMulti(q, progress, signal)
                        : await askSingle(q, progress, signal);
                    if (a) answers.push(a);
                    else {
                        answers.push({ answers: [], declined: true });
                        declined = true; // Esc skips this and all remaining questions
                    }
                }
                return answers;
            };
            const p = chain.then(run, run);
            chain = p.catch(() => {});
            return p;
        },
    };
}
