import { brandEnv, envName, REPO_SLUG, PRODUCT_NAME } from "@notshekhar/loop-core";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
    getActiveProvider,
    getCatalog,
    listAuthorizedProviders,
    loginApiKey,
    loginXaiOAuth,
    logout,
    SessionManager,
    startSocketServer,
    startStdioServer,
    stopSocketServer,
} from "@notshekhar/loop-core";
import type { ProviderId } from "@notshekhar/loop-core";
import { readStdinAll, readStdinLine, type Args } from "./args";
import { runPrint } from "./print";
import { openBrowser } from "./open-browser";

const UPGRADE_URL = `https://raw.githubusercontent.com/${REPO_SLUG}/main/install.sh`;
const UPGRADE_URL_PS1 = `https://raw.githubusercontent.com/${REPO_SLUG}/main/install.ps1`;
const RELEASES_API = `https://api.github.com/repos/${REPO_SLUG}/releases/latest`;

type InstallMethod = "binary" | "source";

// Identify how the running `loop` was installed so `loop upgrade` uses the
// matching upgrade path. The installer writes `.install-method` next to
// the binary; default to "binary" otherwise.
function detectInstallMethod(): InstallMethod {
    const execDir = dirname(process.execPath);
    const markerFile = join(execDir, ".install-method");
    if (existsSync(markerFile)) {
        const v = readFileSync(markerFile, "utf8").trim();
        if (v === "binary" || v === "source") return v;
    }
    return "binary";
}

function semverGt(a: string, b: string): boolean {
    const norm = (v: string) =>
        v
            .replace(/^v/, "")
            .split(".")
            .map((n) => Number.parseInt(n, 10) || 0);
    const [a1, a2, a3] = norm(a);
    const [b1, b2, b3] = norm(b);
    if (a1 !== b1) return a1 > b1;
    if (a2 !== b2) return a2 > b2;
    return a3 > b3;
}

async function fetchLatestTag(): Promise<string | null> {
    // The releases/latest redirect isn't subject to the anonymous GitHub API
    // rate limit (60 req/h/IP) that bites CI and shared networks.
    try {
        const r = await fetch(`https://github.com/${REPO_SLUG}/releases/latest`, {
            method: "HEAD",
            redirect: "follow",
        });
        const tag = r.url.split("/").pop() ?? "";
        if (/^v\d/.test(tag)) return tag;
    } catch {}
    try {
        const r = await fetch(RELEASES_API, { headers: { accept: "application/vnd.github+json" } });
        if (!r.ok) return null;
        const j = (await r.json()) as { tag_name?: string };
        return j.tag_name ?? null;
    } catch {
        return null;
    }
}

/** Newer release tag (e.g. "v0.0.3") if one exists, else null. */
export async function resolveAvailableUpdate(version: string): Promise<string | null> {
    const latest = await fetchLatestTag();
    if (latest && semverGt(latest, `v${version}`)) return latest;
    return null;
}

// Silent startup check — like resolveAvailableUpdate, but network/parse
// failures resolve to null so startup is never blocked or noisy.
// Set LOOP_SKIP_VERSION_CHECK to disable.
export async function checkForUpdate(version: string): Promise<string | null> {
    if (brandEnv("SKIP_VERSION_CHECK")) return null;
    return resolveAvailableUpdate(version);
}

export function printHelp(version: string): void {
    console.log(`${PRODUCT_NAME}/agent — terminal coding agent (v${version})

Usage:
  ${PRODUCT_NAME}                     Start interactive TUI
  ${PRODUCT_NAME} run <prompt|->      Run a single prompt and exit (- reads the prompt from stdin)
  ${PRODUCT_NAME} login [provider]    Configure provider auth
  ${PRODUCT_NAME} logout [provider]   Remove auth
  ${PRODUCT_NAME} sessions            List sessions in current cwd
  ${PRODUCT_NAME} goals <cmd>         Manage goals (list, add, rm, run, tick, daemon…)
  ${PRODUCT_NAME} models              List available models
  ${PRODUCT_NAME} whoami              Show active provider + auth status
  ${PRODUCT_NAME} cost audit          Verify the cost ledger reconciles (self-audit)
  ${PRODUCT_NAME} rpc [--socket|stop] Start JSON-RPC server (stop: end the socket daemon)
  ${PRODUCT_NAME} mcp <cmd>           Manage MCP servers (add, list, remove, login…)
  ${PRODUCT_NAME} upgrade             Pull latest and rebuild
  ${PRODUCT_NAME} version | -v        Print version

Flags:
  --model <provider/id>    Override default model
  --provider <id>          Override active provider
  --cwd <path>             Working directory
  --session <id>           Resume session by id
  --max-steps <n>          Cap agent steps in run mode (default: maxSteps setting)`);
}

export async function runUpgrade(version: string, opts: { force?: boolean } = {}): Promise<void> {
    console.log(`▶ Checking for updates (current v${version})…`);
    const latest = await fetchLatestTag();
    if (!opts.force && latest) {
        if (!semverGt(latest, `v${version}`)) {
            console.log(`Up to date (latest ${latest})`);
            return;
        }
        console.log(`▶ Upgrading ${version} → ${latest}`);
    } else if (!latest) {
        console.log("▶ Could not query latest release; running installer anyway.");
    }

    const method = detectInstallMethod();
    console.log(`▶ Install method: ${method}`);

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (opts.force) env[envName("FORCE")] = "1";
    if (method === "source") env[envName("FROM_SOURCE")] = "1";

    // Windows: invoke PowerShell installer. Mac/Linux: bash.
    const isWin = process.platform === "win32";
    let shell: string;
    let args: string[];
    if (isWin) {
        shell = "powershell";
        args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm ${UPGRADE_URL_PS1} | iex`];
    } else {
        shell = "bash";
        args = ["-c", `curl -fsSL ${UPGRADE_URL} | bash`];
    }

    const r = spawnSync(shell, args, { stdio: "inherit", env });
    process.exit(r.status ?? 1);
}

export async function cmdLogin(provider?: string): Promise<void> {
    const p = (provider ?? "xai") as ProviderId;
    if (p === "xai") {
        const mode = await readStdinLine("xAI: [1] OAuth subscription  [2] API key  > ");
        if (mode === "2") {
            const key = await readStdinLine("XAI_API_KEY: ");
            loginApiKey("xai", key);
            console.log("xAI API key saved.");
        } else {
            await loginXaiOAuth(({ url, instructions }) => {
                console.log(instructions);
                console.log(url);
                const opened = openBrowser(url);
                console.log(opened ? "(opened in browser)" : "(open this URL in a browser)");
            });
            console.log("xAI OAuth login complete.");
        }
        return;
    }
    const key = await readStdinLine(`${p.toUpperCase()}_API_KEY: `);
    loginApiKey(p, key);
    console.log(`${p} API key saved.`);
}

export function cmdLogout(target?: ProviderId): void {
    logout(target);
    console.log(target ? `Logged out of ${target}.` : "Logged out of all providers.");
}

export async function cmdSessions(): Promise<void> {
    const mgr = new SessionManager();
    const sessions = mgr.list(process.cwd());
    if (sessions.length === 0) {
        console.log("No sessions in this cwd.");
        return;
    }
    for (const s of sessions) {
        // Named sessions (goal runs are always "goal: <text>") show the name —
        // it identifies the session far better than the first prompt line.
        const preview = s.name ?? s.firstUserMessage?.split("\n")[0] ?? "";
        console.log(`${s.id}  ${s.model}  ${new Date(s.mtime).toISOString()}  ${preview}`);
    }
}

export function cmdRpc(args: Args): void {
    const sub = args.positional[0];
    if (sub === "stop") {
        const r = stopSocketServer();
        console.log(r.stopped ? `Stopped ${PRODUCT_NAME} RPC daemon (pid ${r.pid}).` : "No RPC daemon running.");
        return;
    }
    if (args.flags.socket) {
        try {
            const { socketPath } = startSocketServer();
            console.log(`${PRODUCT_NAME} RPC daemon listening on ${socketPath}`);
        } catch (err) {
            console.error((err as Error).message);
            process.exitCode = 1;
        }
        return;
    }
    startStdioServer();
}

export async function cmdRun(args: Args): Promise<void> {
    let prompt = args.positional.join(" ");
    // `loop run -` (or piped stdin with no prompt argument) reads the prompt
    // from stdin — CI callers pipe long prompts instead of shell-quoting them.
    if (prompt === "-" || (!prompt && !process.stdin.isTTY)) {
        prompt = (await readStdinAll()).trim();
    }
    if (!prompt) {
        console.error(`Usage: ${PRODUCT_NAME} run "<prompt>"   (or: echo "<prompt>" | ${PRODUCT_NAME} run -)`);
        process.exitCode = 1;
        return;
    }
    const maxSteps = Number(args.flags["max-steps"]) || undefined;
    await runPrint({
        prompt,
        modelId: (args.flags.model as string) || undefined,
        cwd: (args.flags.cwd as string) || process.cwd(),
        maxSteps,
    });
}

export async function cmdModels(): Promise<void> {
    const cat = await getCatalog();
    for (const m of Object.values(cat)) {
        console.log(`${m.id}\tctx:${m.contextWindow}\t$${m.cost.input}/$${m.cost.output}`);
    }
}

export function cmdWhoami(): void {
    console.log(`Active provider: ${getActiveProvider() ?? "none"}`);
    console.log(`Authorized: ${listAuthorizedProviders().join(", ") || "none"}`);
}

/** `loop cost audit` — reconcile the cost ledger against itself and the transcripts. */
export async function cmdCostAudit(): Promise<void> {
    const { auditLedger, closeDb } = await import("@notshekhar/loop-core");
    const audit = auditLedger();
    console.log(`Ledger rows: ${audit.rows}`);
    if (audit.priceViolations.length === 0) {
        console.log("Every priced row recomputes to its recorded usd (qty × snapshot price).");
    } else {
        console.log(`${audit.priceViolations.length} row(s) fail the price reconciliation:`);
        for (const v of audit.priceViolations.slice(0, 20)) {
            console.log(
                `  row ${v.id} (${v.model}): recorded $${v.usd.toFixed(6)}, recomputed $${v.computed.toFixed(6)}`,
            );
        }
    }
    if (audit.sessionMismatches.length === 0) {
        console.log("Ledger token sums match the transcripts for every session.");
    } else {
        console.log(`${audit.sessionMismatches.length} session(s) disagree with their transcripts:`);
        for (const m of audit.sessionMismatches.slice(0, 20)) {
            console.log(
                `  ${m.sessionPub}: ledger in/out ${m.ledgerInput}/${m.ledgerOutput}, entries ${m.entriesInput}/${m.entriesOutput}`,
            );
        }
    }
    closeDb();
    if (audit.priceViolations.length > 0 || audit.sessionMismatches.length > 0) process.exitCode = 1;
}
