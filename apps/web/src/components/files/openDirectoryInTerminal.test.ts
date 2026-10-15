import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "~/terminalUiStateStore";
import { directoryTerminalMenuItems, openDirectoryInTerminal } from "./openDirectoryInTerminal";

const threadRef = {
  environmentId: EnvironmentId.make("wsl-ubuntu"),
  threadId: ThreadId.make("thread-1"),
};
const state = () =>
  selectThreadTerminalUiState(
    useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
    threadRef,
  );
beforeEach(() => {
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
});

describe("directory terminal action", () => {
  it("offers the action only for directories and disables unavailable terminals", () => {
    expect(directoryTerminalMenuItems("file", true)).toEqual([]);
    expect(directoryTerminalMenuItems(undefined, true)).toEqual([]);
    expect(directoryTerminalMenuItems("directory", false)).toMatchObject([
      { id: "open-in-terminal", disabled: true },
    ]);
    expect(directoryTerminalMenuItems("directory", true)).toMatchObject([
      { id: "open-in-terminal", disabled: false },
    ]);
  });

  it.each([
    [
      "windows",
      "C:\\Projects\\My app",
      "src/Directory with spaces",
      "C:\\Projects\\My app\\src\\Directory with spaces",
    ],
    ["wsl-ubuntu", "/home/user/project", "docker/php", "/home/user/project/docker/php"],
    [
      "remote-linux",
      "/srv/worktree",
      "$(touch injected); 'quoted'",
      "/srv/worktree/$(touch injected); 'quoted'",
    ],
  ])(
    "opens literal paths on their %s environment",
    async (environmentId, workspaceRoot, relativePath, cwd) => {
      const ref = { ...threadRef, environmentId: EnvironmentId.make(environmentId) };
      const open = vi.fn(async () => AsyncResult.success(undefined));
      await openDirectoryInTerminal({
        threadRef: ref,
        workspaceRoot,
        relativePath,
        terminalId: "term-2",
        canOpen: () => true,
        open,
        focus: vi.fn(),
      });
      expect(open).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: { threadId: threadRef.threadId, terminalId: "term-2", cwd },
      });
    },
  );

  it("keeps existing tabs and reveals the new terminal only after the open succeeds", async () => {
    useTerminalUiStateStore.getState().newTerminal(threadRef, "term-1");
    let finishOpen!: (result: ReturnType<typeof AsyncResult.success<void>>) => void;
    const pending = new Promise<ReturnType<typeof AsyncResult.success<void>>>((resolve) => {
      finishOpen = resolve;
    });
    const focus = vi.fn();
    const open = vi.fn(async () => pending);
    const opening = openDirectoryInTerminal({
      threadRef,
      workspaceRoot: "/repo/worktree",
      relativePath: "docker/php",
      terminalId: "term-2",
      worktreePath: "/repo/worktree",
      env: { PROJECT_ROOT: "/repo" },
      canOpen: () => true,
      open,
      focus,
    });
    expect(state().terminalIds).toEqual(["term-1"]);
    expect(open).toHaveBeenCalledExactlyOnceWith({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        terminalId: "term-2",
        cwd: "/repo/worktree/docker/php",
        worktreePath: "/repo/worktree",
        env: { PROJECT_ROOT: "/repo" },
      },
    });
    expect(focus).not.toHaveBeenCalled();
    finishOpen(AsyncResult.success(undefined));
    await opening;
    expect(state()).toMatchObject({
      terminalIds: ["term-1", "term-2"],
      activeTerminalId: "term-2",
      terminalOpen: true,
    });
    expect(focus).toHaveBeenCalledOnce();
  });

  it.each(["permission denied", "environment disconnected"])("does not open when %s", async () => {
    const open = vi.fn(async () => AsyncResult.success(undefined));
    await expect(
      openDirectoryInTerminal({
        threadRef,
        workspaceRoot: "/repo",
        relativePath: "src",
        terminalId: "term-1",
        canOpen: () => false,
        open,
        focus: vi.fn(),
      }),
    ).rejects.toThrow("Terminal access is unavailable");
    expect(open).not.toHaveBeenCalled();
    expect(state().terminalIds).toEqual([]);
  });

  it.each(["Directory no longer exists", "Permission denied", "Environment disconnected"])(
    "reports %s without adding a failed tab",
    async (message) => {
      const focus = vi.fn();
      await expect(
        openDirectoryInTerminal({
          threadRef,
          workspaceRoot: "/repo",
          relativePath: "src",
          terminalId: "term-1",
          canOpen: () => true,
          open: async () => AsyncResult.failure(Cause.fail(new Error(message))),
          focus,
        }),
      ).rejects.toThrow(message);
      expect(state().terminalIds).toEqual([]);
      expect(focus).not.toHaveBeenCalled();
    },
  );

  it("rejects an unresolvable directory before calling the host", async () => {
    const open = vi.fn(async () => AsyncResult.success(undefined));
    await expect(
      openDirectoryInTerminal({
        threadRef,
        workspaceRoot: "/repo",
        relativePath: "../outside",
        terminalId: "term-1",
        canOpen: () => true,
        open,
        focus: vi.fn(),
      }),
    ).rejects.toThrow("could not be resolved");
    expect(open).not.toHaveBeenCalled();
  });
});
