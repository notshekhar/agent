/**
 * Builds the text `/wayfinder` injects: the embedded SKILL.md body, wrapped in
 * the reference skill block (so the TUI renders it as a skill invocation), plus
 * two appendices the upstream skill assumes someone else supplies.
 *
 * Upstream expects a "Wayfinding operations" doc laid down by
 * `/setup-matt-pocock-skills`, and leans on sibling skills (`/grilling`,
 * `/domain-modeling`, `/research`, `/prototype`). Neither ships with loop, so
 * the tracker ops are supplied here — GitHub via `gh`, or local markdown — and
 * the sibling skills are mapped onto what loop actually has (ask-one-question
 * turns, the `task` subagent tool). If the real skills are installed, the
 * mapping defers to them.
 */
import { WAYFINDER_SKILL } from "./skill-text";

export type Tracker = "auto" | "github" | "markdown";
export const TRACKERS: Tracker[] = ["auto", "github", "markdown"];
export const DEFAULT_TRACKER: Tracker = "auto";

/** Where the skill block claims to come from (must contain no `"`). */
const LOCATION = "built-in wayfinder extension";

export function normalizeTracker(value: unknown): Tracker | null {
    const t = typeof value === "string" ? value.trim().toLowerCase() : "";
    return (TRACKERS as string[]).includes(t) ? (t as Tracker) : null;
}

/**
 * Resolve `auto`: GitHub when the repo has a github.com remote AND `gh` is on
 * PATH and authenticated — anything less and the markdown tracker is the honest
 * answer, since a half-working `gh` fails mid-map rather than up front.
 */
export function resolveTracker(tracker: Tracker, cwd: string): Exclude<Tracker, "auto"> {
    if (tracker !== "auto") return tracker;
    try {
        const remote = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd, stderr: "ignore" });
        if (!remote.success || !/github\.com/i.test(remote.stdout.toString())) return "markdown";
        const auth = Bun.spawnSync(["gh", "auth", "status"], { cwd, stdout: "ignore", stderr: "ignore" });
        return auth.success ? "github" : "markdown";
    } catch {
        return "markdown";
    }
}

const GITHUB_OPS = `## Wayfinding operations (GitHub, via \`gh\`)

This repo's tracker is GitHub Issues. Every operation below runs through the \`gh\` CLI.

- **Labels.** \`wayfinder:map\` on the map; \`wayfinder:ticket\` on every ticket, plus its type label (\`wayfinder:research\` | \`wayfinder:prototype\` | \`wayfinder:grilling\` | \`wayfinder:task\`). Create a label the first time it's needed: \`gh label create wayfinder:map --color 5319E7 --description "Wayfinder map"\` (ignore an "already exists" error).
- **Create the map.** \`gh issue create --title "<destination, as a name>" --label wayfinder:map --body-file <tmp>\`. Write the body from a temp file, never a shell-quoted heredoc — the body is markdown with backticks in it.
- **Create a ticket.** \`gh issue create --title "<the question, as a name>" --label wayfinder:ticket --label wayfinder:<type> --body-file <tmp>\`, then attach it to the map as a **sub-issue**: get the ticket's node id with \`gh api repos/{owner}/{repo}/issues/<n> --jq .id\` and post \`gh api repos/{owner}/{repo}/issues/<map>/sub_issues -f sub_issue_id=<id>\`. If the sub-issue API is unavailable, fall back to a \`Part of #<map>\` line in the body and a \`## Tickets\` checklist on the map.
- **Blocking.** GitHub exposes no native blocking through \`gh\`, so use the body convention: a \`Blocked by:\` line naming each blocker as a markdown link, and the \`wayfinder:blocked\` label while any blocker is open. Remove the label the moment the last blocker closes — the label is what makes the frontier visible in the tracker UI.
- **Claim.** \`gh issue edit <n> --add-assignee @me\` **before** any work on the ticket.
- **The frontier.** \`gh issue list --label wayfinder:ticket --state open --search "no:assignee -label:wayfinder:blocked"\`.
- **Read a ticket.** \`gh issue view <n> --comments\`.
- **Resolve.** \`gh issue comment <n> --body-file <tmp>\` with the answer, then \`gh issue close <n>\`, then edit the map body to append the one-line pointer under *Decisions so far*.
- **Out of scope.** \`gh issue close <n> --reason "not planned"\` and one line in the map's *Out of scope* section.`;

const MARKDOWN_OPS = `## Wayfinding operations (local markdown)

No issue tracker is wired up, so the map lives in the repo at \`.wayfinder/\`. Treat these files exactly as issues: create them before working, edit them in place, and commit them so the map is shared.

\`\`\`
.wayfinder/
  map.md                       # the map — the body format above, verbatim
  tickets/<slug>.md            # one file per ticket
\`\`\`

- **Names, not slugs.** A ticket's name is its \`# <title>\` heading; the slug is only a filename. Refer to tickets by name in everything the human reads, linking the file path.
- **Ticket file.** Frontmatter, then the \`## Question\` body:

\`\`\`markdown
---
type: research | prototype | grilling | task
status: open | closed | out-of-scope
assignee: <who claimed it, or empty>
blocked-by: [<slug>, <slug>]
---

# <the question, as a name>

## Question

<the decision or investigation this ticket resolves>
\`\`\`

- **Claim.** Set \`assignee\` **before** any work; an open ticket with an empty \`assignee\` is unclaimed.
- **The frontier.** \`status: open\`, empty \`assignee\`, and every slug in \`blocked-by\` already \`status: closed\`. Grep the frontmatter to compute it — don't rely on memory of the map.
- **Resolve.** Append a \`## Resolution\` section to the ticket file, set \`status: closed\`, then append the one-line pointer to the map's *Decisions so far*.
- **Out of scope.** \`status: out-of-scope\` plus one line in the map's *Out of scope* section. Never delete a ticket file — a closed file is the record.`;

const LOOP_MAPPING = `## Running this in loop

The sibling skills this skill names are not installed here. If a skill of that name **is** available in your context, use it and ignore the substitution below; otherwise:

- **\`/grilling\` and \`/domain-modeling\`** — run the grilling yourself, in this conversation: **one question at a time**, wait for the human's answer, never batch a questionnaire and never answer on their behalf. That constraint *is* the skill; a HITL ticket resolved without a real exchange is not resolved.
- **\`/research\` subagent** — use the \`task\` tool, one call per research ticket, fired in parallel in a single message. Give each subagent the ticket's question, the destination, and where to write its findings; it reports back a summary you post as the resolution comment.
- **\`/prototype\`** — build the cheapest concrete artifact that raises the fidelity of the discussion (an outline, a stub, a rough screen), save it in the repo, and link it from the ticket. Don't polish it — it exists to be reacted to.
- **\`/to-spec\` handoff** — when the map is clear, say so and stop. Write the spec only if the human asks for it in that same breath.

Everything else in this skill applies as written: name the destination first, one ticket per session (research excepted), refer to tickets by name, and produce decisions rather than deliverables.`;

/** Strip the YAML frontmatter — the injected block carries name/location itself. */
function body(): string {
    return WAYFINDER_SKILL.replace(/^---[\s\S]*?---\s*/, "").trim();
}

/**
 * The full text `/wayfinder` submits. `args` (a loose idea, or a map URL /
 * number) rides after the block as the user's message, matching the shape the
 * built-in `/skill:<name>` command emits.
 */
export function buildInvocation(tracker: Exclude<Tracker, "auto">, args: string): string {
    const ops = tracker === "github" ? GITHUB_OPS : MARKDOWN_OPS;
    const block = `<skill name="wayfinder" location="${LOCATION}">\nReferences are relative to the current working directory.\n\n${body()}\n\n${ops}\n\n${LOOP_MAPPING}\n</skill>`;
    return args ? `${block}\n\n${args}` : block;
}
