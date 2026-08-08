import { createFileRoute } from "@tanstack/react-router";

import { LoopProviderSettingsPanel } from "../components/settings/LoopProviderSettings";

function SettingsProvidersRoute() {
  return <LoopProviderSettingsPanel />;
}

export const Route = createFileRoute("/settings/providers")({
  component: SettingsProvidersRoute,
});
