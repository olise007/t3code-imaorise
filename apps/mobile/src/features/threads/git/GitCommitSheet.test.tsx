// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  environment: "environment",
  thread: "thread",
  project: "project",
  cwd: "/repo",
  version: 1,
  files: [] as { path: string; status: string; insertions: number; deletions: number }[],
  generate: vi.fn(),
  prepare: vi.fn(),
  alert: vi.fn(),
  drafts: new Map<unknown, string>(),
  supported: true,
  isDefaultRef: false,
  action: undefined as "commit_push" | undefined,
  commit: vi.fn(),
  back: vi.fn(),
}));
function Box({ children }: { children?: ReactNode }) {
  return <div>{children}</div>;
}
type PressProps = {
  children?: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  accessibilityState?: { checked?: boolean };
};
function Press({
  children,
  onPress,
  disabled,
  accessibilityLabel,
  accessibilityRole,
  accessibilityState,
}: PressProps) {
  return (
    <button
      onClick={onPress}
      disabled={disabled}
      aria-label={accessibilityLabel}
      role={accessibilityRole}
      aria-checked={accessibilityState?.checked}
    >
      {children}
    </button>
  );
}
vi.mock("react-native", () => ({
  Alert: { alert: (...args: unknown[]) => state.alert(...args) },
  Platform: { OS: "ios" },
  useWindowDimensions: () => ({ height: 800, width: 400 }),
  View: Box,
  ScrollView: Box,
  Pressable: Press,
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: state.back }) }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) => state.drafts.get(atom) ?? "",
    set: (atom: unknown, value: string) => state.drafts.set(atom, value),
  },
}));
vi.mock("../../../state/server", () => ({
  serverEnvironment: { configValueAtom: () => "config" },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "config"
      ? {
          environment: {
            label: "Reviewed environment",
            capabilities: { gitCommitContext: state.supported },
          },
        }
      : true,
}));
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => command,
}));
vi.mock("../../../state/git", () => ({
  gitEnvironment: {
    prepareCommit: (input: unknown) => state.prepare(input),
    generateCommitMessage: Object.assign((input: unknown) => state.generate(input), {
      permissionAtom: () => "permission",
    }),
  },
}));
vi.mock("../../../state/vcs", () => ({ vcsEnvironment: { status: () => null } }));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: () => ({
    dataUpdatedAt: state.version,
    data: {
      refName: "main",
      isDefaultRef: state.isDefaultRef,
      workingTree: { files: state.files },
    },
  }),
}));
vi.mock("../../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: {
      environmentId: state.environment,
      id: state.thread,
      projectId: state.project,
    },
  }),
}));
vi.mock("../../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: state.cwd }),
}));
vi.mock("../../../state/use-selected-thread-git-state", () => ({
  useSelectedThreadGitState: () => ({ gitOperationLabel: null }),
}));
vi.mock("../../../state/use-selected-thread-git-actions", () => ({
  useSelectedThreadGitActions: () => ({
    canWriteSourceControl: true,
    canChangeThreadBranch: true,
    onRunSelectedThreadGitAction: state.commit,
  }),
}));
vi.mock("../../../components/AndroidScreenHeader", () => ({ AndroidSheetHeader: () => null }));
vi.mock("../../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../../components/MaterialScreenContent", () => ({ MaterialScreenContent: Box }));
vi.mock("../../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../../components/AppText", () => ({
  AppText: ({
    children,
    accessibilityRole,
  }: {
    children: ReactNode;
    accessibilityRole?: string;
  }) => <span role={accessibilityRole}>{children}</span>,
  AppTextInput: ({
    value,
    onChangeText,
  }: {
    value: string;
    onChangeText: (value: string) => void;
  }) => (
    <textarea
      aria-label="Commit message"
      value={value}
      onChange={(event) => onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("./gitSheetComponents", () => ({
  SheetActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled: boolean;
  }) => (
    <button onClick={onPress} disabled={disabled}>
      {label}
    </button>
  ),
}));

import { GitCommitSheet } from "./GitCommitSheet";

let root: Root;
let element: HTMLDivElement;
const ignored = "tests/customers/directory_pagination_browser_test.js";
const file = (path: string, insertions: number) => ({
  path,
  insertions,
  deletions: 0,
  status: "modified",
});
const render = () =>
  act(() =>
    root.render(
      <GitCommitSheet
        route={{
          params: {
            environmentId: state.environment,
            threadId: state.thread,
            action: state.action,
          },
        }}
      />,
    ),
  );
function button(label: string) {
  const found = Array.from(element.querySelectorAll("button")).find(
    (entry) => entry.textContent === label || entry.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
const click = async (label: string) => {
  await act(async () => button(label).click());
};
const message = () => element.querySelector("textarea")!;
function typeMessage(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      message(),
      value,
    );
    message().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function pendingGeneration() {
  let finish!: (
    value: ReturnType<
      typeof AsyncResult.success<{ message: string | null; skippedFilePaths?: string[] }>
    >,
  ) => void;
  state.generate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  return (message: string | null, skippedFilePaths = [ignored]) =>
    act(async () => finish(AsyncResult.success({ message, skippedFilePaths })));
}
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.drafts.clear();
  state.supported = true;
  state.action = undefined;
  state.isDefaultRef = false;
  state.alert.mockReset();
  state.prepare.mockReset().mockImplementation(async ({ environmentId, input }) =>
    AsyncResult.success({
      commitContext: {
        environmentId,
        cwd: input.cwd,
        repositoryRoot: input.cwd,
        gitDirectory: `${input.cwd}/.git`,
        gitCommonDirectory: `${input.cwd}/.git`,
        branch: "main",
        head: "head",
        fingerprint: "tree",
        filePaths: [...input.filePaths].sort(),
        threadId: input.threadId,
      },
      skippedFilePaths: [],
    }),
  );
  state.environment = "environment";
  state.thread = "thread";
  state.project = "project";
  state.cwd = "/repo";
  state.version = 1;
  state.files = [file("eligible.ts", 4), file(ignored, 49)];
  state.generate
    .mockReset()
    .mockResolvedValue(
      AsyncResult.success({ message: "Update eligible file", skippedFilePaths: [ignored] }),
    );
  state.commit.mockReset().mockResolvedValue(null);
  state.back.mockReset();
  element = document.createElement("div");
  root = createRoot(element);
  await act(async () => {
    render();
  });
});
afterEach(() => act(() => root.unmount()));

describe("mobile workspace-bound commits", () => {
  it.each(["Commit", "Commit on new branch"])(
    "uses the reviewed selection for %s",
    async (action) => {
      await click("Generate commit message");
      expect(state.generate.mock.calls[0]?.[0].input.commitContext.cwd).toBe("/repo");
      expect(message().value).toBe("Update eligible file");
      expect(element.textContent).toContain(ignored);
      await click(action);
      expect(state.commit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "commit",
          filePaths: ["eligible.ts"],
          commitContext: expect.objectContaining({
            cwd: "/repo",
            threadId: "thread",
            filePaths: ["eligible.ts"],
          }),
          featureBranch: action === "Commit on new branch",
        }),
        expect.any(Function),
      );
    },
  );
  it.each(["environment", "thread", "worktree", "project-record"])(
    "dismisses and blocks late generation after the %s changes",
    async (change) => {
      typeMessage("Original draft");
      const finish = pendingGeneration();
      await click("Generate commit message");
      if (change === "project-record") state.project = "other-project";
      if (change === "environment") state.environment = "other-environment";
      if (change === "thread") state.thread = "other-thread";
      if (change === "worktree") state.cwd = "/other-repo";
      render();
      await finish("Stale generated message");
      expect(state.back).toHaveBeenCalled();
      expect(message().value).toBe("Original draft");
      await click("Commit");
      expect(state.commit).not.toHaveBeenCalled();
    },
  );
  it("cancels a pending default-branch prompt when the route workspace changes", async () => {
    state.action = "commit_push";
    state.isDefaultRef = true;
    act(() => root.unmount());
    root = createRoot(element);
    await act(async () => {
      render();
    });
    typeMessage("Reviewed A");
    await click("Commit");
    expect(state.alert).toHaveBeenCalled();
    const continueAction = state.alert.mock.calls[0]?.[2][1].onPress;
    state.cwd = "/other-repo";
    render();
    await act(async () => continueAction());
    expect(state.commit).not.toHaveBeenCalled();
  });
  it("preserves the message and displays failure without dismissing", async () => {
    typeMessage("Keep draft");
    await click("Commit");
    expect(state.back).not.toHaveBeenCalled();
    expect(message().value).toBe("Keep draft");
    expect(element.textContent).toContain("Commit failed");
  });
  it("does not erase user edits when generation completes", async () => {
    typeMessage("Draft");
    const finish = pendingGeneration();
    await click("Generate commit message");
    typeMessage("User edit");
    await finish("Old generated text");
    expect(message().value).toBe("User edit");
  });
  it("restores the original workspace draft when reopening", async () => {
    typeMessage("Saved draft");
    act(() => root.unmount());
    root = createRoot(element);
    await act(async () => {
      render();
    });
    expect(message().value).toBe("Saved draft");
  });
  it("blocks unsupported servers with update guidance", async () => {
    state.supported = false;
    render();
    typeMessage("Keep draft");
    expect(button("Commit").disabled).toBe(true);
    expect(element.textContent).toContain("Update this T3 server");
  });
  it("keeps the explicit file list when unreviewed files appear", async () => {
    typeMessage("Selected changes");
    state.files = [...state.files, file("late.txt", 10)];
    state.version++;
    render();
    await click("Commit");
    expect(state.commit.mock.calls[0]?.[0].filePaths).toEqual(["eligible.ts", ignored].sort());
  });
});
