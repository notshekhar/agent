/**
 * The set of known gateways. Adding a gateway is: implement the Gateway
 * interface, register it here, and (for TUI setup) add a CLI-side UI. The
 * daemon, /gateways manager, and auto-start all iterate this list — none of
 * them names a specific gateway.
 */
import type { Gateway } from "./types";
import { telegramGateway } from "./telegram-gateway";

const GATEWAYS: Gateway[] = [telegramGateway];

export function listGateways(): Gateway[] {
    return GATEWAYS.slice();
}

export function getGateway(id: string): Gateway | undefined {
    return GATEWAYS.find((g) => g.id === id);
}

/** Configured + enabled gateways — what auto-start and the daemon bring up. */
export function listEnabledGateways(): Gateway[] {
    return GATEWAYS.filter((g) => g.isEnabled());
}

/** Any gateway with stored credentials (enabled or not). */
export function listConfiguredGateways(): Gateway[] {
    return GATEWAYS.filter((g) => g.isConfigured());
}
