/**
 * The Agents settings panel — the GUI form of the terminal's `/agents`.
 *
 * An agent is a named system prompt with an optional tool allowlist and
 * subagent model. loop keeps them as markdown files and the composer's
 * AgentPicker offers them per message; this is where they are created.
 *
 * Two rules from loop are enforced here rather than discovered on save:
 * a built-in's tool set is fixed (only its prompt and model are editable, and
 * deleting it resets the prompt instead of removing the agent), and "every
 * tool" is the ABSENCE of an allowlist — see LoopAgentsSettings.logic.ts.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { BotIcon, PlusIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";

import {
  deleteAgent as deleteLoopAgent,
  getAgent,
  listAgentTools,
  listAgents,
  saveAgent as saveLoopAgent,
  type LoopAgent,
  type LoopAgentDetail,
} from "../../loop/agents";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { Badge } from "../ui/badge";
import { SettingsPageContainer, SettingsSection } from "../settings/settingsLayout";
import { cn } from "~/lib/utils";
import {
  agentNameError,
  draftFromAgent,
  isDraftDirty,
  sortAgentsForPanel,
  toolsForSave,
  toolsSummary,
  type AgentDraft,
} from "./LoopAgentsSettings.logic";

const NEW_AGENT_PROMPT =
  "You are a focused assistant for this project. Describe how it should work, what it should prioritise, and anything it must never do.";

function Note({ children }: { children: string }) {
  return <p className="px-3 py-3 text-[13px] text-muted-foreground/80 sm:px-4">{children}</p>;
}

export function LoopAgentsSettings() {
  const [agents, setAgents] = useState<readonly LoopAgent[]>([]);
  const [tools, setTools] = useState<readonly string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<LoopAgentDetail | null>(null);
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  const reload = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([listAgents(), listAgentTools()])
      .then(([nextAgents, nextTools]) => {
        if (cancelled) return;
        setAgents(nextAgents);
        setTools(nextTools);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [generation]);

  // Loading the prompt is a second call — agent.list withholds it because it
  // can be pages long and the list only needs names.
  useEffect(() => {
    if (selected === null) {
      setDetail(null);
      setDraft(null);
      return;
    }
    let cancelled = false;
    void getAgent(selected)
      .then((next) => {
        if (cancelled) return;
        setDetail(next);
        setDraft(draftFromAgent(next, tools));
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [selected, tools]);

  const ordered = useMemo(() => sortAgentsForPanel(agents), [agents]);
  const nameError = creating && draft ? agentNameError(draft.name, agents) : null;
  const dirty = draft !== null && detail !== null && isDraftDirty(draft, detail, tools);
  const canSave = creating ? nameError === null && draft !== null && draft.prompt.trim() !== "" : dirty;

  const startCreating = () => {
    setSelected(null);
    setDetail(null);
    setCreating(true);
    setError(null);
    setDraft({ name: "", prompt: NEW_AGENT_PROMPT, tools: [...tools], model: "" });
  };

  const open = (name: string) => {
    setCreating(false);
    setError(null);
    setSelected(name);
  };

  const close = () => {
    setCreating(false);
    setSelected(null);
    setDraft(null);
    setDetail(null);
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      await saveLoopAgent({
        name: draft.name.trim(),
        prompt: draft.prompt,
        // A built-in's tools are fixed; sending them would be ignored anyway,
        // and omitting them keeps the intent honest.
        ...(detail?.toolsEditable === false ? {} : { tools: toolsForSave(draft.tools, tools) }),
        model: draft.model.trim() || undefined,
      });
      setError(null);
      close();
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    setBusy(true);
    try {
      await deleteLoopAgent(name);
      setError(null);
      close();
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const editing = creating || draft !== null;
  // A built-in with no override cannot be deleted or reset — there is nothing
  // to remove, and the agent itself is part of loop.
  const canDelete = detail !== null && (!detail.builtin || detail.hasOverride);

  return (
    <SettingsPageContainer>
      <SettingsSection
        icon={<BotIcon className="size-4" />}
        title="Agents"
        headerAction={
          editing ? null : (
            <Button size="sm" variant="ghost" onClick={startCreating} disabled={loading}>
              <PlusIcon className="size-4" />
              New agent
            </Button>
          )
        }
      >
        {error ? <Note>{`loop did not answer: ${error}`}</Note> : null}

        {editing && draft ? (
          <div className="space-y-4 px-3 py-2 sm:px-4">
            <div className="space-y-1.5">
              <Label htmlFor="loop-agent-name">Name</Label>
              <Input
                id="loop-agent-name"
                value={draft.name}
                disabled={!creating}
                autoFocus={creating}
                placeholder="reviewer"
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
              <p className="text-[13px] text-muted-foreground/80">
                {nameError ??
                  (creating
                    ? "Becomes a /command for one-shot runs, and an option in the composer's agent picker."
                    : `Run it with /${draft.name} <message>, or pick it in the composer.`)}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="loop-agent-prompt">System prompt</Label>
              <Textarea
                id="loop-agent-prompt"
                value={draft.prompt}
                rows={14}
                className="font-mono text-[13px]"
                onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="loop-agent-model">Subagent model</Label>
              <Input
                id="loop-agent-model"
                value={draft.model}
                placeholder="inherit the session's model"
                onChange={(event) => setDraft({ ...draft, model: event.target.value })}
              />
              <p className="text-[13px] text-muted-foreground/80">
                Full model id (for example <code>openai/gpt-5-mini</code>) used when this agent runs
                as a subagent. Leave empty to inherit.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Tools</Label>
              {detail?.toolsEditable === false ? (
                <p className="text-[13px] text-muted-foreground/80">
                  {`Fixed for a built-in agent: ${toolsSummary(detail)}.`}
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap gap-x-4 gap-y-2">
                    {tools.map((tool) => (
                      <label className="flex items-center gap-2 text-[13px]" key={tool}>
                        <Checkbox
                          checked={draft.tools.includes(tool)}
                          onCheckedChange={(checked) =>
                            setDraft({
                              ...draft,
                              tools: checked
                                ? [...draft.tools, tool]
                                : draft.tools.filter((name) => name !== tool),
                            })
                          }
                        />
                        <span className="font-mono">{tool}</span>
                      </label>
                    ))}
                  </div>
                  <p className="text-[13px] text-muted-foreground/80">
                    All of them selected means every tool, including ones loop or an extension adds
                    later.
                  </p>
                </>
              )}
            </div>

            <div className="flex items-center gap-2 pt-1">
              <Button disabled={!canSave || busy} onClick={() => void save()} size="sm">
                {creating ? "Create agent" : "Save changes"}
              </Button>
              <Button onClick={close} size="sm" variant="ghost" disabled={busy}>
                Cancel
              </Button>
              {canDelete && detail ? (
                <Button
                  className="ms-auto text-destructive hover:text-destructive"
                  disabled={busy}
                  onClick={() => void remove(detail.name)}
                  size="sm"
                  variant="ghost"
                >
                  {detail.builtin ? (
                    <>
                      <RotateCcwIcon className="size-4" />
                      Reset to built-in
                    </>
                  ) : (
                    <>
                      <Trash2Icon className="size-4" />
                      Delete
                    </>
                  )}
                </Button>
              ) : null}
            </div>
          </div>
        ) : loading ? (
          <Note>Reading agents from loop…</Note>
        ) : ordered.length === 0 ? (
          <Note>This loop has no agents. Older versions do not report them over RPC.</Note>
        ) : (
          <div className="space-y-1">
            {ordered.map((agent) => (
              <button
                className={cn(
                  "flex w-full items-start gap-3 rounded-md px-3 py-2 text-left transition-colors sm:px-4",
                  "hover:bg-accent/50",
                )}
                key={agent.name}
                onClick={() => open(agent.name)}
                type="button"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">{agent.name}</span>
                    {agent.builtin ? (
                      <Badge variant="secondary" className="text-[11px]">
                        Built-in
                      </Badge>
                    ) : null}
                  </div>
                  <p className="truncate text-[13px] text-muted-foreground/80">
                    {toolsSummary(agent)}
                    {agent.model ? ` · ${agent.model}` : ""}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
