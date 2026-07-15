/**
 * Persistence for the `loop serve` auth token, isolated in its own module so
 * tests can mock it in-memory (same pattern as auth/custom-helper-store) —
 * the token lives in auth.json next to provider credentials, which is exactly
 * the file tests must never touch.
 */
import { authStore } from "../auth/storage";

export function getStoredServeToken(): string | undefined {
    const v = authStore.get("serveToken");
    return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function storeServeToken(token: string): void {
    authStore.set("serveToken", token);
}
