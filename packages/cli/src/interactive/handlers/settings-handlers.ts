/**
 * Settings & reload: /settings, /reload.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SelectItem } from "@notshekhar/loop-tui";
import {
    CommandRegistry,
    CONFIG_DIR_NAME,
    DEFAULT_AGENT_NAME,
    agentExists,
    bustCatalogCache,
    getCatalog,
    getMcpManager,
    getExtensionHost,
    registerBuiltins,
    settingsStore,
    type CommandContext,
} from "@notshekhar/loop-core";
import type { AppDeps } from "../deps";
import type { AppState } from "../state";
import { startMcpServers } from "../startup";
import { initTheme, initUiModeAndTheme, theme } from "../ui/theme";
import { activeUiMode, listUiModes, setActiveUiMode } from "../ui/ui-mode";
import { applyCanvasWash } from "../ui/canvas-wash";
import { currentBashAllow, currentBashDeny, runBashAllowManager, runBashDenyManager } from "./bashdeny-handlers";

type SettingsHandlers = Pick<CommandContext, "openSettings" | "reload" | "switchUiMode">;

export function createSettingsHandlers(state: AppState, deps: AppDeps): SettingsHandlers {
    const { tui, history, statusLine, commands, showWorking, hideWorking, searchOnce, promptOnce, refreshCommands } =
        deps;

    // Boolean settings toggle in place; unset falls back to the default here.
    const BOOLEAN_DEFAULTS: Record<string, boolean> = {
        subagents: true,
        memory: true,
        recap: false,
        askUser: false,
        webSearch: false,
        todos: false,
        clock: false,
        reminders: true,
        mcp: true,
        bashApprove: false,
    };
    const boolSetting = (key: string): boolean =>
        (settingsStore.get(key) as boolean | undefined) ?? BOOLEAN_DEFAULTS[key];

    // Shared by /ui <mode> and the /settings row.
    const applyUiMode = (id: string): boolean => {
        if (!setActiveUiMode(id)) return false;
        settingsStore.set("uiMode", id);
        // Re-resolve the theme for the new mode (its own uiThemes entry or
        // its default), then re-wash and repaint everything.
        initUiModeAndTheme();
        applyCanvasWash();
        tui.invalidate();
        history.addSystem(`ui mode → ${id}`);
        tui.requestRender(true);
        return true;
    };

    return {
        switchUiMode(args) {
            const available = listUiModes()
                .map((m) => m.id)
                .join(", ");
            const id = (args ?? "").trim();
            if (!id) {
                history.addSystem(`ui mode: ${activeUiMode().id} (available: ${available}) — switch with /ui <mode>`);
                tui.requestRender();
                return;
            }
            if (!applyUiMode(id)) {
                history.addError(`unknown ui mode: ${id} (available: ${available})`);
                tui.requestRender();
            }
        },
        async openSettings() {
            // Loop so Esc on the value prompt returns to the settings picker
            // instead of bailing out of /settings entirely. `lastIndex` re-opens
            // the picker on the row the user just acted on (toggles, value edits)
            // instead of snapping back to the top.
            let lastIndex = 0;
            while (true) {
                const items: SelectItem[] = [
                    { value: "uiMode", label: `uiMode: ${activeUiMode().id}` },
                    // The ACTIVE theme's name — per-mode themes made the raw
                    // `theme` settings key wrong outside loop mode (it showed
                    // loop's theme while grok's was active).
                    { value: "theme", label: `theme: ${theme.name}` },
                    {
                        value: "maxSteps",
                        label: `maxSteps: ${(settingsStore.get("maxSteps") as number) || "unlimited"}`,
                    },
                    {
                        value: "autoCompactThreshold",
                        label: `autoCompactThreshold: ${settingsStore.get("autoCompactThreshold") ?? 0.8}`,
                    },
                    {
                        value: "workspaceContext",
                        label: `workspaceContext: ${settingsStore.get("workspaceContext") ?? true}`,
                    },
                    {
                        value: "subagents",
                        label: `subagents (task tool): ${boolSetting("subagents") ? "on" : "off"}`,
                        description: "let agents delegate work to subagents via the task tool",
                    },
                    {
                        value: "subagentModel",
                        label: `subagentModel: ${(settingsStore.get("subagentModel") as string) ?? "inherit"}`,
                        description:
                            "default model for subagents (an agent's own model: wins) — inherit = parent's model",
                    },
                    {
                        value: "subagentMaxParallel",
                        label: `subagentMaxParallel: ${(settingsStore.get("subagentMaxParallel") as number) ?? 4}`,
                        description: "concurrent subagent streams when tasks fan out (0 = unlimited)",
                    },
                    {
                        value: "memory",
                        label: `memory: ${boolSetting("memory") ? "on" : "off"}`,
                        description: `agent saves per-project facts across sessions (~/${CONFIG_DIR_NAME}/agent/memory)`,
                    },
                    {
                        value: "recap",
                        label: `recap: ${boolSetting("recap") ? "on" : "off"}`,
                        description: "short AI-generated recap under responses that changed files",
                    },
                    {
                        value: "askUser",
                        label: `ask user (questions tool): ${boolSetting("askUser") ? "on" : "off"}`,
                        description: "let the agent pause mid-turn to ask you multiple-choice questions",
                    },
                    {
                        value: "webSearch",
                        label: `websearch (DuckDuckGo): ${boolSetting("webSearch") ? "on" : "off"}`,
                        description:
                            "give the agent a websearch tool (scrapes DuckDuckGo — no API key, may rate-limit)",
                    },
                    {
                        value: "todos",
                        label: `todos: ${boolSetting("todos") ? "on" : "off"}`,
                        description: "pinned checklist the agent maintains during multi-step tasks",
                    },
                    {
                        value: "clock",
                        label: `clock: ${boolSetting("clock") ? "on" : "off"}`,
                        description: "live date + hh:mm:ss in the status line",
                    },
                    {
                        value: "reminders",
                        label: `reminders: ${boolSetting("reminders") ? "on" : "off"}`,
                        description: "fire /reminder alerts; off mutes them without deleting any",
                    },
                    {
                        value: "mcp",
                        label: `mcp servers: ${boolSetting("mcp") ? "on" : "off"}`,
                        description: "connect configured MCP servers and expose their tools (/mcp to manage)",
                    },
                    {
                        value: "bashDeny",
                        label: `bash denylist: ${currentBashDeny().length} blocked`,
                        description: "add/remove bash commands the agent is refused (guardrail)",
                    },
                    {
                        value: "bashApprove",
                        label: `bash approval: ${boolSetting("bashApprove") ? "on" : "off"}`,
                        description: "ask before every bash command — deny / allow once / always allow",
                    },
                    {
                        value: "bashAllow",
                        label: `bash allowlist: ${currentBashAllow().length} always-allowed`,
                        description: "commands the approval prompt skips (“always allow” entries)",
                    },
                ];
                const pick = await searchOnce(items, "Settings (type to filter, Esc to close)", {
                    initialIndex: lastIndex,
                });
                if (!pick) return;
                lastIndex = Math.max(
                    0,
                    items.findIndex((i) => i.value === pick.value),
                );
                // Sub-flow: open the denylist manager, then return to settings.
                if (pick.value === "bashDeny") {
                    await runBashDenyManager(deps);
                    continue;
                }
                if (pick.value === "bashAllow") {
                    await runBashAllowManager(deps);
                    continue;
                }
                // Default subagent model: cross-provider picker (subagents may
                // run on a different provider than the session) + "inherit".
                // An agent file's own `model:` still wins over this setting.
                if (pick.value === "subagentModel") {
                    const INHERIT = "\x00inherit";
                    const cat = await getCatalog();
                    const cur = settingsStore.get("subagentModel") as string | undefined;
                    const modelItems: SelectItem[] = [
                        {
                            value: INHERIT,
                            label: "inherit (parent's model)",
                            description: cur ? "clear the override" : "(current)",
                        },
                        ...Object.values(cat)
                            .filter((m) => m.available)
                            .sort((a, b) => a.id.localeCompare(b.id))
                            .map((m) => ({
                                value: m.id,
                                label: m.id + (m.id === cur ? "  (current)" : ""),
                                description: `${m.name}  ·  ctx ${m.contextWindow.toLocaleString()}  ·  $${m.cost.input}/$${m.cost.output}`,
                            })),
                    ];
                    const mPick = await searchOnce(modelItems, "Subagent model (type to filter)");
                    if (!mPick) continue;
                    const chosen = mPick.value === INHERIT ? undefined : mPick.value;
                    settingsStore.set("subagentModel", chosen);
                    history.addSystem(`subagentModel → ${chosen ?? "inherit"}`);
                    tui.requestRender();
                    continue;
                }
                if (pick.value in BOOLEAN_DEFAULTS) {
                    const next = !boolSetting(pick.value);
                    settingsStore.set(pick.value, next);
                    deps.syncTicker(); // clock toggle starts/stops the 1s status line pulse
                    history.addSystem(`${pick.value} → ${next ? "on" : "off"}`);
                    // MCP toggle connects/tears down servers live so the change
                    // takes effect this session without a /reload. startMcpServers
                    // re-checks the (now-updated) setting + trust itself.
                    if (pick.value === "mcp") {
                        if (next) startMcpServers(state, deps);
                        else void getMcpManager().close();
                    }
                    tui.requestRender();
                    continue;
                }
                // Theme gets a picker (built-ins + ~/.loop/agent/themes/*.json) and
                // applies live — the global theme proxy makes themed components
                // re-resolve colors on the next render.
                // UI mode gets a picker of registered modes and applies live,
                // same as /ui <mode>.
                if (pick.value === "uiMode") {
                    const cur = activeUiMode().id;
                    const modeItems: SelectItem[] = listUiModes().map((m) => ({
                        value: m.id,
                        label: m.name ?? m.id,
                        description: m.id === cur ? "(current)" : "",
                    }));
                    const mPick = await searchOnce(modeItems, "UI mode (type to filter)");
                    if (!mPick) continue;
                    applyUiMode(mPick.value);
                    continue;
                }
                if (pick.value === "theme") {
                    const customDir = join(process.env.HOME ?? "", CONFIG_DIR_NAME, "agent", "themes");
                    const custom = existsSync(customDir)
                        ? readdirSync(customDir)
                              .filter((f) => f.endsWith(".json"))
                              .map((f) => f.replace(/\.json$/, ""))
                        : [];
                    // The active UI mode's own themes head the list (loop:
                    // dark/light); the pick persists per mode — loop keeps the
                    // legacy `theme` key, other modes write uiThemes.<id>.
                    const mode = activeUiMode();
                    const builtin = mode.themes.map((t) => t.name);
                    // What's actually rendering right now — not a settings-key
                    // reconstruction (that's how the row label bug happened).
                    const cur = theme.name;
                    const themeItems: SelectItem[] = [...builtin, ...custom].map((n) => ({
                        value: n,
                        label: n,
                        description: n === cur ? "(current)" : "",
                    }));
                    const tPick = await searchOnce(themeItems, "Theme (type to filter)");
                    if (!tPick) continue;
                    if (mode.id === "loop") {
                        settingsStore.set("theme", tPick.value);
                    } else {
                        const perMode = (settingsStore.get("uiThemes") as Record<string, string> | undefined) ?? {};
                        settingsStore.set("uiThemes", { ...perMode, [mode.id]: tPick.value });
                    }
                    initTheme(tPick.value);
                    applyCanvasWash();
                    tui.invalidate();
                    history.addSystem(`theme → ${tPick.value}`);
                    tui.requestRender(true);
                    continue;
                }
                history.addSystem(`enter new value for ${pick.value}: (Esc to go back)`);
                tui.requestRender();
                const v = await promptOnce("");
                if (!v) continue;
                const key = pick.value;
                const cur = settingsStore.get(key);
                // Numeric settings stay numeric even when currently unset
                // (typeof undefined check alone would store the string).
                const NUMERIC_KEYS = new Set(["maxSteps", "autoCompactThreshold", "subagentMaxParallel"]);
                const parsed =
                    typeof cur === "number" || NUMERIC_KEYS.has(key)
                        ? Number(v)
                        : typeof cur === "boolean"
                          ? v === "true"
                          : v;
                settingsStore.set(key, parsed);
                history.addSystem(`${key} → ${parsed}`);
                tui.requestRender();
            }
        },
        async reload() {
            // Hard reload: every config surface re-read from disk, models
            // re-fetched from the network (blocking, so the result is real).
            showWorking("Reloading");
            tui.requestRender();
            try {
                // Drop the cached settings.json so every getSetting below (theme,
                // hooks, mcp gating, mcpServers) reads the on-disk values. Without
                // this the "hard reload" silently served stale cached config.
                settingsStore.refresh();

                // UI mode + theme (settings may have changed on disk).
                initUiModeAndTheme();
                applyCanvasWash();

                // Commands: prompts, skills, agents — rebuilt from disk.
                const fresh = new CommandRegistry();
                await registerBuiltins(fresh, { cwd: state.cwd });
                // Re-apply extension command contributions so /reload keeps them
                // (no-op when no extensions are loaded).
                getExtensionHost().applyCommands(fresh);
                (commands as unknown as { commands: Map<string, unknown> }).commands = (
                    fresh as unknown as { commands: Map<string, unknown> }
                ).commands;
                refreshCommands();

                // Active agent may have been deleted on disk meanwhile.
                if (!agentExists(state.agent)) {
                    state.agent = DEFAULT_AGENT_NAME;
                    settingsStore.set("agent", DEFAULT_AGENT_NAME);
                }
                statusLine.setAgent(state.agent);

                // Models: force-refresh availability + model definitions.
                bustCatalogCache();
                const cat = await getCatalog({ refresh: true });
                const available = Object.values(cat).filter((m) => m.available).length;

                // MCP: tear down and reconnect so added/removed/edited servers in
                // settings.json take effect. close() resets the manager's
                // `initialized` flag (init() is otherwise a no-op once connected);
                // startMcpServers re-gates on the now-fresh mcp toggle + trust and
                // reconnects in the background.
                await getMcpManager().close();
                startMcpServers(state, deps);

                tui.invalidate();
                history.addSystem(
                    `reloaded — settings, theme, commands, agents, hooks config, models (${available}/${Object.keys(cat).length} available)`,
                );
            } catch (err) {
                history.addError(`reload failed: ${err instanceof Error ? err.message : String(err)}`);
            } finally {
                hideWorking();
            }
            tui.requestRender(true);
        },
    };
}
