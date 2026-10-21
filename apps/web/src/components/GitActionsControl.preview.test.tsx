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
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "permission" ? true : atom === "action" ? { isRunning: false } : null,
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
vi.mock("~/state/server", () => ({ serverEnvironment: { configValueAtom: () => null } }));
vi.mock("~/state/git", () => ({
  gitEnvironment: {
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
  vcsActionManager: { stateAtom: () => "action" },
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
            isDefaultRef: false,
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
  Textarea: ({ value, onChange }: ComponentProps<"textarea">) => (
    <textarea aria-label="Commit message" value={value} onChange={onChange} />
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
  act(() => button("Commit", element).click());
});
afterEach(() => act(() => root.unmount()));

describe("commit message preview interactions", () => {
  it.each(["Commit", "Commit on new branch"])(
    "warns, updates totals, retries and sends only eligible files to %s",
    async (action) => {
      await click("Generate commit message");
      expect(state.generate.mock.calls[0]?.[0].input).toMatchObject({
        skipIgnoredFiles: true,
        filePaths: ["eligible.ts", ignored],
      });
      expect(dialog().querySelector('[role="status"]')?.textContent).toContain(ignored);
      expect(dialog().textContent).toContain("(1 of 2)");
      expect(dialog().textContent).not.toContain("+53");
      expect(message().value).toBe("Update eligible file");
      state.generate.mockResolvedValueOnce(
        AsyncResult.success({ message: "Update eligible file", skippedFilePaths: [] }),
      );
      await click("Generate commit message");
      expect(state.generate.mock.calls[1]?.[0].input.filePaths).toEqual(["eligible.ts"]);
      expect(dialog().querySelector('[role="status"]')?.textContent).toContain(ignored);
      await click(action);
      expect(state.commit).toHaveBeenCalledWith(
        expect.objectContaining({
          filePaths: ["eligible.ts"],
          commitMessage: "Update eligible file",
          ...(action === "Commit on new branch" ? { featureBranch: true } : {}),
        }),
      );
    },
  );

  it("preserves typed text and prevents both commit actions when all files are skipped", async () => {
    state.files = [file(ignored, 49)];
    render();
    typeMessage("Keep my draft");
    state.generate.mockResolvedValueOnce(
      AsyncResult.success({ message: null, skippedFilePaths: [ignored] }),
    );
    await click("Generate commit message");
    expect(message().value).toBe("Keep my draft");
    expect(dialog().textContent).toContain("No selected changes remain");
    expect(button("Generate commit message").disabled).toBe(true);
    await click("Commit");
    await click("Commit on new branch");
    expect(state.commit).not.toHaveBeenCalled();
  });

  it.each(["message", "selection", "environment", "project", "thread", "status", "reopen"])(
    "ignores stale warnings and text after changing %s",
    async (change) => {
      typeMessage("Draft");
      const finish = pendingGeneration();
      await click("Generate commit message");
      if (change === "message") typeMessage("Edited while waiting");
      if (change === "selection") {
        await click("Edit");
        act(() =>
          dialog().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.click(),
        );
      }
      if (change === "environment") state.environment = "other-environment";
      if (change === "project") state.cwd = "/other-repo";
      if (change === "thread") state.thread = "other-thread";
      if (change === "status") state.version++;
      if (change === "reopen") {
        await click("Cancel");
        act(() => button("Commit", element).click());
      }
      render();
      await finish("Stale generated text");
      expect(message().value).not.toBe("Stale generated text");
      expect(dialog().textContent).not.toContain("Ignored files were excluded");
      expect(button("Generate commit message").disabled).toBe(false);
    },
  );

  it("restores controls after failure and allows a successful retry", async () => {
    typeMessage("Draft");
    state.generate.mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new Error("index is locked"))),
    );
    await click("Generate commit message");
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain("index is locked");
    expect(message().value).toBe("Draft");
    expect(button("Generate commit message").disabled).toBe(false);
    expect(button("Commit").disabled).toBe(false);
    await click("Generate commit message");
    expect(message().value).toBe("Update eligible file");
    expect(dialog().querySelector('[role="alert"]')).toBeNull();
  });

  it("blocks a no-change preview even when the status still lists eligible files", async () => {
    typeMessage("Draft");
    state.generate.mockResolvedValueOnce(
      AsyncResult.success({ message: null, skippedFilePaths: [] }),
    );
    await click("Generate commit message");
    expect(message().value).toBe("Draft");
    expect(button("Commit").disabled).toBe(true);
    expect(button("Commit on new branch").disabled).toBe(true);
    state.version++;
    render();
    expect(button("Commit").disabled).toBe(false);
  });

  it("does not carry skipped-file exclusions into another project", async () => {
    await click("Generate commit message");
    state.cwd = "/another-project";
    render();
    expect(dialog().textContent).not.toContain("Ignored files were excluded");
    expect(dialog().textContent).not.toContain("(1 of 2)");
    await click("Generate commit message");
    expect(state.generate.mock.calls[1]?.[0].input.filePaths).toEqual(["eligible.ts", ignored]);
  });
});
