import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Usage moved out of Settings and into the sidebar (`/usage`), because it
 * reports rather than configures. The old path stays as a redirect: it is what
 * bookmarks, the settings search index and any older desktop build still point
 * at, and a dead route there would read as the feature having been removed.
 */
export const Route = createFileRoute("/settings/usage")({
  beforeLoad: () => {
    throw redirect({ to: "/usage", replace: true });
  },
});
