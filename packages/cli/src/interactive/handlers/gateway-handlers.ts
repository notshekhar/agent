/**
 * /gateways: the manager for remote chat gateways (Telegram now; Slack/Discord
 * later). Lists every gateway with live status and drills into each one's own
 * setup screen. Also the /settings → gateways row via gatewaysStatusLabel.
 */
import type { SelectItem } from "@notshekhar/loop-tui";
import { isGatewayRunning, listConfiguredGateways, listGateways, type CommandContext } from "@notshekhar/loop-core";
import type { AppDeps } from "../deps";
import type { AppState } from "../state";
import { getGatewayUi } from "../gateways/registry";

type GatewayHandlers = Pick<CommandContext, "manageGateways">;

/** One-line status across gateways for the /settings row. */
export function gatewaysStatusLabel(): string {
    const configured = listConfiguredGateways();
    if (!configured.length) return "none set up";
    return configured.map((g) => `${g.id} ${isGatewayRunning(g.id) ? "running" : g.status().summary}`).join(", ");
}

/** Live label for a gateway in the list: running state wins over config state. */
function gatewayLabel(id: string, displayName: string, summary: string): string {
    if (isGatewayRunning(id)) return `${displayName} — running`;
    return `${displayName} — ${summary}`;
}

export async function runGatewaysManager(state: AppState, deps: AppDeps): Promise<void> {
    const { history, tui, searchOnce } = deps;
    while (true) {
        const gws = listGateways();
        const items: SelectItem[] = gws.map((g) => ({
            value: g.id,
            label: gatewayLabel(g.id, g.displayName, g.status().summary),
            description: g.isConfigured() ? "manage or view status" : "set up this gateway",
        }));
        const pick = await searchOnce(items, "Gateways — remote chat control (Esc to close)");
        if (!pick) return;
        const ui = getGatewayUi(pick.value);
        if (ui) {
            await ui.run(state, deps);
        } else {
            history.addSystem(`no setup UI for gateway: ${pick.value}`);
            tui.requestRender();
        }
    }
}

export function createGatewayHandlers(state: AppState, deps: AppDeps): GatewayHandlers {
    return {
        manageGateways: () => runGatewaysManager(state, deps),
    };
}
