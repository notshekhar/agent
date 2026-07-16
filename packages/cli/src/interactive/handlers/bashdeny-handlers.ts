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
import {
    canonicalProjectDir,
    DEFAULT_BASH_DENY,
    denyPattern,
    getProjectBashAllow,
    setProjectBashAllow,
    settingsStore,
    type CommandContext,
} from "@notshekhar/loop-core";
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

/** Resolved GLOBAL approval allowlist (settings.json `bashAllow`). New grants
 * persist per-project (projects table); this legacy list still matches. */
export function currentBashAllow(): string[] {
    const stored = settingsStore.get("bashAllow") as unknown[] | undefined;
    if (!stored) return [];
    return stored.map(denyPattern).filter((p) => p.length > 0);
}

/**
 * Manager for the bashApprove "always allow" entries. Two stores share the
 * list: per-project grants (what the approval prompt persists — scoped to
 * this project only) and the legacy global settings.bashAllow. Adds land in
 * the project store; removes hit whichever store the entry lives in.
 */
export async function runBashAllowManager(deps: AppDeps, cwd: string): Promise<void> {
    const { tui, history, selectOnce, searchOnce, promptOnce } = deps;
    const projectDir = canonicalProjectDir(cwd);
    const saveGlobal = (entries: string[]): void => settingsStore.set("bashAllow", entries);

    let lastIndex = 0;
    while (true) {
        const projectEntries = getProjectBashAllow(projectDir);
        const globalEntries = currentBashAllow();
        const items: SelectItem[] = [
            {
                value: "+add",
                label: "+ add command",
                description: 'always allow in this project (e.g. "ls" or "git status")',
            },
            ...projectEntries.map((pattern, i) => ({
                value: `p:${i}`,
                label: pattern,
                description: "this project — select to remove",
            })),
            ...globalEntries.map((pattern, i) => ({
                value: `g:${i}`,
                label: pattern,
                description: "all projects (global) — select to remove",
            })),
        ];
        const pick = await searchOnce(
            items,
            `Bash allowlist · ${projectEntries.length} project + ${globalEntries.length} global`,
            { initialIndex: lastIndex },
        );
        if (!pick) return;
        lastIndex = Math.max(
            0,
            items.findIndex((i) => i.value === pick.value),
        );

        if (pick.value === "+add") {
            const pattern = (await promptOnce('command to always allow here (e.g. "ls" or "git status")')).trim();
            if (!pattern) continue;
            if (projectEntries.includes(pattern) || globalEntries.includes(pattern)) {
                history.addSystem(chalk.yellow(`"${pattern}" is already in the allowlist`));
                tui.requestRender();
                continue;
            }
            setProjectBashAllow(projectDir, [...projectEntries, pattern]);
            history.addSystem(`always allowing "${pattern}" in this project`);
            tui.requestRender();
            continue;
        }

        const isProject = pick.value.startsWith("p:");
        const idx = Number(pick.value.slice(2));
        const pattern = isProject ? projectEntries[idx] : globalEntries[idx];
        const action = await selectOnce(
            [
                { value: "remove", label: "remove", description: `ask again before running "${pattern}"` },
                { value: "cancel", label: "cancel", description: "keep it" },
            ],
            `"${pattern}"`,
        );
        if (!action || action.value !== "remove") continue;
        if (isProject) {
            setProjectBashAllow(
                projectDir,
                projectEntries.filter((_, i) => i !== idx),
            );
        } else {
            saveGlobal(globalEntries.filter((_, i) => i !== idx));
        }
        history.addSystem(`removed "${pattern}" from the allowlist`);
        tui.requestRender();
    }
}

export function createBashDenyHandlers(_state: AppState, deps: AppDeps): BashDenyHandlers {
    return {
        manageBashDeny: () => runBashDenyManager(deps),
    };
}
