/**
 * Wayfinder — Matt Pocock's `/wayfinder` skill
 * (github.com/mattpocock/skills, skills/engineering/wayfinder) as a loop
 * extension. It charts an effort too big for one session as a map of decision
 * tickets on the repo's issue tracker, then burns them down one per session.
 *
 * Unlike ponytail/caveman this is *not* a persona: upstream ships it with
 * `disable-model-invocation: true`, so it's user-invoked only. The native seam
 * is therefore a slash command that submits the skill body as a turn (the
 * `inject-skill` emit the built-in `/skill:<name>` command uses), not
 * `onSystemPrompt`. The one piece of persisted state is which issue tracker the
 * map lives on.
 */
import type { ExtensionAPI } from "../../api";
import {
    buildInvocation,
    DEFAULT_TRACKER,
    normalizeTracker,
    resolveTracker,
    TRACKERS,
    type Tracker,
} from "./instructions";

export default {
    activate(api: ExtensionAPI) {
        const getTracker = (): Tracker =>
            normalizeTracker(api.settings.getOwn("tracker", DEFAULT_TRACKER)) ?? DEFAULT_TRACKER;
        // Show the tracker in the banner / `/extensions` panel — where the map
        // gets written is the one thing worth knowing before invoking.
        api.extension.setStatus(() => getTracker());

        // /wayfinder <loose idea | map url> — chart a map, or work through one.
        // `/wayfinder tracker [auto|github|markdown]` configures where maps live.
        api.commands.register({
            name: "wayfinder",
            description: "Chart a big, foggy effort as a map of decision tickets: /wayfinder <idea|map url>",
            handler: (ctx, args) => {
                const trimmed = args.trim();
                const setting = trimmed.match(/^tracker(?:\s+(\S+))?$/i);
                if (setting) {
                    const arg = setting[1];
                    if (!arg) {
                        ctx.emit(
                            "help",
                            `wayfinder tracker: ${getTracker()} (resolves to ${resolveTracker(getTracker(), ctx.cwd)}; options: ${TRACKERS.join(" | ")})`,
                        );
                        return;
                    }
                    const tracker = normalizeTracker(arg);
                    if (!tracker) {
                        ctx.emit("error", `unknown wayfinder tracker "${arg}". options: ${TRACKERS.join(" | ")}`);
                        return;
                    }
                    api.settings.setOwn("tracker", tracker);
                    ctx.emit("help", `wayfinder tracker: ${tracker} (resolves to ${resolveTracker(tracker, ctx.cwd)})`);
                    return;
                }
                ctx.emit("inject-skill", buildInvocation(resolveTracker(getTracker(), ctx.cwd), trimmed));
            },
        });
    },
};
