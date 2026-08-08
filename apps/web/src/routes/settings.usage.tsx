import { createFileRoute } from "@tanstack/react-router";

import { LoopUsageSettings } from "../components/loop/LoopUsageSettings";

function SettingsUsageRoute() {
  // The GUI form of the terminal's /cost and /steak. Upstream has no
  // counterpart — both are loop's own — so this route is loop's.
  return <LoopUsageSettings />;
}

export const Route = createFileRoute("/settings/usage")({
  component: SettingsUsageRoute,
});
