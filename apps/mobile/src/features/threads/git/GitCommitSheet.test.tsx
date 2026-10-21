// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  environment: "environment",
  thread: "thread",
  cwd: "/repo",
  version: 1,
  files: [] as { path: string; status: string; insertions: number; deletions: number }[],
  generate: vi.fn(),
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
  Platform: { OS: "ios" },
  useWindowDimensions: () => ({ height: 800, width: 400 }),
  View: Box,
  ScrollView: Box,
  Pressable: Press,
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: state.back }) }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => command,
}));
vi.mock("../../../state/git", () => ({
  gitEnvironment: {
    generateCommitMessage: Object.assign((input: unknown) => state.generate(input), {
      permissionAtom: () => "permission",
    }),
  },
}));
vi.mock("../../../state/vcs", () => ({ vcsEnvironment: { status: () => null } }));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: () => ({
    dataUpdatedAt: state.version,
    data: { refName: "main", isDefaultRef: false, workingTree: { files: state.files } },
  }),
}));
vi.mock("../../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: { environmentId: state.environment, id: state.thread },
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
        route={{ params: { environmentId: state.environment, threadId: state.thread } }}
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
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.environment = "environment";
  state.thread = "thread";
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
  render();
});
afterEach(() => act(() => root.unmount()));

describe("mobile commit message preview", () => {
  it.each(["Commit", "Commit on new branch"])(
    "warns, deselects ignored files and uses the remaining selection for %s",
    async (action) => {
      await click("Generate commit message");
      expect(state.generate.mock.calls[0]?.[0].input).toMatchObject({
        skipIgnoredFiles: true,
        filePaths: ["eligible.ts", ignored],
      });
      expect(element.querySelector('[role="alert"]')?.textContent).toContain(ignored);
      expect(element.textContent).not.toContain("+53");
      expect(message().value).toBe("Update eligible file");
      await click("Edit");
      expect(button(ignored).getAttribute("aria-checked")).toBe("false");
      expect(button("eligible.ts").getAttribute("aria-checked")).toBe("true");
      await click(action);
      expect(state.commit).toHaveBeenCalledWith({
        action: "commit",
        featureBranch: action === "Commit on new branch",
        filePaths: ["eligible.ts"],
        commitMessage: "Update eligible file",
      });
    },
  );

  it("preserves typed text, blocks an empty commit and supports reselection and retry", async () => {
    state.files = [file(ignored, 49)];
    render();
    typeMessage("Keep my draft");
    state.generate.mockResolvedValueOnce(
      AsyncResult.success({ message: null, skippedFilePaths: [ignored] }),
    );
    await click("Generate commit message");
    expect(message().value).toBe("Keep my draft");
    expect(element.textContent).toContain("No selected changes remain");
    expect(button("Generate commit message").disabled).toBe(true);
    await click("Commit");
    await click("Commit on new branch");
    expect(state.commit).not.toHaveBeenCalled();
    expect(state.back).not.toHaveBeenCalled();
    await click("Edit");
    await click(ignored);
    expect(element.textContent).not.toContain("Ignored files were excluded");
    expect(button("Generate commit message").disabled).toBe(false);
    state.generate.mockResolvedValueOnce(
      AsyncResult.success({ message: "Now eligible", skippedFilePaths: [] }),
    );
    await click("Generate commit message");
    expect(message().value).toBe("Now eligible");
    expect(button("Commit").disabled).toBe(false);
  });

  it.each(["message", "selection", "environment", "project", "thread", "status"])(
    "ignores a response after changing %s",
    async (change) => {
      typeMessage("Draft");
      const finish = pendingGeneration();
      await click("Generate commit message");
      if (change === "message") typeMessage("Edited while waiting");
      if (change === "selection") {
        await click("Edit");
        await click("eligible.ts");
      }
      if (change === "environment") state.environment = "other-environment";
      if (change === "project") state.cwd = "/other-repo";
      if (change === "thread") state.thread = "other-thread";
      if (change === "status") state.version++;
      render();
      await finish("Stale generated text");
      expect(message().value).not.toBe("Stale generated text");
      expect(element.textContent).not.toContain("Ignored files were excluded");
      expect(button("Generate commit message").disabled).toBe(false);
    },
  );

  it("restores controls after failure and retries with the remaining selection", async () => {
    await click("Generate commit message");
    state.generate.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("index is locked"))),
    );
    await click("Generate commit message");
    expect(state.generate.mock.calls[1]?.[0].input.filePaths).toEqual(["eligible.ts"]);
    expect(element.textContent).toContain("index is locked");
    expect(button("Commit").disabled).toBe(false);
    expect(button("Generate commit message").disabled).toBe(false);
    state.generate.mockResolvedValueOnce(
      AsyncResult.success({ message: "Retry succeeded", skippedFilePaths: [] }),
    );
    await click("Generate commit message");
    expect(message().value).toBe("Retry succeeded");
    expect(element.textContent).not.toContain("index is locked");
  });

  it("does not carry skipped-file exclusions into another project", async () => {
    await click("Generate commit message");
    state.cwd = "/another-project";
    render();
    expect(element.textContent).not.toContain("Ignored files were excluded");
    await click("Generate commit message");
    expect(state.generate.mock.calls[1]?.[0].input.filePaths).toEqual(["eligible.ts", ignored]);
  });
});
