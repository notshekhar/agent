/**
 * Headless goal execution — the runPrint recipe with the stream swapped for
 * an accumulator. Each run is a normal persisted session (named
 * "goal: <text>") so the TUI can list and resume it; the outcome lands on the
 * goal row (last_run_*) and in a desktop notification.
 *
 * DB lifecycle belongs to the caller (the tick loop) — no closeDb() here.
 */
import { EventEmitter } from "node:events";
import {
    asTurnEmitter,
    CostTracker,
    SessionManager,
    runTurn,
    runHooks,
    getActiveProvider,
    getExtensionHost,
    getMcpManager,
    getProjectModel,
    isMcpEnabled,
    isTrusted,
    parseModelId,
    PRODUCT_NAME,
    recordGoalRunEnd,
    recordGoalRunStart,
    resolveSavedAgent,
    settingsStore,
    type Goal,
    type ProviderId,
} from "@notshekhar/loop-core";
import { notify } from "../notify";

/** Bound unattended spend: a goal run gets fewer agent steps than an interactive turn. */
const GOAL_MAX_STEPS = 50;

const SUMMARY_MAX = 300;

const GOAL_PREAMBLE =
    "You are running unattended on a schedule. Work toward the goal below, then end with a short summary of what you did and whether anything needs the user's attention.";

export interface GoalRunResult {
    status: "ok" | "error";
    sessionId: string;
    summary: string;
}

export async function runGoal(goal: Goal): Promise<GoalRunResult> {
    const modelId =
        goal.model ?? getProjectModel(goal.cwd) ?? (settingsStore.get("defaultModel") as string | undefined);
    if (!modelId) {
        recordGoalRunEnd(goal.id, "error", "no model configured for headless runs");
        notify(`${PRODUCT_NAME} goal failed`, `${goal.text} — no model configured`);
        return { status: "error", sessionId: "", summary: "no model configured" };
    }
    // A goal with its own model pins the provider too (model ids are
    // provider/model); only unpinned goals follow the globally active provider.
    const provider = (
        goal.model ? parseModelId(goal.model).provider : (getActiveProvider() ?? parseModelId(modelId).provider)
    ) as ProviderId;
    const manager = new SessionManager();
    const session = await manager.create({ cwd: goal.cwd, provider, model: modelId });
    await session.setName(`goal: ${goal.text}`);
    recordGoalRunStart(goal.id, session.id);

    const tracker = new CostTracker();
    const emitter = asTurnEmitter(new EventEmitter());
    const abort = new AbortController();
    let output = "";
    emitter.on("text-delta", (text: string) => {
        output += text;
    });
    emitter.on("error", (err: unknown) => {
        output += `\n[error] ${String(err)}`;
    });

    const startHooks = await runHooks(
        "SessionStart",
        "startup",
        { session_id: session.id, transcript_path: session.path, source: "startup" },
        goal.cwd,
    );
    const prompt = `${GOAL_PREAMBLE}\n\nGoal: ${goal.text}`;
    const userInput = startHooks.additionalContext ? `${startHooks.additionalContext}\n\n${prompt}` : prompt;

    const mcpEnabled = isMcpEnabled() && isTrusted(goal.cwd);
    if (mcpEnabled) await getMcpManager().init(goal.cwd);
    // No browser in an unattended tick: an extension asking for one gets an
    // error (run fails with "needs attention"), never a hang.
    getExtensionHost().setServices({
        openExternal: () => {
            throw new Error("goal runs are unattended — cannot open a browser");
        },
    });
    await getExtensionHost().init();

    let status: "ok" | "error" = "ok";
    try {
        await runTurn({
            session,
            modelId,
            userInput,
            cwd: goal.cwd,
            abortSignal: abort.signal,
            tracker,
            emitter,
            maxSteps: GOAL_MAX_STEPS,
            agent: goal.agent ?? resolveSavedAgent(settingsStore.get("agent") as string | undefined),
            recap: false,
        });
    } catch (err) {
        status = "error";
        output += `\n[error] ${String((err as Error)?.message ?? err)}`;
    }

    if (mcpEnabled) await getMcpManager().close();
    await getExtensionHost().close();
    await Promise.race([
        runHooks(
            "SessionEnd",
            undefined,
            { session_id: session.id, transcript_path: session.path, reason: "exit" },
            goal.cwd,
        ),
        new Promise((r) => setTimeout(r, 3_000)),
    ]);

    const summary = output.trim().slice(-SUMMARY_MAX) || (status === "ok" ? "(no output)" : "(failed with no output)");
    recordGoalRunEnd(goal.id, status, summary);
    notify(
        status === "ok" ? `${PRODUCT_NAME} goal done` : `${PRODUCT_NAME} goal needs attention`,
        `${goal.text}\n${summary.slice(0, 120)}`,
    );
    return { status, sessionId: session.id, summary };
}
