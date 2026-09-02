/**
 * /trace — the session's timing-and-cost trace, as one HTML file, opened in
 * the browser.
 *
 * A trace is a page (bars, hover, expand) and the terminal is the wrong
 * surface for one, so it goes the same way /artifacts goes: write a
 * self-contained file, hand its file:// URL to the OS. The path is printed
 * either way — over SSH nothing opens, and the file is what you'd copy back.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderTraceHtml, sessionToTrace, traceHeadline, type CommandContext } from "@notshekhar/loop-core";
import type { AppDeps } from "../deps";
import type { AppState } from "../state";
import { openBrowser } from "../../open-browser";
import { dim } from "../ui/text";

type TraceHandlers = Pick<CommandContext, "openTrace">;

/** Filesystem-safe stamp for the default file name: 2026-09-02T02-19-40. */
function stamp(d = new Date()): string {
    return d.toISOString().slice(0, 19).replace(/:/g, "-");
}

export function createTraceHandlers(state: AppState, deps: AppDeps): TraceHandlers {
    const { tui, history } = deps;
    return {
        openTrace(target) {
            const session = state.session;
            if (!session) {
                history.addSystem("nothing to trace yet — send a message first");
                tui.requestRender();
                return;
            }
            const model = sessionToTrace(session);
            const html = renderTraceHtml(model);
            // An explicit path is written and NOT opened: that's an export.
            // Otherwise a fresh file under the temp dir, opened in the browser.
            const path = target
                ? resolve(state.cwd, target)
                : join(tmpdir(), "loop-trace", `${session.id}-${stamp()}.html`);
            try {
                mkdirSync(dirname(path), { recursive: true });
                writeFileSync(path, html);
            } catch (err) {
                history.addError(`could not write the trace: ${(err as Error).message}`);
                tui.requestRender();
                return;
            }
            history.addSystem(traceHeadline(model));
            if (target) {
                history.addSystem(`trace written to ${path}`);
            } else {
                const url = pathToFileURL(path).href;
                const opened = openBrowser(url);
                history.addSystem(opened ? `opening the trace — ${url}` : `open it yourself: ${url}`);
            }
            if (model.coverage.derived + model.coverage.none > 0 && model.coverage.recorded === 0) {
                history.addSystem(
                    dim("steps recorded before this version have wall time only; new turns get model/tool bars"),
                );
            }
            tui.requestRender();
        },
    };
}
