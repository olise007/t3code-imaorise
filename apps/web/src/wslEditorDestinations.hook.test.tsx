import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  phase: "connected",
  probe: vi.fn(),
  backendId: "wsl:default",
  distro: "Debian",
}));
vi.mock("./remoteOpen", () => ({
  useRemoteOpenResolution: () => ({
    state: { mode: "local-wsl", backendId: state.backendId, distro: state.distro },
    connectionPhase: state.phase,
    isResolved: true,
  }),
}));
vi.mock("./hooks/useLocalStorage", () => ({
  useLocalStorage: () => [null, vi.fn()],
  getLocalStorageItem: () => null,
}));
import { useWslEditorDestinations } from "./wslEditorDestinations";

let renderer: ReactTestRenderer | undefined;
let current: ReturnType<typeof useWslEditorDestinations>;
const editors = ["vscode"] as const;
function Consumer() {
  const result = useWslEditorDestinations(EnvironmentId.make("wsl-test"), editors);
  useEffect(() => {
    current = result;
  }, [result]);
  return null;
}

beforeEach(() => {
  state.backendId = `wsl:test-${expect.getState().currentTestName}`;
  state.distro = "Debian";
  state.phase = "connected";
  state.probe.mockReset().mockResolvedValue(["vscode", "trae"]);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    desktopBridge: { probeLocalEditors: state.probe, openWslEditor: vi.fn() },
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("shares a cached probe, refreshes explicitly, and probes again after reconnect", async () => {
  await act(async () => {
    renderer = create(
      <>
        <Consumer />
        <Consumer />
      </>,
    );
  });
  expect(state.probe).toHaveBeenCalledTimes(1);
  expect(current!.options.filter((entry) => entry.source === "windows")).toHaveLength(2);
  state.probe.mockResolvedValue(["cursor"]);
  await act(async () => current!.refresh());
  expect(state.probe).toHaveBeenCalledTimes(2);
  expect(current!.options.find((entry) => entry.source === "windows")?.editor).toBe("cursor");
  state.phase = "reconnecting";
  await act(async () =>
    renderer!.update(
      <>
        <Consumer />
        <Consumer />
      </>,
    ),
  );
  state.phase = "connected";
  await act(async () =>
    renderer!.update(
      <>
        <Consumer />
        <Consumer />
      </>,
    ),
  );
  expect(state.probe).toHaveBeenCalledTimes(4);
});

it("keeps older desktops on their original WSL execution path", async () => {
  vi.stubGlobal("window", { desktopBridge: {} });
  await act(async () => {
    renderer = create(<Consumer />);
  });
  expect(current!.active).toBe(false);
  expect(state.probe).not.toHaveBeenCalled();
});

it("keeps WSL choices available when Windows detection fails", async () => {
  state.probe.mockRejectedValue(new Error("probe failed"));
  await act(async () => {
    renderer = create(<Consumer />);
  });
  expect(current!.loading).toBe(false);
  expect(current!.error).toContain("Refresh");
  expect(current!.preferred).toMatchObject({ editor: "vscode", source: "wsl" });
});
