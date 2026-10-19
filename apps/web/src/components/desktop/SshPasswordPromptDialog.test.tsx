// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import type { DesktopSshPasswordPromptRequest, DesktopBridge } from "@t3tools/contracts";
import { SshPasswordPromptDialog } from "./SshPasswordPromptDialog";

let listener: (request: DesktopSshPasswordPromptRequest) => void;
let root: Root;
let container: HTMLDivElement;
const resolvePassword = vi.fn().mockResolvedValue(undefined);
const unsubscribe = vi.fn();
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
  resolvePassword.mockClear();
  unsubscribe.mockClear();
  window.desktopBridge = {
    onSshPasswordPrompt: (callback: typeof listener) => {
      listener = callback;
      return unsubscribe;
    },
    resolveSshPasswordPrompt: resolvePassword,
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
const present = async (requestId: string) =>
  act(async () =>
    listener({
      requestId,
      destination: "fixture",
      username: "dev",
      prompt: "Enter the SSH password",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
it("queues upstream authentication prompts and cancels only the current request", async () => {
  await present("first");
  await present("second");
  expect(document.querySelectorAll('input[name="ssh-password"]')).toHaveLength(1);
  const cancel = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Cancel",
  )!;
  await act(async () => cancel.click());
  expect(resolvePassword).toHaveBeenCalledWith("first", null);
  expect(document.querySelectorAll('input[name="ssh-password"]')).toHaveLength(1);
  const next = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === "Cancel",
  )!;
  await act(async () => next.click());
  expect(resolvePassword).toHaveBeenLastCalledWith("second", null);
  expect(document.querySelector('input[name="ssh-password"]')).toBeNull();
});
it("cleans up authentication subscriptions when the client unmounts", async () => {
  await act(async () => root.render(null));
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});
