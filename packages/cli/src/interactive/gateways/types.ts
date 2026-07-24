import type { AppDeps } from "../deps";
import type { AppState } from "../state";

/**
 * The interactive setup surface for one gateway, reached from /gateways. Setup
 * is inherently gateway-specific (Telegram pastes a bot token and pairs; a
 * future Slack gateway would OAuth), so each gateway owns its own manager
 * screen. The generic /gateways list dispatches into run().
 */
export interface GatewayUi {
    id: string;
    run(state: AppState, deps: AppDeps): Promise<void>;
}
