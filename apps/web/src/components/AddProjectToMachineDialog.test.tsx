// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
const state = vi.hoisted(() => ({ navigate: vi.fn(), prepare: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useParams: () => ({}) }));
vi.mock("../state/entities", () => ({
  useProject: () => ({
    title: "Repo",
    environmentId: "source",
    workspaceRoot: "/repo",
    repositoryIdentity: { rootPath: "/repo", locator: { remoteUrl: "git@example:repo" } },
  }),
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "source",
        label: "Source",
        serverConfig: { environment: { capabilities: {} } },
      },
      { environmentId: "target", label: "Target", serverConfig: null },
    ],
  }),
}));
vi.mock("../hooks/useAddProjectTargets", () => ({
  useAddProjectTargets: () => [{ environmentId: "target", label: "Target", machine: "linux" }],
}));
vi.mock("../hooks/useLogicalProjectEnvironments", () => ({
  useLogicalProjectEnvironments: () => [],
}));
vi.mock("../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => state.navigate }));
vi.mock("../state/query", () => ({ useEnvironmentQuery: () => ({ data: null, error: null }) }));
vi.mock("../state/projects", () => ({ projectEnvironment: {} }));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: { getState: () => ({ getDraftSession: () => null }) },
}));
vi.mock("../lib/addProjectToMachine", async (original) => ({
  ...(await original<typeof import("../lib/addProjectToMachine")>()),
  addProjectToMachine: state.prepare,
}));
import {
  AddProjectToMachineDialogHost,
  openAddProjectToMachine,
} from "./AddProjectToMachineDialog";

it("Cancel aborts pending preparation and a late success cannot navigate", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let finish!: () => void;
  state.prepare.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  try {
    await act(async () => {
      root.render(<AddProjectToMachineDialogHost />);
      openAddProjectToMachine({
        projectRef: {
          environmentId: EnvironmentId.make("source"),
          projectId: ProjectId.make("repo"),
        },
        targetEnvironmentId: EnvironmentId.make("target"),
      });
    });
    const form = document.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    const signal = state.prepare.mock.calls[0]![0].signal as AbortSignal;
    const cancel = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Cancel",
    )!;
    await act(async () => {
      cancel.click();
      expect(signal.aborted).toBe(true);
    });
    await act(async () => {
      finish();
    });
    expect(state.navigate).not.toHaveBeenCalled();
    expect(document.querySelector("form")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    node.remove();
    vi.unstubAllGlobals();
    state.prepare.mockReset();
    state.navigate.mockReset();
  }
});
