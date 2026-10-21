// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  platform: "android",
  cloud: false,
  navigate: vi.fn(),
  auth: vi.fn(() => ({ isLoaded: true, isSignedIn: false })),
  user: vi.fn(() => ({ user: null })),
}));
vi.mock("@clerk/expo", () => ({ useAuth: harness.auth, useUser: harness.user }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: harness.navigate, goBack: vi.fn() }),
}));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return harness.platform;
    },
  },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../components/ScreenScrollView", () => ({
  ScreenScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ListRow", () => ({
  ListRow: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => harness.cloud }));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({ layout: { usesSplitView: false } }),
}));
vi.mock("../../native/StackHeader", () => ({
  NativeStackScreenOptions: () => null,
  NativeHeaderToolbar: () => null,
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useSavedRemoteConnections: () => ({ savedConnectionsById: {} }),
}));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("./components/SettingsScreen", () => ({
  SettingsScreen: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  SettingsEnvironmentFilterHeader: () => null,
  AndroidSettingsEnvironmentFilter: () => null,
}));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    selectedTargets: [],
    projectGroups: [],
    selectedProjectKey: null,
  }),
}));

import { SettingsRouteScreen } from "./SettingsRouteScreen";
let root: Root;
let element: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  element = document.createElement("div");
  root = createRoot(element);
});
afterEach(() => act(() => root.unmount()));
const notificationButtons = () =>
  Array.from(element.querySelectorAll("button")).filter(
    (button) => button.textContent === "Notifications",
  );

it.each([
  { platform: "android", cloud: false },
  { platform: "android", cloud: true },
  { platform: "ios", cloud: true },
])(
  "opens notifications exactly once from $platform Settings with cloud=$cloud",
  ({ platform, cloud }) => {
    harness.platform = platform;
    harness.cloud = cloud;
    act(() => root.render(<SettingsRouteScreen />));
    expect(notificationButtons()).toHaveLength(1);
    act(() => notificationButtons()[0]!.click());
    expect(harness.navigate).toHaveBeenCalledExactlyOnceWith("SettingsSheet", {
      screen: "SettingsContent",
      params: { screen: "SettingsNotifications" },
    });
    if (!cloud) {
      expect(harness.auth).not.toHaveBeenCalled();
      expect(harness.user).not.toHaveBeenCalled();
    }
  },
);

it("keeps cloud-free iOS settings unchanged because direct background alerts are Android-only", () => {
  harness.platform = "ios";
  harness.cloud = false;
  act(() => root.render(<SettingsRouteScreen />));
  expect(notificationButtons()).toHaveLength(0);
  expect(harness.auth).not.toHaveBeenCalled();
});
