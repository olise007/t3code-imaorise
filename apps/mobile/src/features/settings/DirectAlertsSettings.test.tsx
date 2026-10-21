// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  state: { enabled: false, selectedIds: [] as string[], running: false, statuses: {} },
  permission: vi.fn(),
  change: vi.fn(),
  alert: vi.fn(),
  scopes: new Set(["ready"]),
  environments: ["ready", "older", "denied"].map((id) => ({
    environmentId: id,
    environmentLabel: id,
    isEnabled: true,
    isRelayManaged: false,
  })),
  configs: new Map(
    ["ready", "denied"].map((id) => [
      id,
      { environment: { capabilities: { directAgentActivity: true } } },
    ]),
  ),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => harness.configs }));
vi.mock("expo-notifications", () => ({ requestPermissionsAsync: harness.permission }));
vi.mock("react-native", () => ({
  Alert: { alert: harness.alert },
  Linking: { openSettings: vi.fn() },
  AppState: { currentState: "active" },
}));
vi.mock("../../components/AppText", () => ({ AppText: "span" }));
vi.mock("../../state/workspace", () => ({ useWorkspaceEnvironments: () => harness.environments }));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (id: string) => harness.scopes.has(id),
}));
vi.mock("../agent-awareness/directAlerts", () => ({
  supportsDirectAlerts: true,
  useDirectAlerts: () => harness.state,
  refreshDirectAlerts: vi.fn(),
  setDirectAlertSelection: harness.change,
  openDirectBatterySettings: vi.fn(),
}));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("./components/SettingsRow", () => ({ SettingsRow: () => null }));
vi.mock("./components/SettingsSwitchRow", () => ({
  SettingsSwitchRow: ({
    label,
    disabled,
    value,
    onValueChange,
  }: {
    label: string;
    disabled: boolean;
    value: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <button disabled={disabled} onClick={() => onValueChange(!value)}>
      {label}
    </button>
  ),
}));
import { DirectAlertsSettings } from "./DirectAlertsSettings";
let root: Root;
let element: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.state = { enabled: false, selectedIds: [], running: false, statuses: {} };
  harness.change.mockClear();
  harness.alert.mockClear();
  harness.permission.mockClear().mockResolvedValue({ granted: true });
  element = document.createElement("div");
  root = createRoot(element);
  act(() => root.render(<DirectAlertsSettings />));
});
afterEach(() => act(() => root.unmount()));
const button = (label: string) =>
  Array.from(element.querySelectorAll("button")).find((item) => item.textContent === label)!;
const render = () => act(() => root.render(<DirectAlertsSettings />));

it("requires environment selection, an updated server and read permission", async () => {
  expect(button("Background alerts over direct connections").disabled).toBe(true);
  expect(button("older").disabled).toBe(true);
  expect(button("denied").disabled).toBe(true);
  await act(async () => button("ready").click());
  expect(harness.change).toHaveBeenLastCalledWith(false, ["ready"]);
  expect(harness.permission).not.toHaveBeenCalled();
});
it("denied Android permission prevents enabling; approval enables only selected environments", async () => {
  harness.state.selectedIds = ["ready"];
  render();
  harness.permission.mockResolvedValue({ granted: false });
  await act(async () => button("Background alerts over direct connections").click());
  expect(harness.change).not.toHaveBeenCalled();
  expect(harness.alert).toHaveBeenCalled();
  harness.permission.mockResolvedValue({ granted: true });
  await act(async () => button("Background alerts over direct connections").click());
  expect(harness.change).toHaveBeenLastCalledWith(true, ["ready"]);
});
it("can deselect an unavailable environment and disables listening when the final selection is removed", async () => {
  harness.state = { ...harness.state, enabled: true, selectedIds: ["older"] };
  render();
  expect(button("older").disabled).toBe(false);
  await act(async () => button("older").click());
  expect(harness.change).toHaveBeenLastCalledWith(false, []);
});
