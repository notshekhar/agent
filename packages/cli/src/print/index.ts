import { EventEmitter } from "node:events";
import {
    asTurnEmitter,
    closeDb,
    CostTracker,
    SessionManager,
    runTurn,
    runHooks,
    getActiveProvider,
    getMcpManager,
    getExtensionHost,
    getProjectModel,
    isMcpEnabled,
    isTrusted,
    parseModelId,
    resolveSavedAgent,
    settingsStore,
    PRODUCT_NAME,
} from "@notshekhar/loop-core";
import type { ProviderId, Session } from "@notshekhar/loop-core";
import { openBrowser } from "../open-browser";

export interface PrintOptions {
    prompt: string;
    modelId?: string;
    /** Explicit --cwd; unset falls back to the resumed session's cwd, then process.cwd(). */
    cwd?: string;
    /** `--session <id>` — resume this session instead of creating one. Unknown id fails loudly. */
    sessionId?: string;
    /** Step cap for the turn (`--max-steps`); unset = maxSteps setting / unlimited. */
    maxSteps?: number;
}

export async function runPrint(opts: PrintOptions): Promise<void> {
    const manager = new SessionManager();
    // Resume before model resolution: a resumed session carries its own model
    // and cwd as defaults. open() throws on an unknown id — never fall back to
    // a fresh session, silent forking is worse than an error (#4).
    let resumed: Session | null = null;
    if (opts.sessionId) {
        try {
            resumed = await manager.open(opts.sessionId);
        } catch {
            process.stderr.write(`Session not found: ${opts.sessionId} (see \`${PRODUCT_NAME} sessions\`)\n`);
            process.exit(1);
        }
    }
    const cwd = opts.cwd ?? resumed?.info.cwd ?? process.cwd();
    // No silent provider fallback — require an explicitly selected model.
    const modelId =
        opts.modelId ??
        resumed?.info.model ??
        getProjectModel(cwd) ??
        (settingsStore.get("defaultModel") as string | undefined);
    if (!modelId) {
        process.stderr.write(
            `No model selected. Pass --model <provider/model>, or run ${PRODUCT_NAME} interactively and use /login + /provider first.\n`,
        );
        process.exit(1);
    }
    const provider = (getActiveProvider() ?? parseModelId(modelId).provider) as ProviderId;
    const session = resumed ?? (await manager.create({ cwd, provider, model: modelId }));
    const tracker = new CostTracker();
    const emitter = asTurnEmitter(new EventEmitter());
    const abort = new AbortController();

    emitter.on("text-delta", (text: string) => process.stdout.write(text));
    emitter.on("tool-call", (part: { toolName?: string; input?: unknown }) => {
        process.stderr.write(`\n[tool:${part.toolName}] ${JSON.stringify(part.input)}\n`);
    });
    emitter.on("tool-input-updated", (e: { toolName?: string; input?: unknown }) => {
        process.stderr.write(`[tool:${e.toolName} rewritten] ${JSON.stringify(e.input)}\n`);
    });
    emitter.on("subagent-tool", (e: { agent: string; toolName?: string; input?: unknown }) => {
        process.stderr.write(`[subagent:${e.agent}] ${e.toolName} ${JSON.stringify(e.input)}\n`);
    });
    emitter.on("subagent-finish", (e: { agent: string; usage?: { totalTokens?: number } }) => {
        process.stderr.write(
            `[subagent:${e.agent}] done${e.usage?.totalTokens ? ` (${e.usage.totalTokens} tokens)` : ""}\n`,
        );
    });
    emitter.on("hook-message", (m: string) => {
        process.stderr.write(`\n[hook] ${m}\n`);
    });
    emitter.on("hook-terminal-sequence", (s: string) => {
        process.stdout.write(s);
    });
    // Turn-level stream errors are emitted, not thrown (the turn winds down
    // normally after one) — track them so CI gets a nonzero exit instead of a
    // clean 0 with an [error] line buried in stderr.
    let turnErrored = false;
    emitter.on("error", (err: unknown) => {
        turnErrored = true;
        process.stderr.write(`\n[error] ${String(err)}\n`);
    });
    emitter.on("finish", () => process.stdout.write("\n"));

    process.on("SIGINT", () => abort.abort());

    // SessionStart hooks run in print mode too (Claude Code -p parity);
    // additionalContext is prepended to the one-shot prompt.
    const startHooks = await runHooks(
        "SessionStart",
        "startup",
        { session_id: session.id, transcript_path: session.path, source: "startup" },
        cwd,
    );
    for (const m of startHooks.messages) process.stderr.write(`\n[hook] ${m}\n`);
    for (const s of startHooks.terminalSequences) process.stdout.write(s);
    const userInput = startHooks.additionalContext ? `${startHooks.additionalContext}\n\n${opts.prompt}` : opts.prompt;

    // Connect MCP servers before the turn (same gate as the agent loop) so
    // their tools are available headlessly. Closed after the turn finishes.
    const mcpEnabled = isMcpEnabled() && isTrusted(cwd);
    if (mcpEnabled) await getMcpManager().init(cwd);

    // Load extensions so their tools/middleware apply headlessly too. No-op
    // when none are installed. Inject a browser opener but no `ui`: any
    // api.ui call throws in print mode (interactive panels need a real session).
    getExtensionHost().setServices({ openExternal: (url) => openBrowser(url) });
    await getExtensionHost().init();

    await runTurn({
        session,
        modelId,
        userInput,
        cwd,
        abortSignal: abort.signal,
        tracker,
        emitter,
        // Plan is a per-session TUI mode — a one-shot run never starts in it.
        agent: resolveSavedAgent(settingsStore.get("agent") as string | undefined),
        // One-shot mode prints nothing after the response — skip the recap pass.
        recap: false,
        maxSteps: opts.maxSteps,
    });

    if (mcpEnabled) await getMcpManager().close();
    await getExtensionHost().close();

    // SessionEnd hooks: give them a moment, then finish regardless.
    await Promise.race([
        runHooks(
            "SessionEnd",
            undefined,
            { session_id: session.id, transcript_path: session.path, reason: "exit" },
            cwd,
        ),
        new Promise((r) => setTimeout(r, 3_000)),
    ]);

    process.stderr.write(`\n${tracker.format()}\n`);
    // Checkpoint + close the session DB so the -wal file doesn't linger.
    closeDb();
    // exitCode (not process.exit) so the streams flush before the process ends.
    if (turnErrored) process.exitCode = 1;
}
