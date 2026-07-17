import { afterEach, describe, expect, mock, test } from "bun:test";

// In-memory replacement for the CachedStore-backed stores so tests NEVER touch
// the real ~/.loop/auth.json. Do not "isolate" by faking $HOME instead: Bun's
// os.homedir() ignores runtime HOME changes, so a faked HOME still resolves to
// the real config dir and writes clobber the user's actual credentials.
class MemStore {
    private data: Record<string, unknown>;
    constructor(_id: string, defaults: Record<string, unknown> = {}) {
        this.data = structuredClone(defaults);
    }
    get all(): Record<string, unknown> {
        return this.data;
    }
    set all(value: Record<string, unknown>) {
        this.data = value;
    }
    get(key: string): unknown {
        return this.data[key];
    }
    set(key: string, value: unknown): void {
        this.data[key] = value;
    }
    delete(key: string): void {
        delete this.data[key];
    }
    refresh(): void {}
}

mock.module("../src/auth/storage", () => ({
    CachedStore: MemStore,
    migrateLegacyConfig: () => {},
    authStore: new MemStore("auth", { providers: {}, active: null }),
    settingsStore: new MemStore("settings", {}),
    datasourcesStore: new MemStore("datasources", { connections: {} }),
}));

import { loginApiKey, logout } from "../src/auth";
import { isKimiSubscriptionKey, kimiBaseURL } from "../src/providers";
import { KIMI_CODE_MODELS } from "../src/catalog/fallbacks";

afterEach(() => {
    logout("kimi");
    delete process.env.KIMI_API_KEY;
    delete process.env.LOOP_KIMI_BASE_URL;
});

describe("kimi key-kind routing", () => {
    test("platform sk-… key → pay-per-token moonshot endpoint", () => {
        loginApiKey("kimi", "sk-0123456789abcdef");
        expect(isKimiSubscriptionKey()).toBe(false);
        expect(kimiBaseURL()).toBe("https://api.moonshot.ai/v1");
    });

    test("subscription sk-kimi-… key → Kimi Code endpoint", () => {
        loginApiKey("kimi", "sk-kimi-0123456789abcdef");
        expect(isKimiSubscriptionKey()).toBe(true);
        expect(kimiBaseURL()).toBe("https://api.kimi.com/coding/v1");
    });

    test("re-pasting the other key kind re-routes with no other change", () => {
        loginApiKey("kimi", "sk-kimi-sub");
        expect(kimiBaseURL()).toBe("https://api.kimi.com/coding/v1");
        loginApiKey("kimi", "sk-platform");
        expect(kimiBaseURL()).toBe("https://api.moonshot.ai/v1");
    });

    test("LOOP_KIMI_BASE_URL overrides both key kinds", () => {
        loginApiKey("kimi", "sk-kimi-sub");
        process.env.LOOP_KIMI_BASE_URL = "http://127.0.0.1:9999/v1";
        expect(kimiBaseURL()).toBe("http://127.0.0.1:9999/v1");
    });

    test("KIMI_API_KEY env fallback drives detection when nothing is stored", () => {
        process.env.KIMI_API_KEY = "sk-kimi-from-env";
        expect(isKimiSubscriptionKey()).toBe(true);
        delete process.env.KIMI_API_KEY;
        expect(isKimiSubscriptionKey()).toBe(false);
    });

    test("subscription catalog seed carries the plan's model ids at cost 0", () => {
        expect(KIMI_CODE_MODELS.map((m) => m.id)).toEqual([
            "kimi/k3",
            "kimi/kimi-for-coding",
            "kimi/kimi-for-coding-highspeed",
        ]);
        for (const m of KIMI_CODE_MODELS) {
            expect(m.cost.input).toBe(0);
            expect(m.cost.output).toBe(0);
            expect(m.reasoning).toBe(true);
        }
    });
});
