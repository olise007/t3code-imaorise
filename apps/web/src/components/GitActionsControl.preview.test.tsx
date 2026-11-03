// @vitest-environment jsdom
import { act, type ReactNode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
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
  prepare: vi.fn(),
  drafts: new Map<unknown, string>(),
  supported: true,
  isDefaultRef: false,
  commit: vi.fn(),
}));
function Box({ children }: { children?: ReactNode }) {
  return <div>{children}</div>;
}
function Button({ children, onClick, disabled, "aria-label": label }: ComponentProps<"button">) {
  return (
    <button onClick={onClick} disabled={disabled} aria-label={label}>
      {children}
    </button>
  );
}
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) => state.drafts.get(atom) ?? "",
    set: (atom: unknown, value: string) => state.drafts.set(atom, value),
  },
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: (_registry: unknown, command: (input: unknown) => unknown, input: unknown) =>
    command(input),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "permission"
      ? true
      : atom === "action"
        ? { isRunning: false }
        : atom === "config"
          ? {
              environment: {
                label: "Reviewed environment",
                capabilities: { gitCommitContext: state.supported },
              },
            }
          : null,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => {} }));
vi.mock("~/state/entities", () => ({
  useThreadShell: () => ({ id: state.thread, branch: "main" }),
  useThreadProjection: () => null,
}));
vi.mock("~/state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("~/state/server", () => ({ serverEnvironment: { configValueAtom: () => "config" } }));
vi.mock("~/state/git", () => ({
  gitEnvironment: {
    prepareCommit: (input: unknown) => state.prepare(input),
    generateCommitMessage: Object.assign((input: unknown) => state.generate(input), {
      permissionAtom: () => "permission",
    }),
  },
}));
vi.mock("~/state/sourceControl", () => ({
  sourceControlEnvironment: { discovery: () => "discovery" },
}));
vi.mock("~/state/vcs", () => ({
  vcsEnvironment: { status: () => "status" },
  vcsActionManager: {
    stateAtom: () => "action",
    runStackedAction: () => (input: unknown) => state.commit(input),
  },
}));
vi.mock("~/state/threads", () => ({
  threadEnvironment: { updateMetadata: async () => AsyncResult.success(undefined) },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: unknown) =>
    query === "discovery"
      ? { data: { sourceControlProviders: [] } }
      : {
          dataUpdatedAt: state.version,
          error: null,
          data: {
            isRepo: true,
            refName: "main",
            isDefaultRef: state.isDefaultRef,
            hasPrimaryRemote: true,
            hasWorkingTreeChanges: true,
            workingTree: { files: state.files },
          },
        },
}));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: unknown) => unknown) =>
    select({ getDraftThreadByRef: () => null, setDraftThreadContext: () => {} }),
}));
vi.mock("~/lib/sourceControlActions", () => ({
  useSourceControlActionRunning: () => false,
  useVcsInitAction: () => ({}),
  useVcsPullAction: () => ({}),
  useSourceControlPublishRepositoryAction: () => ({}),
  useGitStackedAction: () => ({ run: state.commit }),
}));
vi.mock("~/editorPreferences", () => ({ useOpenInPreferredEditor: () => () => {} }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => () => {} }));
vi.mock("~/lib/openPullRequestLink", () => ({ useOpenPrLink: () => () => {} }));
vi.mock("~/lib/utils", () => ({ cn: () => "", randomUUID: () => "action" }));
vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (input: unknown) => input,
  toastManager: { add: () => "toast", update: () => {}, close: () => {} },
}));
vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <section role="dialog">{children}</section> : null,
  DialogPopup: Box,
  DialogHeader: Box,
  DialogTitle: Box,
  DialogDescription: Box,
  DialogPanel: Box,
  DialogFooter: Box,
}));
vi.mock("~/components/ui/menu", () => ({
  Menu: Box,
  MenuItem: Button,
  MenuItemLabel: Box,
  MenuPopup: Box,
  MenuTrigger: Box,
  MenuSub: Box,
  MenuSubTrigger: Box,
  MenuSubPopup: Box,
}));
vi.mock("~/components/ui/group", () => ({ Group: Box, GroupSeparator: () => null }));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: Box,
  TooltipTrigger: Box,
  TooltipPopup: () => null,
}));
vi.mock("~/components/ui/popover", () => ({
  Popover: Box,
  PopoverTrigger: Box,
  PopoverPopup: () => null,
}));
vi.mock("~/components/ui/button", () => ({ Button }));
vi.mock("~/components/ui/checkbox", () => ({
  Checkbox: ({ checked, onCheckedChange }: { checked: boolean; onCheckedChange: () => void }) => (
    <input type="checkbox" checked={checked} onChange={onCheckedChange} />
  ),
}));
vi.mock("~/components/ui/textarea", () => ({
  Textarea: ({ value, onChange, onKeyDown }: ComponentProps<"textarea">) => (
    <textarea aria-label="Commit message" value={value} onChange={onChange} onKeyDown={onKeyDown} />
  ),
}));
vi.mock("~/components/ui/scroll-area", () => ({ ScrollArea: Box }));
vi.mock("./StartTruncatedPath", () => ({
  StartTruncatedPath: ({ path }: { path: string }) => <span>{path}</span>,
}));

import GitActionsControl from "./GitActionsControl";

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
      <GitActionsControl
        presentation="menu"
        gitCwd={state.cwd}
        activeThreadRef={{
          environmentId: EnvironmentId.make(state.environment),
          threadId: ThreadId.make(state.thread),
        }}
      />,
    ),
  );
const dialog = () => element.querySelector<HTMLElement>('[role="dialog"]')!;
function button(label: string, scope: ParentNode = dialog() ?? element) {
  const found = Array.from(scope.querySelectorAll("button")).find(
    (entry) => entry.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
const click = async (label: string) => {
  await act(async () => button(label).click());
};
const message = () => dialog().querySelector("textarea")!;
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
  state.isDefaultRef = false;
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
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
      },
      skippedFilePaths: [],
    }),
  );
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
  state.commit.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      branch: { status: "skipped_not_requested" },
      toast: { title: "Committed", description: "Committed", cta: { kind: "none" } },
    },
  });
  element = document.createElement("div");
  root = createRoot(element);
  render();
  await act(async () => button("Commit", element).click());
});
afterEach(() => act(() => root.unmount()));

describe("workspace-bound commit review", () => {
  it.each(["Commit", "Commit on new branch"])(
    "sends the prepared repository and explicit eligible files to %s",
    async (action) => {
      await click("Generate commit message");
      expect(state.generate.mock.calls[0]?.[0].input).toMatchObject({
        commitContext: { cwd: "/repo", filePaths: ["eligible.ts", ignored].sort() },
        filePaths: ["eligible.ts", ignored].sort(),
      });
      expect(dialog().textContent).toContain(ignored);
      expect(message().value).toBe("Update eligible file");
      await click(action);
      expect(state.commit).toHaveBeenCalledWith(
        expect.objectContaining({
          filePaths: ["eligible.ts"],
          commitContext: expect.objectContaining({
            cwd: "/repo",
            environmentId: "environment",
            filePaths: ["eligible.ts"],
          }),
          commitMessage: "Update eligible file",
        }),
      );
    },
  );
  it.each(["environment", "project", "thread"])(
    "closes on %s change and discards a delayed preview while retaining the original draft",
    async (change) => {
      typeMessage("Original draft");
      const finish = pendingGeneration();
      await click("Generate commit message");
      if (change === "environment") state.environment = "other-environment";
      if (change === "project") state.cwd = "/other-repo";
      if (change === "thread") state.thread = "other-thread";
      render();
      await finish("Stale message");
      expect(dialog()).toBeNull();
      expect(state.commit).not.toHaveBeenCalled();
      state.environment = "environment";
      state.cwd = "/repo";
      state.thread = "thread";
      render();
      await act(async () => button("Commit", element).click());
      expect(message().value).toBe("Original draft");
    },
  );
  it("keeps a pending commit bound when navigation occurs during execution", async () => {
    typeMessage("Reviewed A");
    let finish!: (value: unknown) => void;
    state.commit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await click("Commit");
    const submitted = state.commit.mock.calls[0]?.[0];
    expect(submitted.commitContext.cwd).toBe("/repo");
    state.cwd = "/repo-b";
    state.thread = "thread-b";
    render();
    await act(async () => button("Commit", element).click());
    typeMessage("Draft B");
    await act(async () =>
      finish(
        AsyncResult.success({
          branch: { status: "skipped_not_requested" },
          toast: { title: "Committed A", cta: { kind: "none" } },
        }),
      ),
    );
    expect(dialog()).not.toBeNull();
    expect(message().value).toBe("Draft B");
    expect(state.commit).toHaveBeenCalledTimes(1);
  });
  it("cancels a delayed default-branch confirmation when the workspace changes", async () => {
    state.isDefaultRef = true;
    await click("Cancel");
    await act(async () => button("Commit & push", element).click());
    typeMessage("Reviewed A");
    await click("Commit");
    expect(element.querySelectorAll('[role="dialog"]').length).toBe(2);
    state.cwd = "/repo-b";
    render();
    expect(element.querySelectorAll('[role="dialog"]').length).toBe(0);
    expect(state.commit).not.toHaveBeenCalled();
  });
  it("supports keyboard submission using the prepared selection", async () => {
    typeMessage("Keyboard commit");
    await act(async () =>
      message().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
      ),
    );
    expect(state.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        commitContext: expect.objectContaining({ cwd: "/repo" }),
        filePaths: ["eligible.ts", ignored].sort(),
      }),
    );
  });
  it("retains the draft and displays a server workspace mismatch", async () => {
    typeMessage("Keep this message");
    state.commit.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("Workspace changed—review again"))),
    );
    await click("Commit");
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("Workspace changed");
    expect(message().value).toBe("Keep this message");
  });
  it("disables committing with update guidance for unsupported servers", async () => {
    await click("Cancel");
    state.supported = false;
    render();
    await act(async () => button("Commit", element).click());
    typeMessage("Keep draft");
    expect(button("Commit").disabled).toBe(true);
    expect(dialog().textContent).toContain("Update this T3 server");
    expect(state.commit).not.toHaveBeenCalled();
  });
  it("preserves user edits while generation is pending", async () => {
    typeMessage("Draft");
    const finish = pendingGeneration();
    await click("Generate commit message");
    typeMessage("User edit");
    await finish("Stale generated text");
    expect(message().value).toBe("User edit");
  });
  it("warns and blocks commits when no eligible changes remain", async () => {
    state.generate.mockResolvedValueOnce(
      AsyncResult.success({ message: null, skippedFilePaths: ["eligible.ts", ignored] }),
    );
    typeMessage("Keep draft");
    await click("Generate commit message");
    expect(button("Commit").disabled).toBe(true);
    expect(message().value).toBe("Keep draft");
  });
});
