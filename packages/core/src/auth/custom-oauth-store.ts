/**
 * Persisted OAuth sessions for custom providers, keyed by provider name under
 * `customOAuth` in ~/.loop/auth.json (0600). Separate from the builtin
 * `providers` map so custom names can never collide with provider ids, and
 * separate from the provider config so deleting/re-adding a provider config
 * doesn't silently orphan tokens.
 */
import { authStore } from "./storage";
import type { GenericOAuthCredentials } from "../types";

type CredsMap = Record<string, GenericOAuthCredentials>;

function readAll(): CredsMap {
    return (authStore.get("customOAuth") as CredsMap) ?? {};
}

export function getCustomOAuthCreds(name: string): GenericOAuthCredentials | undefined {
    return readAll()[name];
}

export function saveCustomOAuthCreds(name: string, creds: GenericOAuthCredentials): void {
    authStore.set("customOAuth", { ...readAll(), [name]: creds });
}

export function clearCustomOAuthCreds(name: string): void {
    const all = readAll();
    if (!(name in all)) return;
    delete all[name];
    authStore.set("customOAuth", all);
}
