/**
 * Interactive bash approval prompt (bashApprove setting). The core bash tool's
 * execute awaits BashApprovalBridge.confirm(); this module renders the command
 * plus a deny / allow-once / always-allow menu using the same building blocks
 * as selectors.ts. Registered via setBashApprovalBridge in app.ts —
 * interactive mode only, so print mode / RPC never prompt.
 */
import { Container, SelectList, type SelectItem, Text } from "@notshekhar/loop-tui";
import type { BashApprovalBridge, BashApprovalDecision, BashApprovalRequest } from "@notshekhar/loop-core";
import chalk from "chalk";
import type { SelectorHost } from "./selectors";
import { DynamicBorder } from "./ui/messages";
import { getSelectListTheme } from "./ui/theme";

/** Keep the prompt compact: at most this many command lines, each capped. */
const MAX_COMMAND_LINES = 6;
const MAX_LINE_CHARS = 100;

export function createBashApprovalBridge(host: SelectorHost): BashApprovalBridge {
    const showPrompt = (req: BashApprovalRequest, signal: AbortSignal | undefined): Promise<BashApprovalDecision> =>
        new Promise((resolve) => {
            const items: SelectItem[] = [
                { value: "once", label: "allow once", description: "run it this time; ask again next time" },
                ...(req.patterns.length > 0
                    ? [
                          {
                              value: "always",
                              label: "always allow",
                              description: `stop asking for: ${req.patterns.join(", ")}`,
                          },
                      ]
                    : []),
                { value: "deny", label: "deny", description: "don't run it — the agent is told you declined" },
            ];
            const list = new SelectList(items, items.length, getSelectListTheme());
            const wrapper = new Container();
            wrapper.addChild(new Text(chalk.bold.yellow(" [bash] run this command?"), 0, 0));
            const lines = req.command.split("\n");
            for (const line of lines.slice(0, MAX_COMMAND_LINES)) {
                const shown = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line;
                wrapper.addChild(new Text(chalk.cyan(` ${shown}`), 0, 0));
            }
            if (lines.length > MAX_COMMAND_LINES) {
                wrapper.addChild(new Text(chalk.dim(` … ${lines.length - MAX_COMMAND_LINES} more lines`), 0, 0));
            }
            wrapper.addChild(new DynamicBorder());
            wrapper.addChild(list);
            wrapper.addChild(new DynamicBorder());
            wrapper.addChild(new Text(chalk.dim(" ↑↓ navigate · Enter select · Esc denies"), 0, 0));

            const close = host.showSelector(wrapper, list);
            let done = false;
            const onAbort = () => finish("deny");
            const finish = (v: BashApprovalDecision) => {
                if (done) return;
                done = true;
                signal?.removeEventListener("abort", onAbort);
                close();
                resolve(v);
            };
            signal?.addEventListener("abort", onAbort);
            list.onSelect = (item) => finish(item.value as BashApprovalDecision);
            list.onCancel = () => finish("deny");
        });

    // Serialize concurrent confirm() calls (parallel bash tool calls in one
    // step, or subagents) — there is only one showSelector slot.
    let chain: Promise<unknown> = Promise.resolve();

    return {
        confirm(req, opts) {
            const signal = opts?.signal;
            const run = () => (signal?.aborted ? Promise.resolve("deny" as const) : showPrompt(req, signal));
            const p = chain.then(run, run);
            chain = p.catch(() => {});
            return p;
        },
    };
}
