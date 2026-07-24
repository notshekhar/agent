/**
 * CLI-side registry of gateway setup UIs. Parallel to the core gateway
 * registry: core knows how to run a gateway headlessly; this knows how to set
 * one up interactively in the TUI. Add a gateway → add its UI here.
 */
import type { GatewayUi } from "./types";
import { telegramGatewayUi } from "./telegram-ui";

const UIS: GatewayUi[] = [telegramGatewayUi];

export function getGatewayUi(id: string): GatewayUi | undefined {
    return UIS.find((u) => u.id === id);
}
