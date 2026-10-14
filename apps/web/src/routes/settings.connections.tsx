import { createFileRoute, redirect } from "@tanstack/react-router";

import { ConnectionsSettings } from "../components/settings/ConnectionsSettings";

export const Route = createFileRoute("/settings/connections")({
  beforeLoad: ({ location }) => {
    if (
      ["wsl-backend", "wsl-agent-persistence", "wsl-background-server", "wsl-pairing"].includes(
        location.hash,
      )
    ) {
      throw redirect({
        to: "/settings/wsl",
        hash: location.hash,
        search: location.search,
        replace: true,
      });
    }
  },
  component: ConnectionsSettings,
});
