/**
 * /permissions — manage the permission rules (settings.json `permissions`).
 *
 * Rules are allow/ask/deny strings over the tools ("Bash(git *)",
 * "Read(secrets/**)"; see loop://docs/permissions.md). This UI edits the
 * GLOBAL rule set; project rules stay hand-edited in the project's
 * settings.json so they can be reviewed and committed with the repo.
 */
import type { SelectItem } from "@notshekhar/loop-tui";
import {
    clearPermissionRulesCache,
    parseRuleString,
    settingsStore,
    type CommandContext,
    type PermissionAction,
    type PermissionsSetting,
} from "@notshekhar/loop-core";
import type { AppDeps } from "../deps";
import type { AppState } from "../state";
import { dim, err, warn } from "../ui/text";

type PermissionHandlers = Pick<CommandContext, "managePermissions">;

const ACTIONS: PermissionAction[] = ["deny", "ask", "allow"];

const ACTION_HINT: Record<PermissionAction, string> = {
    deny: "always refused — wins over everything",
    ask: "always prompts for approval (fails closed headless)",
    allow: "runs without the approval prompt",
};

function currentPermissions(): PermissionsSetting {
    const stored = settingsStore.get("permissions") as PermissionsSetting | undefined;
    return {
        deny: [...(stored?.deny ?? [])],
        ask: [...(stored?.ask ?? [])],
        allow: [...(stored?.allow ?? [])],
    };
}

function save(perms: PermissionsSetting): void {
    // Drop empty sections so an untouched settings.json stays minimal.
    const compact: PermissionsSetting = {};
    for (const action of ACTIONS) {
        const list = perms[action];
        if (list && list.length > 0) compact[action] = list;
    }
    if (Object.keys(compact).length > 0) settingsStore.set("permissions", compact);
    else settingsStore.delete("permissions");
    // Rules are cached per-cwd for a couple of seconds — apply edits now.
    clearPermissionRulesCache();
}

/** The interactive rule manager. Shared by /permissions and the /settings row. */
export async function runPermissionsManager(deps: AppDeps): Promise<void> {
    const { tui, history, selectOnce, searchOnce, promptOnce } = deps;

    let lastIndex = 0;
    while (true) {
        const perms = currentPermissions();
        const total = ACTIONS.reduce((n, a) => n + (perms[a]?.length ?? 0), 0);
        const items: SelectItem[] = [
            {
                value: "+add",
                label: "+ add rule",
                description: 'e.g. deny "Bash(rm -rf *)" or allow "Bash(git *)" — syntax: docs/permissions.md',
            },
            ...ACTIONS.flatMap(
                (action) =>
                    perms[action]?.map((rule, i) => ({
                        value: `${action}:${i}`,
                        label: `${action}  ${rule}`,
                        description: "select to remove",
                    })) ?? [],
            ),
        ];
        const pick = await searchOnce(items, `Permission rules · ${total} (deny > ask > allow)`, {
            initialIndex: lastIndex,
        });
        if (!pick) return;
        lastIndex = Math.max(
            0,
            items.findIndex((i) => i.value === pick.value),
        );

        if (pick.value === "+add") {
            const action = await selectOnce(
                ACTIONS.map((a) => ({ value: a, label: a, description: ACTION_HINT[a] })),
                "Rule action",
            );
            if (!action) continue;
            const raw = (await promptOnce('rule (e.g. "Bash(git *)", "Read(secrets/**)", bare "Read", or "*")')).trim();
            if (!raw) continue;
            const parsed = parseRuleString(action.value as PermissionAction, raw);
            if (!parsed) {
                history.addSystem(
                    err(`unrecognized rule: ${raw}`) + dim(" — expected Tool(pattern), a bare tool name, or *"),
                );
                tui.requestRender();
                continue;
            }
            const list = perms[action.value as PermissionAction] ?? [];
            if (list.includes(raw)) {
                history.addSystem(warn(`"${raw}" is already a ${action.value} rule`));
                tui.requestRender();
                continue;
            }
            perms[action.value as PermissionAction] = [...list, raw];
            save(perms);
            history.addSystem(`${action.value} rule added: "${raw}"`);
            tui.requestRender();
            continue;
        }

        // Existing rule → confirm removal.
        const sep = pick.value.indexOf(":");
        const action = pick.value.slice(0, sep) as PermissionAction;
        const idx = Number(pick.value.slice(sep + 1));
        const rule = perms[action]?.[idx];
        if (rule === undefined) continue;
        const confirm = await selectOnce(
            [
                { value: "remove", label: "remove", description: `drop the ${action} rule "${rule}"` },
                { value: "cancel", label: "cancel", description: "keep it" },
            ],
            `${action} "${rule}"`,
        );
        if (!confirm || confirm.value !== "remove") continue;
        perms[action] = (perms[action] ?? []).filter((_, i) => i !== idx);
        save(perms);
        history.addSystem(`removed ${action} rule "${rule}"`);
        tui.requestRender();
    }
}

export function createPermissionHandlers(_state: AppState, deps: AppDeps): PermissionHandlers {
    return {
        managePermissions: () => runPermissionsManager(deps),
    };
}
