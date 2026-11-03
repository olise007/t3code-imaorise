// @vitest-environment jsdom
import { act, type ReactNode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
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
  drafts: new Map<unknown, string>(),
  scopes: new Set<string>(),
  primaryScopes: new Set<string>(),
  shell: null as { id: string; projectId: string; branch: string } | null,
  detail: null as { id: string; projectId: string; branch: string } | null,
  draft: null as {
    id: string;
    projectId: string;
    branch: string;
    worktreePath: null;
    envMode: "local";
  } | null,
  branch: "main",
  metadataRequests: [] as { environmentId: string; branch: string }[],
  afterGitAction: undefined as (() => void) | undefined,
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
      ? state.scopes.has(AuthSourceControlWriteScope)
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
  useThreadShell: () => state.shell,
  useThreadProjection: () => (state.detail ? { projection: { thread: state.detail } } : null),
}));
vi.mock("~/state/session", () => ({
  useEnvironmentScope: (environment: unknown, scope: string) =>
    (environment === "environment" ? state.scopes : state.primaryScopes).has(scope),
  readEnvironmentScope: (environment: unknown, scope: string) =>
    (environment === "environment" ? state.scopes : state.primaryScopes).has(scope),
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
  threadEnvironment: {
    updateMetadata: async ({
      environmentId,
      input,
    }: {
      environmentId: string;
      input: { branch: string };
    }) => {
      state.metadataRequests.push({ environmentId, branch: input.branch });
      if (!state.scopes.has(AuthOrchestrationOperateScope))
        return AsyncResult.failure(Cause.fail(new Error("Task denied")));
      if (state.shell) state.shell.branch = input.branch;
      if (state.detail) state.detail.branch = input.branch;
      return AsyncResult.success(undefined);
    },
  },
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
            refName: state.branch,
            isDefaultRef: state.isDefaultRef,
            hasPrimaryRemote: true,
            hasWorkingTreeChanges: true,
            workingTree: { files: state.files },
          },
        },
}));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: (select: (store: unknown) => unknown) =>
    select({
      getDraftSession: () => state.draft,
      getDraftThreadByRef: () => state.draft,
      setDraftThreadContext: (_target: unknown, input: { branch: string }) => {
        if (state.draft) state.draft.branch = input.branch;
      },
    }),
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
  state.scopes = new Set([AuthSourceControlWriteScope]);
  state.primaryScopes = new Set([AuthSourceControlWriteScope, AuthOrchestrationOperateScope]);
  state.shell = { id: "thread", projectId: "project", branch: "main" };
  state.detail = null;
  state.draft = null;
  state.branch = "main";
  state.metadataRequests = [];
  state.afterGitAction = undefined;
  state.environment = "environment";
  state.thread = "thread";
  state.project = "project";
  state.cwd = "/repo";
  state.version = 1;
  state.files = [file("file.ts", 1)];
  state.generate
    .mockReset()
    .mockResolvedValue(
      AsyncResult.success({ message: "Update eligible file", skippedFilePaths: [] }),
    );
  state.commit.mockReset().mockImplementation(async ({ featureBranch }) => {
    if (featureBranch) state.branch = "feature";
    state.afterGitAction?.();
    return AsyncResult.success({
      branch: featureBranch
        ? { status: "created", name: "feature" }
        : { status: "skipped_not_requested" },
      toast: { title: "Committed", description: "Committed", cta: { kind: "none" } },
    });
  });
  element = document.createElement("div");
  root = createRoot(element);
  render();
});
afterEach(() => act(() => root.unmount()));

const openReview = async () => {
  await act(async () => button("Commit", element).click());
};
const commitOnNewBranch = async () => {
  await openReview();
  typeMessage("Reviewed change");
  await click("Commit on new branch");
};

describe("Git actions while thread details load", () => {
  it("prepares review before enabling generation and blocks a blank message", async () => {
    await openReview();
    expect(button("Generate commit message").disabled).toBe(false);
    expect(button("Commit").disabled).toBe(true);
    expect(button("Commit on new branch").disabled).toBe(true);
    await click("Generate commit message");
    expect(state.generate).toHaveBeenCalledTimes(1);
    expect(state.generate.mock.calls[0]?.[0].input.commitContext).toMatchObject({
      cwd: "/repo",
      threadId: "thread",
      projectId: "project",
    });
    expect(state.commit).not.toHaveBeenCalled();
  });
  it("does not create a feature branch without task permission", async () => {
    await commitOnNewBranch();
    expect(state.commit).not.toHaveBeenCalled();
    expect(state.branch).toBe("main");
  });
  it("commits and synchronizes the server thread before details finish loading", async () => {
    state.primaryScopes.clear();
    state.scopes.add(AuthOrchestrationOperateScope);
    render();
    await commitOnNewBranch();
    expect(state.branch).toBe("feature");
    expect(state.commit).toHaveBeenCalledTimes(1);
    expect(state.shell?.branch).toBe("feature");
    expect(state.metadataRequests).toEqual([{ environmentId: "environment", branch: "feature" }]);
  });
  it("synchronizes archived thread detail after its shell disappears", async () => {
    state.scopes.add(AuthOrchestrationOperateScope);
    state.detail = { id: "thread", projectId: "project", branch: "main" };
    render();
    await openReview();
    typeMessage("Reviewed change");
    state.shell = null;
    render();
    await click("Commit on new branch");
    expect(state.commit).toHaveBeenCalledTimes(1);
    expect(state.detail.branch).toBe("feature");
    expect(state.metadataRequests).toEqual([{ environmentId: "environment", branch: "feature" }]);
  });
  it("requires task permission to change an archived thread's branch", async () => {
    state.shell = null;
    state.detail = { id: "thread", projectId: "project", branch: "main" };
    render();
    await commitOnNewBranch();
    expect(state.commit).not.toHaveBeenCalled();
    expect(state.detail.branch).toBe("main");
    expect(state.metadataRequests).toEqual([]);
  });
  it("uses the shell branch when cached detail already names the feature branch", async () => {
    state.scopes.add(AuthOrchestrationOperateScope);
    state.detail = { id: "thread", projectId: "project", branch: "feature" };
    render();
    await commitOnNewBranch();
    expect(state.commit).toHaveBeenCalledTimes(1);
    expect(state.shell?.branch).toBe("feature");
    expect(state.metadataRequests).toEqual([{ environmentId: "environment", branch: "feature" }]);
  });
  it("enables a retained branch button after the thread grant is gained", async () => {
    await openReview();
    typeMessage("Reviewed change");
    const retained = button("Commit on new branch");
    expect(retained.disabled).toBe(true);
    state.scopes.add(AuthOrchestrationOperateScope);
    render();
    await act(async () => retained.click());
    expect(state.commit).toHaveBeenCalledTimes(1);
    expect(state.shell?.branch).toBe("feature");
  });
  it.each([
    [AuthOrchestrationOperateScope, false],
    [AuthSourceControlWriteScope, true],
  ] as const)("uses fresh permission after Git finishes when revoking %s", async (scope, syncs) => {
    state.scopes.add(AuthOrchestrationOperateScope);
    state.afterGitAction = () => {
      state.scopes.delete(scope);
    };
    render();
    await commitOnNewBranch();
    expect(state.commit).toHaveBeenCalledTimes(1);
    expect(state.branch).toBe("feature");
    expect(state.shell?.branch).toBe(syncs ? "feature" : "main");
    expect(state.metadataRequests).toHaveLength(syncs ? 1 : 0);
  });
  it("keeps ordinary reviewed commits available while details load", async () => {
    await openReview();
    typeMessage("Reviewed change");
    await click("Commit");
    expect(state.commit).toHaveBeenCalledTimes(1);
    expect(state.branch).toBe("main");
  });
  it("keeps reviewed feature-branch commits available for a local draft", async () => {
    state.shell = null;
    state.draft = {
      id: "draft",
      projectId: "project",
      branch: "main",
      worktreePath: null,
      envMode: "local",
    };
    render();
    await commitOnNewBranch();
    expect(state.commit).toHaveBeenCalledTimes(1);
    expect(state.draft.branch).toBe("feature");
    expect(state.metadataRequests).toEqual([]);
  });
});
