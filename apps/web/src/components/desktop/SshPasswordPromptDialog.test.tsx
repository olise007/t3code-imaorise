// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import type {
  DesktopSshPasswordPromptRequest,
  DesktopBridge,
  SshSetupReview,
} from "@t3tools/contracts";
import { SshPasswordPromptDialog } from "./SshPasswordPromptDialog";

let listener: (request: DesktopSshPasswordPromptRequest) => void;
let root: Root;
let container: HTMLDivElement;
const resolveReview = vi.fn().mockResolvedValue(undefined);
const resolvePassword = vi.fn().mockResolvedValue(undefined);
const unsubscribe = vi.fn();
const report: SshSetupReview = {
  reviewId: "review-1",
  destination: "fixture",
  source: "wsl:Ubuntu:fixture",
  remoteIdentity: "machine:user",
  platform: "linux",
  architecture: "x86_64",
  distribution: "ubuntu",
  packageManager: "apt",
  elevation: "sudo",
  requirements: {
    schemaVersion: 1,
    runtimeVersion: "test",
    platform: "linux",
    architecture: "x64",
    nodeVersion: "26.8.2",
    minimumGlibc: "2.28",
    minimumGlibcxx: "3.4.25",
    minimumKernel: "4.18",
    libraries: ["libatomic.so.1"],
  },
  items: [
    {
      id: "atomic",
      label: "libatomic.so.1",
      installed: false,
      required: true,
      version: null,
      packages: ["libatomic1"],
      guidance: "Install libatomic1",
    },
  ],
  commands: ["sudo apt-get install -y libatomic1"],
  blockers: [],
  providers: [
    {
      driver: "codex",
      label: "Codex",
      version: "0.156.1",
      source: "github.com/openai/codex",
      command: "Install verified Codex 0.156.1",
      available: true,
      installed: false,
      reason: "Sign in separately",
      dependencies: [],
    },
    {
      driver: "muse",
      label: "Muse",
      version: null,
      source: "vendor",
      command: "",
      available: false,
      installed: false,
      reason: "Manual setup required",
      dependencies: [],
    },
  ],
};
beforeEach(async () => {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  resolveReview.mockClear();
  resolvePassword.mockClear();
  unsubscribe.mockClear();
  window.desktopBridge = {
    onSshPasswordPrompt: (callback: (request: DesktopSshPasswordPromptRequest) => void) => {
      listener = callback;
      return unsubscribe;
    },
    resolveSshPasswordPrompt: resolvePassword,
    resolveSshSetupReview: resolveReview,
  } as unknown as DesktopBridge;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<SshPasswordPromptDialog />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.desktopBridge;
  vi.unstubAllGlobals();
});
const present = async (review = report) => {
  await act(async () =>
    listener({
      requestId: "prompt-1",
      destination: "fixture",
      username: null,
      prompt: "Review",
      expiresAt: new Date(Date.now() + 180000).toISOString(),
      purpose: "setup-review",
      setupReview: review,
    }),
  );
};
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === label,
  )!;
it("requires explicit approval and submits only selected available providers", async () => {
  await present();
  expect(document.body.textContent).toContain("libatomic.so.1");
  expect(document.body.textContent).toContain("sudo apt-get install");
  expect(resolveReview).not.toHaveBeenCalled();
  const boxes = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  expect(boxes[1]!.disabled).toBe(true);
  await act(async () => boxes[0]!.click());
  expect(document.body.textContent).toContain("Install verified Codex 0.156.1");
  await act(async () => button("Approve and continue").click());
  expect(resolveReview).toHaveBeenCalledWith("prompt-1", {
    reviewId: "review-1",
    approved: true,
    providers: ["codex"],
  });
  expect(resolvePassword).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("Review remote setup");
});
it("prevents approval of unsupported hosts and cancels through the review channel", async () => {
  await present({ ...report, blockers: ["glibc is incompatible"] });
  expect(button("Approve and continue").disabled).toBe(true);
  await act(async () => button("Cancel").click());
  expect(resolveReview).toHaveBeenCalledWith("prompt-1", null);
  expect(resolvePassword).not.toHaveBeenCalled();
});
it("cleans the request subscription when the client unmounts", async () => {
  await act(async () => root.unmount());
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});
