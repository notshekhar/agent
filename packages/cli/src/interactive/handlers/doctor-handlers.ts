/**
 * /doctor — read-only installation diagnostics: version, runtime, config,
 * session DB integrity, provider auth, catalog, MCP, extensions, trust, and
 * optional external binaries. Every check prints one pass/warn/fail line;
 * nothing here mutates state.
 */
import { existsSync } from "node:fs";
import chalk from "chalk";
import {
    getCatalog,
    getConfigDir,
    getDb,
    getExtensionHost,
    getMcpManager,
    getSetting,
    isMcpEnabled,
    isTrusted,
    listAuthorizedProviders,
    listCustomProviders,
    getAuthMode,
    type CommandContext,
} from "@notshekhar/loop-core";
import type { AppDeps } from "../deps";
import type { AppState } from "../state";
import { resolveAvailableUpdate } from "../../commands";
import { dim, err, ok, warn } from "../ui/text";

type DoctorHandlers = Pick<CommandContext, "runDoctor">;

type Status = "ok" | "warn" | "fail";

const MARK: Record<Status, string> = {
    ok: ok("ok  "),
    warn: warn("warn"),
    fail: err("fail"),
};

export function createDoctorHandlers(state: AppState, deps: AppDeps): DoctorHandlers {
    const { tui, history, showWorking, hideWorking } = deps;

    return {
        async runDoctor() {
            showWorking("Running diagnostics");
            const rows: Array<{ status: Status; name: string; detail: string }> = [];
            const add = (status: Status, name: string, detail: string) => rows.push({ status, name, detail });

            // Version + available update.
            const version = deps.version ?? "0.0.0";
            try {
                const latest = await resolveAvailableUpdate(version);
                if (latest) add("warn", "version", `v${version} — ${latest} available (/update)`);
                else add("ok", "version", `v${version} (latest)`);
            } catch {
                add("warn", "version", `v${version} — update check unreachable`);
            }
            add("ok", "runtime", `bun ${process.versions.bun ?? "?"} on ${process.platform}`);

            // Config dir + settings readability.
            const configDir = getConfigDir();
            if (!existsSync(configDir)) add("fail", "config dir", `${configDir} missing`);
            else add("ok", "config dir", configDir);
            try {
                getSetting("theme");
                add("ok", "settings", "settings.json readable");
            } catch (err) {
                add("fail", "settings", `settings.json unreadable: ${(err as Error).message}`);
            }

            // Session DB integrity.
            try {
                const db = getDb();
                const res = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
                const verdict = res?.integrity_check ?? "unknown";
                const count = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions").get()?.n ?? 0;
                if (verdict === "ok") add("ok", "session db", `integrity ok, ${count} sessions`);
                else add("fail", "session db", `integrity: ${verdict}`);
            } catch (err) {
                add("fail", "session db", (err as Error).message);
            }

            // Provider auth.
            try {
                const providers = listAuthorizedProviders();
                const custom = listCustomProviders().map((c) => c.name);
                const parts = providers.map((p) => `${p} (${getAuthMode(p)})`);
                if (custom.length) parts.push(...custom.map((n) => `${n} (custom)`));
                if (parts.length === 0) add("warn", "providers", "none authorized — run /login");
                else add("ok", "providers", parts.join(", "));
            } catch (err) {
                add("fail", "providers", (err as Error).message);
            }

            // Model catalog.
            try {
                const catalog = await getCatalog();
                const n = Object.keys(catalog).length;
                if (n === 0) add("warn", "catalog", "empty model catalog");
                else add("ok", "catalog", `${n} models, current: ${state.modelId}`);
            } catch (err) {
                add("fail", "catalog", (err as Error).message);
            }

            // MCP servers.
            if (!isMcpEnabled()) {
                add("ok", "mcp", "disabled in settings");
            } else {
                const servers = getMcpManager().listServers();
                if (servers.length === 0) add("ok", "mcp", "no servers configured");
                else {
                    const bad = servers.filter((s) => s.status === "error" || s.status === "needs-auth");
                    const summary = servers.map((s) => `${s.name}:${s.status}`).join(", ");
                    add(bad.length ? "warn" : "ok", "mcp", summary);
                }
            }

            // Extensions.
            try {
                const exts = getExtensionHost().listAll();
                const enabled = exts.filter((e) => e.enabled);
                add("ok", "extensions", `${enabled.length}/${exts.length} enabled`);
            } catch (err) {
                add("warn", "extensions", (err as Error).message);
            }

            // Project trust for the current cwd.
            add(
                isTrusted(state.cwd) ? "ok" : "warn",
                "trust",
                isTrusted(state.cwd)
                    ? `${state.cwd} is trusted (skills/MCP/extensions active)`
                    : `${state.cwd} untrusted — skills/MCP/extension tools inactive`,
            );

            // Optional external binaries.
            const opt: string[] = [];
            for (const bin of ["gh", "git", "rg"]) opt.push(`${bin}${Bun.which(bin) ? "" : dim(" (missing)")}`);
            add(Bun.which("git") ? "ok" : "warn", "binaries", opt.join(", "));

            hideWorking();
            history.addSystem(chalk.bold("doctor"));
            const w = Math.max(...rows.map((r) => r.name.length));
            for (const r of rows) {
                history.addSystem(`  ${MARK[r.status]} ${r.name.padEnd(w + 2)}${dim(r.detail)}`);
            }
            const fails = rows.filter((r) => r.status === "fail").length;
            const warns = rows.filter((r) => r.status === "warn").length;
            history.addSystem("");
            history.addSystem(
                fails
                    ? err(`${fails} failure(s), ${warns} warning(s)`)
                    : warns
                      ? warn(`healthy with ${warns} warning(s)`)
                      : ok("all checks passed"),
            );
            tui.requestRender();
        },
    };
}
