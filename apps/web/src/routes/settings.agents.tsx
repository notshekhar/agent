import { createFileRoute } from "@tanstack/react-router";

import { LoopAgentsSettings } from "../components/loop/LoopAgentsSettings";

function SettingsAgentsRoute() {
  // The GUI form of the terminal's /agents. Upstream has no counterpart —
  // agents are loop's concept — so this route is loop's own.
  return <LoopAgentsSettings />;
}

export const Route = createFileRoute("/settings/agents")({
  component: SettingsAgentsRoute,
});
