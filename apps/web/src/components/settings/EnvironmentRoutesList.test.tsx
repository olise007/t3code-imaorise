// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
import { EnvironmentId } from "@t3tools/contracts";
import {
  BearerConnectionTarget,
  SshConnectionTarget,
  BearerConnectionProfile,
  SshConnectionProfile,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentPresentation } from "~/state/environments";
const state = vi.hoisted(() => ({ active: null as unknown }));
vi.mock("~/state/session", () => ({
  usePreparedConnection: () => ({ _tag: "Some", value: state.active }),
}));
vi.mock("~/connection/catalog", () => ({
  environmentCatalog: { reorderRoutes: {}, removeRoute: {} },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
import { EnvironmentRoutesList } from "./EnvironmentRoutesList";

it("keeps a healthy remote-link route in use and scopes retired-profile guidance to its SSH route", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const id = EnvironmentId.make("mixed");
  const active = new BearerConnectionTarget({
    environmentId: id,
    connectionId: "direct",
    label: "Remote link",
  });
  const retired = new SshConnectionTarget({
    environmentId: id,
    connectionId: "old",
    label: "Old WSL",
  });
  const direct = {
    target: active,
    profile: Option.some(
      new BearerConnectionProfile({
        environmentId: id,
        connectionId: "direct",
        label: "Remote link",
        httpBaseUrl: "http://127.0.0.1:4773",
        wsBaseUrl: "ws://127.0.0.1:4773",
      }),
    ),
  };
  const ssh = {
    target: retired,
    profile: Option.some(
      new SshConnectionProfile({
        environmentId: id,
        connectionId: "old",
        label: "Old WSL",
        target: {
          alias: "legacy",
          hostname: "legacy",
          username: "dev",
          port: 22,
          executionSource: { type: "wsl", distro: "Ubuntu" },
        },
      }),
    ),
  };
  state.active = { target: active };
  const environment = {
    environmentId: id,
    entry: { ...direct, enabled: true, alternateRoutes: [ssh] },
    connection: { phase: "connected" },
  } as unknown as EnvironmentPresentation;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<EnvironmentRoutesList environment={environment} onAddRoute={() => {}} />),
    );
    const rows = [...container.querySelectorAll("li")];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("In use");
    expect(rows[0]!.textContent).not.toContain("retired");
    expect(rows[1]!.textContent).toContain("retired");
    expect(rows[1]!.textContent).not.toContain("In use");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
