/**
 * Which providers the user can actually use right now: logged-in providers,
 * detected zero-login providers (local ollama daemon, AWS credentials for
 * bedrock), and saved custom gateways. Shared by the /provider picker and the
 * startup "no model selected" guidance so both agree on what "you have a
 * provider" means.
 *
 * The definition itself lives in core, beside the catalog it consults, because
 * the TUI is not the only surface that has to answer this — the Telegram and
 * web model pickers were filtering on "logged in" instead and silently hid
 * every ollama, bedrock, and custom-gateway model. Re-exported rather than
 * reimplemented so the two can never drift apart again.
 */
export { listUsableProviders } from "@notshekhar/loop-core";
