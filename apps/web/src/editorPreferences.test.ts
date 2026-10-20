import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { assert, afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { RemoteOpenState } from "./remoteOpen";

const state = vi.hoisted(() => ({
  allowed: new Set<string>(),
  run: vi.fn(),
  getPreference: vi.fn(),
  setPreference: vi.fn(),
  wsl: {
    active: false,
    remote: { mode: "local-wsl", backendId: "primary", distro: "Ubuntu" } as RemoteOpenState,
    options: [
      { editor: "vscode", source: "windows", enabled: true },
      { editor: "vscode", source: "wsl", enabled: true },
    ],
    preferred: { editor: "vscode", source: "windows" },
    remember: vi.fn(),
  },
  openWsl: vi.fn(),
  openRemote: vi.fn(),
}));

vi.mock("./wslEditorDestinations", () => ({ useWslEditorDestinations: () => state.wsl }));
vi.mock("./remoteOpen", () => ({ openRemoteEditorUrl: state.openRemote }));

vi.mock("react", () => ({ useCallback: (callback: unknown) => callback }));
vi.mock("./state/shell", () => ({ shellEnvironment: { openInEditor: "openInEditor" } }));
vi.mock("./state/use-atom-command", () => ({ useAtomCommand: () => state.run }));
vi.mock("./state/session", () => ({
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.allowed.has(environmentId),
}));
vi.mock("./hooks/useLocalStorage", () => ({
  getLocalStorageItem: state.getPreference,
  setLocalStorageItem: state.setPreference,
  useLocalStorage: vi.fn(),
}));

import { useOpenInPreferredEditor } from "./editorPreferences";

const primary = EnvironmentId.make("primary");
const secondary = EnvironmentId.make("secondary");
afterEach(() => vi.unstubAllGlobals());

beforeEach(() => {
  state.allowed.clear();
  state.run.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.getPreference.mockReset().mockReturnValue(null);
  state.setPreference.mockReset();
  state.wsl.active = false;
  state.wsl.remote = { mode: "local-wsl", backendId: "primary", distro: "Ubuntu" };
  state.wsl.remember.mockReset();
  state.openWsl.mockReset().mockResolvedValue(true);
  state.openRemote.mockReset().mockResolvedValue(true);
  vi.stubGlobal("window", { desktopBridge: { openWslEditor: state.openWsl } });
});

it("routes file positions to Windows and remembers only accepted launches", async () => {
  state.allowed.add(secondary);
  state.wsl.active = true;
  const open = useOpenInPreferredEditor(secondary, ["vscode"]);
  expect((await open("/home/me/Ω file.ts:12:3"))._tag).toBe("Success");
  expect(state.openWsl).toHaveBeenCalledWith({
    backendId: "primary",
    distro: "Ubuntu",
    editor: "vscode",
    path: "/home/me/Ω file.ts",
    line: 12,
    column: 3,
  });
  expect(state.run).not.toHaveBeenCalled();
  state.wsl.remember.mockClear();
  state.openWsl.mockResolvedValue(false);
  expect((await open("/work"))._tag).toBe("Failure");
  expect(state.wsl.remember).not.toHaveBeenCalled();
});

it("keeps WSL execution separate and rechecks permission before Windows launches", async () => {
  state.allowed.add(secondary);
  state.wsl.active = true;
  const open = useOpenInPreferredEditor(secondary, ["vscode"]);
  expect((await open("/work", { editor: "vscode", source: "wsl" }))._tag).toBe("Success");
  expect(state.run).toHaveBeenCalledWith({
    environmentId: secondary,
    input: { cwd: "/work", editor: "vscode" },
  });
  state.allowed.clear();
  expect((await open("/work"))._tag).toBe("Failure");
  expect(state.openWsl).not.toHaveBeenCalled();
});

it("keeps SSH opens on the viewing machine rather than the environment backend", async () => {
  state.wsl.remote = { mode: "remote-links", host: { kind: "ssh-alias", host: "build-host" } };
  expect((await useOpenInPreferredEditor(secondary, [])("/work/file.ts"))._tag).toBe("Success");
  expect(state.openRemote).toHaveBeenCalledWith(
    "vscode://vscode-remote/ssh-remote+build-host/work/file.ts",
  );
  expect(state.run).not.toHaveBeenCalled();
});

it("does not use another environment's grant or change preferences when denied", async () => {
  state.allowed.add(primary);
  const open = useOpenInPreferredEditor(secondary, ["vscode"]);
  const result = await open("/work/readme.md");
  assert(result._tag === "Failure");
  const error = Cause.squash(result.cause);
  expect(error).toBeInstanceOf(EnvironmentAuthorizationError);
  expect(error).toMatchObject({ requiredScope: AuthOrchestrationOperateScope });
  expect(state.run).not.toHaveBeenCalled();
  expect(state.getPreference).not.toHaveBeenCalled();
  expect(state.setPreference).not.toHaveBeenCalled();
});

it("checks revocation and regrant when a retained editor callback is invoked", async () => {
  state.allowed.add(secondary);
  const open = useOpenInPreferredEditor(secondary, ["vscode"]);
  state.allowed.delete(secondary);
  expect((await open("/work/readme.md:5"))._tag).toBe("Failure");
  expect(state.run).not.toHaveBeenCalled();

  state.allowed.add(secondary);
  expect(await open("/work/readme.md:5")).toMatchObject({ _tag: "Success", value: "vscode" });
  expect(state.run).toHaveBeenCalledExactlyOnceWith({
    environmentId: secondary,
    input: { cwd: "/work/readme.md:5", editor: "vscode" },
  });
  expect(state.setPreference).toHaveBeenCalledTimes(1);
});

it("keeps the stored available editor for an authorized launch", async () => {
  state.allowed.add(secondary);
  state.getPreference.mockReturnValue("cursor");
  const open = useOpenInPreferredEditor(secondary, ["vscode", "cursor"]);
  expect(await open("/work")).toMatchObject({ _tag: "Success", value: "cursor" });
  expect(state.run).toHaveBeenCalledExactlyOnceWith({
    environmentId: secondary,
    input: { cwd: "/work", editor: "cursor" },
  });
  expect(state.setPreference).not.toHaveBeenCalled();
});

it("returns the existing failures for a missing environment or editor", async () => {
  state.allowed.add(secondary);
  expect((await useOpenInPreferredEditor(null, ["vscode"])("/work"))._tag).toBe("Failure");
  expect((await useOpenInPreferredEditor(secondary, [])("/work"))._tag).toBe("Failure");
  expect(state.run).not.toHaveBeenCalled();
});
