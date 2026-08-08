import { createFileRoute } from "@tanstack/react-router";

import { LoopDatasourceSettings } from "../components/loop/LoopDatasourceSettings";

function SettingsDatasourcesRoute() {
  // The GUI form of the terminal's /datasource panel. Upstream has no
  // counterpart — datasources are loop's — so this route is loop's.
  return <LoopDatasourceSettings />;
}

export const Route = createFileRoute("/settings/datasources")({
  component: SettingsDatasourcesRoute,
});
