/**
 * `!<cmd>` — run a shell command from the prompt, without asking the model.
 *
 * The escape hatch for everything faster done yourself than described: an
 * interactive login, a `git status`, a one-off script. You type it, it runs
 * here, and its output lands in the conversation so the next thing you say to
 * the model is said against what you both just saw.
 *
 * Deliberately NOT the bash tool. That tool exists to gate what the MODEL may
 * run — permission rules, the deny list, the plan-mode gate, sandboxing — and
 * every one of those is asking "did the user authorise this?". Here the user
 * IS the author, typing at their own prompt in their own terminal, so there is
 * nothing left to authorise; routing it through the gate would only mean
 * prompting someone for permission to do the thing they just asked to do.
 */
import { spawn } from "node:child_process";
import { getShellConfig, getShellEnv } from "@notshekhar/loop-core";

/**
 * What a `!` line produced. `output` is merged stdout+stderr, in the order the
 * command wrote it — a build's errors are interleaved with its progress, and
 * splitting the streams would reorder the one thing you ran it to read.
 */
export interface BangResult {
    output: string;
    /** Exit status, or null when a signal killed it (abort included). */
    exitCode: number | null;
    /** The process could not be started at all (no shell, bad cwd). */
    spawnError?: string;
    /** Output was cut at the cap; `output` holds the head. */
    truncated: boolean;
}

/**
 * Cap on what a single `!` line may print.
 *
 * The HEAD is kept, not the tail — the opposite of the bash tool, and on
 * purpose. The tool's output is read by a model looking for a command's
 * verdict, which is at the end; this output is read by a person who typed the
 * command a second ago and knows what it does. A `find /` they meant to narrow
 * is answered by its first lines, and waiting for the last thousand helps
 * nobody.
 */
const MAX_OUTPUT_BYTES = 100_000;

/** A `!` line that is only whitespace after the bang has no command in it. */
export function parseBangCommand(text: string): string | null {
    if (!text.startsWith("!")) return null;
    const cmd = text.slice(1).trim();
    return cmd.length > 0 ? cmd : null;
}

/**
 * Run `command` through the user's shell in `cwd`.
 *
 * Never rejects: a command that fails, is killed, or cannot be spawned at all
 * is a RESULT here, not an exception. The caller renders every one of those the
 * same way — as output plus a status — and a throw would only mean writing that
 * rendering twice.
 */
export function runBangCommand(
    command: string,
    cwd: string,
    opts: { shellPath?: string; signal?: AbortSignal; onData?: (chunk: string) => void } = {},
): Promise<BangResult> {
    return new Promise((resolve) => {
        let shell: string;
        let args: string[];
        try {
            ({ shell, args } = getShellConfig(opts.shellPath));
        } catch (err) {
            resolve({ output: "", exitCode: null, spawnError: (err as Error).message, truncated: true });
            return;
        }

        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(shell, [...args, command], {
                cwd,
                env: getShellEnv(),
                stdio: ["ignore", "pipe", "pipe"],
                // Its own process group, so aborting takes the whole tree —
                // a shell one-liner is usually a pipeline, and killing only the
                // shell leaves the pipeline's children running invisibly.
                detached: process.platform !== "win32",
            });
        } catch (err) {
            resolve({ output: "", exitCode: null, spawnError: (err as Error).message, truncated: true });
            return;
        }

        let output = "";
        let bytes = 0;
        let truncated = false;
        const take = (chunk: Buffer): void => {
            if (truncated) return;
            const text = chunk.toString("utf-8");
            const room = MAX_OUTPUT_BYTES - bytes;
            if (Buffer.byteLength(text, "utf-8") > room) {
                const kept = text.slice(0, Math.max(0, room));
                output += kept;
                truncated = true;
                opts.onData?.(kept);
                return;
            }
            bytes += Buffer.byteLength(text, "utf-8");
            output += text;
            opts.onData?.(text);
        };
        child.stdout?.on("data", take);
        child.stderr?.on("data", take);

        const onAbort = (): void => {
            if (child.pid === undefined) return;
            // Negative pid = the whole process group (see `detached` above).
            try {
                process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
            } catch {
                // Already gone — nothing to kill, and nothing to report.
            }
        };
        opts.signal?.addEventListener("abort", onAbort, { once: true });

        let settled = false;
        /** One exit for both `close` and `error` — a spawn that fails after the
         * call returned (an unreadable cwd) fires `error`, sometimes both. */
        const finish = (res: BangResult): void => {
            if (settled) return;
            settled = true;
            opts.signal?.removeEventListener("abort", onAbort);
            resolve(res);
        };
        child.on("error", (err) => finish({ output, exitCode: null, spawnError: err.message, truncated }));
        child.on("close", (code) => finish({ output, exitCode: code, truncated }));
    });
}

/**
 * The `!` line as the model should read it on the next turn.
 *
 * Framed as something the USER did, because that is what happened — the model
 * did not call a tool here and must not later recall that it did. It is told
 * the command, what came back, and (only when there is something to say) how it
 * ended, so a failure is not mistaken for output.
 */
export function formatBangContext(command: string, result: BangResult): string {
    const status = result.spawnError
        ? `could not run: ${result.spawnError}`
        : result.exitCode === null
          ? "interrupted"
          : result.exitCode !== 0
            ? `exited with code ${result.exitCode}`
            : "";
    const body = result.output.trimEnd();
    return [
        "The user ran a shell command in their terminal (not a tool call):",
        `$ ${command}`,
        body || "(no output)",
        result.truncated ? `[output truncated at ${MAX_OUTPUT_BYTES} bytes]` : "",
        status,
    ]
        .filter(Boolean)
        .join("\n");
}
