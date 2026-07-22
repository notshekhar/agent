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
            const kind = req.kind ?? "bash";
            // Path/plan prompts are once-or-deny only; bash prompts offer the
            // persisted always/never pair when there are patterns to remember.
            const onceLabel = kind === "bash" ? "allow once" : "allow";
            const items: SelectItem[] = [
                { value: "once", label: onceLabel, description: "approve this time; ask again next time" },
                ...(kind === "bash" && req.patterns.length > 0
                    ? [
                          {
                              value: "always",
                              label: "always allow (this project)",
                              description: `stop asking here for: ${req.patterns.join(", ")}`,
                          },
                          {
                              value: "never",
                              label: "never allow",
                              description: `refuse and add to the denylist: ${req.patterns.join(", ")}`,
                          },
                      ]
                    : []),
                { value: "deny", label: "deny", description: "refuse — the agent is told you declined" },
            ];
            const headline =
                kind === "path"
                    ? " [permission] allow this file access?"
                    : kind === "plan"
                      ? " [plan] the agent wants to enter plan mode"
                      : " [bash] run this command?";
            const list = new SelectList(items, items.length, getSelectListTheme());
            const wrapper = new Container();
            wrapper.addChild(new Text(chalk.bold.yellow(headline), 0, 0));
            if (req.title) wrapper.addChild(new Text(chalk.dim(` ${req.title}`), 0, 0));
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

            const statusLabel =
                kind === "path" ? "file access approval" : kind === "plan" ? "plan approval" : "bash approval";
            const close = host.showSelector(wrapper, list, statusLabel);
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
