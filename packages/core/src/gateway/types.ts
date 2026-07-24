/**
 * Gateway framework: a chat surface that drives the agent remotely — Telegram
 * today, Slack/Discord/others later. A Gateway owns its transport and its
 * agent-driving bridge; this layer is the common lifecycle every gateway
 * shares (configure, enable, start/stop, report status) so the TUI's
 * /gateways manager, the `loop gateways` daemon, and app auto-start treat them
 * uniformly. Headless by design — no TUI or CLI dependency — so the daemon can
 * run a gateway with no terminal.
 */

export interface GatewayStatus {
    /** Credentials are stored — the gateway can be enabled. */
    configured: boolean;
    /** The master switch is on (and configured). */
    enabled: boolean;
    /** One-line summary for the settings row and list ("@bot · connected"). */
    summary: string;
    /** Extra lines for `loop gateways status` (paired chat, links, …). */
    detail: string[];
}

/** A running gateway; stop() releases its transport (poll slot, socket, …). */
export interface GatewayHandle {
    stop(): void;
}

export interface GatewayStartOpts {
    /** Default working directory for sessions this gateway creates. */
    cwd?: string;
    /** Sink for low-frequency diagnostics (pairing, poll errors). */
    log?: (line: string) => void;
}

/**
 * A remote chat gateway. Implementations wrap a transport-specific bridge
 * (e.g. TelegramBridge) behind this uniform lifecycle. Config lives in the
 * gateway's own store; these methods read/write it and start/stop the live
 * bridge.
 */
export interface Gateway {
    /** Stable id ("telegram") — used in callbacks, daemon args, the UI registry. */
    readonly id: string;
    /** Human label ("Telegram"). */
    readonly displayName: string;
    /** Config-derived status; cheap (store reads only), no network. */
    status(): GatewayStatus;
    isConfigured(): boolean;
    isEnabled(): boolean;
    setEnabled(enabled: boolean): void;
    /** Forget all credentials — the gateway returns to unconfigured. */
    disconnect(): void;
    /** Validate credentials and begin serving; rejects on a bad/absent config. */
    start(opts: GatewayStartOpts): Promise<GatewayHandle>;
}
