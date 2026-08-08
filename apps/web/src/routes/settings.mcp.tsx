import { createFileRoute } from "@tanstack/react-router";

import { LoopMcpSettings } from "../components/loop/LoopMcpSettings";

function SettingsMcpRoute() {
  // The GUI form of the terminal's /mcp panel. Upstream has no counterpart —
  // MCP is loop's — so this route is loop's.
  return <LoopMcpSettings />;
}

export const Route = createFileRoute("/settings/mcp")({
  component: SettingsMcpRoute,
});
