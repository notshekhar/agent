/**
 * Persisted helper-minted keys for custom providers, keyed by provider name
 * under `customHelper` in ~/.loop/auth.json (0600). Helpers are often
 * interactive (a vendor login command that opens a browser) — persisting the
 * key with its expiry means a loop restart inside the key's lifetime doesn't
 * re-run the command. Same isolation rationale as custom-oauth-store.
 */
import { authStore } from "./storage";

export interface HelperKey {
    key: string;
    /** Absolute epoch-ms after which the key must be re-minted. */
    expires: number;
}

type KeyMap = Record<string, HelperKey>;

function readAll(): KeyMap {
    return (authStore.get("customHelper") as KeyMap) ?? {};
}

export function getHelperKey(name: string): HelperKey | undefined {
    return readAll()[name];
}

export function saveHelperKey(name: string, entry: HelperKey): void {
    authStore.set("customHelper", { ...readAll(), [name]: entry });
}

export function clearHelperKey(name: string): void {
    const all = readAll();
    if (!(name in all)) return;
    delete all[name];
    authStore.set("customHelper", all);
}

export function clearAllHelperKeys(): void {
    authStore.set("customHelper", {});
}
