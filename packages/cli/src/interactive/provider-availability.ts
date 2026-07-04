/**
 * Which providers the user can actually use right now: logged-in providers,
 * detected zero-login providers (local ollama daemon, AWS credentials for
 * bedrock), and saved custom gateways. Shared by the
 * /provider picker and the startup "no model selected" guidance so both agree
 * on what "you have a provider" means.
 */
import { getCatalog, listAuthorizedProviders, listCustomProviders, type ProviderId } from "@notshekhar/loop-core";

export async function listUsableProviders(): Promise<ProviderId[]> {
    const providers = [...listAuthorizedProviders()];

    // Zero-login providers need no /login: ollama whenever the daemon is
    // detected, bedrock whenever AWS credentials put models in the catalog.
    const ZERO_LOGIN = new Set<ProviderId>(["ollama", "bedrock"]);
    const catalog = await getCatalog();
    for (const model of Object.values(catalog)) {
        if (model.available && ZERO_LOGIN.has(model.provider) && !providers.includes(model.provider)) {
            providers.push(model.provider);
        }
    }

    for (const custom of listCustomProviders()) {
        const id = `custom:${custom.name}` as ProviderId;
        if (!providers.includes(id)) providers.push(id);
    }

    return providers;
}
