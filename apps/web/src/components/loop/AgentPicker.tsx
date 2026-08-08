/**
 * Which agent the next message runs under.
 *
 * loop's `/<agent> <message>` is a ONE-SHOT: that message runs under the
 * agent's prompt and the session's own agent is untouched. This control says
 * the same thing — it is a per-turn choice sitting beside the model and the
 * effort, not a session setting.
 *
 * The choice rides `modelSelection.options` as `{id: "agent"}`, the same
 * per-turn slot reasoning effort uses, because the contract's turn command has
 * no agent field. `dispatch.ts` reads it back out (`agentOptionOf`).
 *
 * Absent entirely when loop offers nothing but the built-in persona — a picker
 * with one item is noise.
 *
 * TWO surfaces, mirroring `TraitsPicker`/`TraitsMenuContent`: the standalone
 * control for the wide composer footer, and a menu section for the narrow
 * one's overflow menu. Without the second, the picker vanished the moment the
 * composer went compact — which is most of the time in the desktop window,
 * with a sidebar and a right panel taking the width. That is the "agent switch
 * works in the CLI but not in the desktop app" report: it was not missing,
 * it was unreachable.
 */
import type { ProviderInstanceId, ProviderOptionSelection } from "@loop/contracts";
import { BotIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { listAgents, type LoopAgent } from "../../loop/agents";
import { ComposerControl, ComposerControlChevron, ComposerControlIcon } from "../chat/ComposerControl";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";

/** loop's name for the built-in persona; sending it is the same as sending nothing. */
const DEFAULT_AGENT = "default";

export interface AgentPickerProps {
  readonly provider: string;
  readonly instanceId?: ProviderInstanceId | undefined;
  readonly model: string;
  readonly threadRef?: { readonly environmentId: string; readonly threadId: string } | undefined;
  readonly draftId?: DraftId | undefined;
  readonly modelOptions: readonly ProviderOptionSelection[] | undefined;
  /** The folder to ask, so a project's own agents are offered. */
  readonly cwd?: string | undefined;
}

/**
 * loop's agents for a folder, fetched once per folder.
 *
 * Cached because three separate controls now ask for the same list — the wide
 * footer's picker, the narrow footer's menu section, and the composer deciding
 * whether that menu has anything in it — and one RPC round trip per render
 * path is three answers to one question.
 */
const agentsByCwd = new Map<string, Promise<readonly LoopAgent[]>>();

export function useLoopAgents(cwd?: string): readonly LoopAgent[] {
  const [agents, setAgents] = useState<readonly LoopAgent[]>([]);

  useEffect(() => {
    let cancelled = false;
    const key = cwd ?? "";
    let pending = agentsByCwd.get(key);
    if (!pending) {
      pending = listAgents(cwd);
      agentsByCwd.set(key, pending);
    }
    void pending.then((listed) => {
      if (!cancelled) setAgents(listed);
    });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  return agents;
}

/** Whether picking an agent is a real choice here — two or more to choose from. */
export function useHasAgentChoices(cwd?: string): boolean {
  return useLoopAgents(cwd).length >= 2;
}

/** The agent currently selected, and how to change it. */
function useAgentSelection({
  provider,
  instanceId,
  model,
  threadRef,
  draftId,
  modelOptions,
  cwd,
}: AgentPickerProps): {
  readonly agents: readonly LoopAgent[];
  readonly selectedName: string;
  readonly choose: (name: string) => void;
} {
  const agents = useLoopAgents(cwd);
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);

  const selected = modelOptions?.find((option) => option.id === "agent")?.value ?? DEFAULT_AGENT;
  const selectedName = typeof selected === "string" ? selected : DEFAULT_AGENT;

  const choose = (name: string) => {
    const target = threadRef ?? draftId;
    if (!target) return;
    const rest = (modelOptions ?? []).filter((option) => option.id !== "agent");
    // The default is expressed by omitting the option, so the stored selection
    // says exactly what the wire will.
    const next =
      name === DEFAULT_AGENT
        ? rest
        : [...rest, { id: "agent", value: name } as ProviderOptionSelection];
    setProviderModelOptions(target as never, provider as never, next, {
      ...(instanceId ? { instanceId } : {}),
      model,
      persistSticky: true,
    });
  };

  return { agents, selectedName, choose };
}

/**
 * The list itself.
 *
 * `closeOnClick` is set explicitly because base-ui's `MenuRadioItem` defaults
 * it to **false** (unlike `MenuItem`) — so picking an agent left the popup
 * hanging open over the composer with nothing left to decide.
 */
function AgentRadioItems({
  agents,
  selectedName,
  choose,
}: {
  readonly agents: readonly LoopAgent[];
  readonly selectedName: string;
  readonly choose: (name: string) => void;
}) {
  return (
    <MenuRadioGroup onValueChange={(value) => choose(String(value))} value={selectedName}>
      {agents.map((agent) => (
        <MenuRadioItem closeOnClick key={agent.name} value={agent.name}>
          {agent.name === DEFAULT_AGENT ? "Default" : agent.name}
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}

export const AgentPicker = memo(function AgentPicker(props: AgentPickerProps) {
  const { agents, selectedName, choose } = useAgentSelection(props);

  // One agent means only the built-in persona: nothing to choose between.
  // Also how this degrades against a loop with no `agent.list` — that call
  // 404s, the list comes back empty, and the control simply is not there.
  if (agents.length < 2) return null;

  const label = selectedName === DEFAULT_AGENT ? "Agent" : selectedName;

  return (
    <Menu>
      <MenuTrigger
        render={
          <ComposerControl
            aria-label={`Agent for the next message: ${selectedName}`}
            className="shrink-0 whitespace-nowrap"
            type="button"
          />
        }
      >
        <ComposerControlIcon icon={BotIcon} />
        <span className="sr-only sm:not-sr-only">{label}</span>
        <ComposerControlChevron />
      </MenuTrigger>
      <MenuPopup align="start">
        <AgentRadioItems agents={agents} choose={choose} selectedName={selectedName} />
      </MenuPopup>
    </Menu>
  );
});

/**
 * The same choice as a section of somebody else's menu — the narrow
 * composer's overflow menu. Returns null under the same conditions as the
 * standalone control, so the overflow menu can ask "is there anything here?"
 * the way it already does for the traits section.
 */
export const AgentMenuContent = memo(function AgentMenuContent(props: AgentPickerProps) {
  const { agents, selectedName, choose } = useAgentSelection(props);
  if (agents.length < 2) return null;

  return (
    <MenuGroup>
      <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">Agent</div>
      <AgentRadioItems agents={agents} choose={choose} selectedName={selectedName} />
    </MenuGroup>
  );
});
