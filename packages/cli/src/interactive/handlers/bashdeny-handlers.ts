/**
 * /bashdeny — manage the bash denylist guardrail (settings.json `bashDeny`).
 *
 * The denylist refuses bash commands by name (optionally + subcommand, e.g.
 * "git commit"). This UI lets the user add/remove entries without editing JSON.
 * An unset `bashDeny` means "use the seeded defaults"; the first edit here
 * materializes the resolved list so the user takes explicit ownership.
 *
 * Also home to the mirror-image allowlist manager (settings.json `bashAllow`):
 * the "always allow" entries the bashApprove prompt persists, editable from
 * the /settings "bash allowlist" row.
 */
import type { SelectItem } from "@notshekhar/loop-tui";
import chalk from "chalk";
import { DEFAULT_BASH_DENY, denyPattern, settingsStore, type CommandContext } from "@notshekhar/loop-core";
import type { AppDeps } from "../deps";
import type { AppState } from "../state";

type BashDenyHandlers = Pick<CommandContext, "manageBashDeny">;

/**
 * Resolved denylist as plain pattern strings: explicit setting if present, else
 * the seeded defaults. Legacy `{pattern,reason}` objects from older settings are
 * coerced to their pattern (and rewritten as strings on the next save).
 */
export function currentBashDeny(): string[] {
    const stored = settingsStore.get("bashDeny") as unknown[] | undefined;
    if (!stored) return [...DEFAULT_BASH_DENY];
    return stored.map(denyPattern).filter((p) => p.length > 0);
}

/**
 * The interactive denylist manager. Shared by the /bashdeny command and the
 * /settings "Bash denylist" row, so both surface the same flow.
 */
export async function runBashDenyManager(deps: AppDeps): Promise<void> {
    const { tui, history, selectOnce, searchOnce, promptOnce } = deps;
    // Always persist plain strings — this also migrates any legacy object form.
    const save = (entries: string[]): void => settingsStore.set("bashDeny", entries);

    // Loop so removing/adding returns to the list, like /agents.
    let lastIndex = 0;
    while (true) {
        const entries = currentBashDeny();
        const usingDefaults = settingsStore.get("bashDeny") === undefined;

        const items: SelectItem[] = [
            { value: "+add", label: "+ add command", description: 'block a command (e.g. "rm" or "git commit")' },
            ...entries.map((pattern, i) => ({
                value: `i:${i}`,
                label: pattern,
                description: "select to remove",
            })),
        ];

        const title = usingDefaults
            ? `Bash denylist · ${entries.length} (defaults — editing takes ownership)`
            : `Bash denylist · ${entries.length}`;
        // searchOnce gives a type-to-filter box so a long denylist stays navigable.
        const pick = await searchOnce(items, title, { initialIndex: lastIndex });
        if (!pick) return;
        lastIndex = Math.max(
            0,
            items.findIndex((i) => i.value === pick.value),
        );

        if (pick.value === "+add") {
            const pattern = (await promptOnce('command to block (e.g. "rm" or "git commit")')).trim();
            if (!pattern) continue;
            if (entries.includes(pattern)) {
                history.addSystem(chalk.yellow(`"${pattern}" is already in the denylist`));
                tui.requestRender();
                continue;
            }
            save([...entries, pattern]);
            history.addSystem(`blocked "${pattern}"`);
            tui.requestRender();
            continue;
        }

        // Existing entry → confirm removal.
        const idx = Number(pick.value.slice(2));
        const pattern = entries[idx];
        const action = await selectOnce(
            [
                { value: "remove", label: "remove", description: `stop blocking "${pattern}"` },
                { value: "cancel", label: "cancel", description: "keep it" },
            ],
            `"${pattern}"`,
        );
        if (!action || action.value !== "remove") continue;
        save(entries.filter((_, i) => i !== idx));
        history.addSystem(`unblocked "${pattern}"`);
        tui.requestRender();
    }
}

/** Resolved approval allowlist (settings.json `bashAllow`) as pattern strings. */
export function currentBashAllow(): string[] {
    const stored = settingsStore.get("bashAllow") as unknown[] | undefined;
    if (!stored) return [];
    return stored.map(denyPattern).filter((p) => p.length > 0);
}

/**
 * Manager for the bashApprove allowlist ("always allow" entries). Reached from
 * the /settings "bash allowlist" row; same flow as the denylist manager.
 */
export async function runBashAllowManager(deps: AppDeps): Promise<void> {
    const { tui, history, selectOnce, searchOnce, promptOnce } = deps;
    const save = (entries: string[]): void => settingsStore.set("bashAllow", entries);

    let lastIndex = 0;
    while (true) {
        const entries = currentBashAllow();
        const items: SelectItem[] = [
            {
                value: "+add",
                label: "+ add command",
                description: 'run without asking (e.g. "ls" or "git status") — only used while bash approval is on',
            },
            ...entries.map((pattern, i) => ({
                value: `i:${i}`,
                label: pattern,
                description: "select to remove",
            })),
        ];
        const pick = await searchOnce(items, `Bash allowlist · ${entries.length} always-allowed`, {
            initialIndex: lastIndex,
        });
        if (!pick) return;
        lastIndex = Math.max(
            0,
            items.findIndex((i) => i.value === pick.value),
        );

        if (pick.value === "+add") {
            const pattern = (await promptOnce('command to always allow (e.g. "ls" or "git status")')).trim();
            if (!pattern) continue;
            if (entries.includes(pattern)) {
                history.addSystem(chalk.yellow(`"${pattern}" is already in the allowlist`));
                tui.requestRender();
                continue;
            }
            save([...entries, pattern]);
            history.addSystem(`always allowing "${pattern}"`);
            tui.requestRender();
            continue;
        }

        const idx = Number(pick.value.slice(2));
        const pattern = entries[idx];
        const action = await selectOnce(
            [
                { value: "remove", label: "remove", description: `ask again before running "${pattern}"` },
                { value: "cancel", label: "cancel", description: "keep it" },
            ],
            `"${pattern}"`,
        );
        if (!action || action.value !== "remove") continue;
        save(entries.filter((_, i) => i !== idx));
        history.addSystem(`removed "${pattern}" from the allowlist`);
        tui.requestRender();
    }
}

export function createBashDenyHandlers(_state: AppState, deps: AppDeps): BashDenyHandlers {
    return {
        manageBashDeny: () => runBashDenyManager(deps),
    };
}
