// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DesktopBridge, DesktopWslState } from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  data: null as DesktopWslState | null,
  allowed: true,
  environments: [] as unknown[],
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: state.data, error: null, isPending: false }),
}));
vi.mock("~/state/desktopWslState", () => ({
  desktopWslStateAtom: {},
  refreshDesktopWslState: vi.fn(),
}));
vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => "local",
  useEnvironments: () => ({ environments: state.environments }),
}));
vi.mock("~/state/session", () => ({
  useEnvironmentScope: () => state.allowed,
  readEnvironmentScope: () => state.allowed,
}));
vi.mock("~/localEnvironment", () => ({ isLocalEnvironmentDisabled: () => false }));
vi.mock("./ConnectionsSettings", () => ({
  WslPairingSettings: () => <div>Pair WSL with another device</div>,
}));
vi.mock("./RemoteBackgroundSettings", () => ({
  RemoteBackgroundSettings: () => <div>Remote WSL runtime</div>,
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  SettingsSection: ({ children, title }: { children: ReactNode; title: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    control,
    status,
  }: {
    title: ReactNode;
    control?: ReactNode;
    status?: ReactNode;
  }) => (
    <div>
      <span>{title}</span>
      {control}
      {status}
    </div>
  ),
}));

import { WslSettings } from "./WslSettings";
import { DesktopTraySettings } from "./DesktopBackgroundSettings";
import { BackendStartupSettings } from "./BackendStartupSettings";

let host: HTMLDivElement;
let root: Root;
let warnings: ReturnType<typeof vi.spyOn>;
const settings = {
  distro: "Ubuntu",
  keepAgentsRunning: true,
  closeToTray: true,
  minimizeToTray: false,
  serverRunning: true,
};
const labels = () => [...host.querySelectorAll("span")].map((node) => node.textContent);

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
  state.allowed = true;
  state.environments = [];
  state.data = {
    available: true,
    enabled: true,
    wslOnly: false,
    distro: "Ubuntu",
    distros: [{ name: "Ubuntu", isDefault: true }],
  } as DesktopWslState;
  window.desktopBridge = {
    getBackgroundSettings: vi.fn(async () => ({
      ...settings,
      distro: state.data?.distro ?? "Ubuntu",
    })),
    getBackendStartupStates: vi.fn(async () => []),
  } as unknown as DesktopBridge;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  warnings = vi.spyOn(console, "error");
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  delete window.desktopBridge;
});
const render = async (node: ReactNode = <WslSettings />) => {
  await act(async () => {
    root.render(node);
  });
};

describe("WSL settings refresh reconciliation", () => {
  it("filters startup status by backend and cancels polling when leaving the page", async () => {
    vi.useFakeTimers();
    try {
      window.desktopBridge!.getBackendStartupStates = vi.fn(async () => [
        {
          id: "primary",
          label: "Windows",
          status: { phase: "running" as const, port: 4773, attempt: 1 },
        },
        {
          id: "wsl:Ubuntu",
          label: "Ubuntu",
          status: { phase: "running" as const, port: 4775, attempt: 1 },
        },
      ]);
      await render(<BackendStartupSettings bridge={window.desktopBridge!} kind="wsl" />);
      expect(host.textContent).toContain("Ubuntu:");
      expect(host.textContent).not.toContain("Windows:");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(host.textContent?.match(/Ubuntu:/g)).toHaveLength(1);
      await render(null);
      expect(vi.getTimerCount()).toBe(0);
      await render(<BackendStartupSettings bridge={window.desktopBridge!} kind="windows" />);
      expect(host.textContent).toContain("Windows:");
      expect(host.textContent).not.toContain("Ubuntu:");
      await render(null);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps one background section through refreshes, pairing visibility, distro switches and reopening", async () => {
    await render();
    for (const [enabled, distro] of [
      [true, "Ubuntu"],
      [false, "Ubuntu"],
      [true, "Debian"],
      [true, "Debian"],
      [true, "Ubuntu"],
    ] as const) {
      state.data = { ...state.data!, enabled, distro };
      await render();
      expect(
        labels().filter((label) => label === "Keep agents running when T3 closes"),
      ).toHaveLength(1);
      expect(labels().filter((label) => label === "WSL background server")).toHaveLength(1);
      expect(host.textContent?.match(/Pair WSL with another device/g) ?? []).toHaveLength(
        enabled ? 1 : 0,
      );
      expect(host.textContent).not.toContain("Close to system tray");
    }
    await render(null);
    await render();
    expect(labels().filter((label) => label === "WSL background server")).toHaveLength(1);
    expect(
      warnings.mock.calls.filter((call) =>
        call.some((value) => typeof value === "string" && /same key|unique.*key/i.test(value)),
      ),
    ).toHaveLength(0);
  });

  it("keeps tray controls separate from WSL controls", async () => {
    await render(<DesktopTraySettings />);
    expect(labels().filter((label) => label === "Close to system tray")).toHaveLength(1);
    expect(labels().filter((label) => label === "Minimize to system tray")).toHaveLength(1);
    expect(host.textContent).not.toContain("WSL background server");
    expect(host.textContent).not.toContain("Keep agents running");
  });

  it("does not expose local WSL mutations without maintenance permission", async () => {
    state.allowed = false;
    await render();
    expect(host.textContent).toContain("Local WSL configuration");
    expect(host.textContent).not.toContain("Stop background server");
    expect(window.desktopBridge?.getBackgroundSettings).not.toHaveBeenCalled();
  });
});
