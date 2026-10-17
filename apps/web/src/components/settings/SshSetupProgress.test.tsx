// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { SshSetupProgress } from "./SshSetupProgress";
import { sshSetupProgress } from "../../connection/sshSetupProgress";
import { cancelSshEnvironmentSetup } from "../../connection/onboarding";

vi.mock("../../connection/onboarding", () => ({
  cancelSshEnvironmentSetup: vi.fn().mockResolvedValue(undefined),
}));

it("keeps one live attempt through refreshes and navigation, retaining scroll and sanitized copying", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const clipboard = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboard },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root = createRoot(container);
  const target = { alias: "rendered-fixture", hostname: "192.0.2.5", port: 2222, username: "user" };
  const id = sshSetupProgress.begin(target);
  sshSetupProgress.append(id, "Authenticating SSH");
  try {
    await act(async () => {
      root.render(<SshSetupProgress />);
    });
    const button = (label: string) =>
      Array.from(container.querySelectorAll("button")).find((node) => node.textContent === label)!;
    await act(async () => {
      button("View progress").click();
    });
    const details = container.querySelector("details")!;
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    const pre = container.querySelector("pre")!;
    Object.defineProperties(pre, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
    });
    pre.scrollTop = 40;
    await act(async () => {
      pre.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await act(async () => {
      for (let index = 0; index < 5; index++)
        sshSetupProgress.append(id, `Details: Installing fixture ${index}`);
      sshSetupProgress.append(
        id,
        "password=fixture-secret https://auth.openai.com/oauth?code=fixture-code",
      );
      vi.advanceTimersByTime(100);
    });
    expect(pre.scrollTop).toBe(40);
    expect(container.querySelectorAll("button").length).toBe(3);
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await act(async () => {
      root.render(<SshSetupProgress />);
    });
    expect(button("Hide progress")).toBeDefined();
    expect(container.querySelector("details")?.open).toBe(true);
    expect(container.querySelector("pre")?.scrollTop).toBe(40);
    await act(async () => {
      button("Copy details").click();
    });
    expect(clipboard.mock.calls[0]?.[0]).toContain("Installing fixture 4");
    expect(clipboard.mock.calls[0]?.[0]).not.toMatch(/fixture-secret|fixture-code|auth.openai.com/);
    await act(async () => {
      button("Cancel setup").click();
    });
    expect(cancelSshEnvironmentSetup).toHaveBeenCalledWith(target, id);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    sshSetupProgress.finish(id, "cancelled");
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it("removes expanded details after connection removal and dismisses unregistered failures", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const target = { alias: "removed-connection", hostname: "192.0.2.8", port: 22, username: "user" };
  const id = sshSetupProgress.begin(target);
  sshSetupProgress.associateEnvironment(id, "removed-environment");
  sshSetupProgress.append(id, "Removed environment detail");
  sshSetupProgress.finish(id, "succeeded");
  const failed = sshSetupProgress.begin({ ...target, alias: "unregistered-failure" });
  sshSetupProgress.finish(failed, "failed");
  try {
    await act(async () => root.render(<SshSetupProgress />));
    const section = Array.from(container.querySelectorAll("p")).find((p) =>
      p.textContent?.includes("removed-connection"),
    )!.parentElement!.parentElement!;
    await act(async () => {
      Array.from(section.querySelectorAll("button"))
        .find((b) => b.textContent === "View progress")!
        .click();
    });
    expect(section.textContent).toContain("Removed environment detail");
    await act(async () => {
      sshSetupProgress.forgetEnvironment("removed-environment", [target]);
      vi.advanceTimersByTime(100);
    });
    expect(container.textContent).not.toContain("removed-connection");
    expect(container.textContent).not.toContain("Removed environment detail");
    expect(container.textContent).toContain("unregistered-failure");
    const failedRow = Array.from(container.querySelectorAll("p")).find((p) =>
      p.textContent?.includes("unregistered-failure"),
    )!.parentElement!.parentElement!;
    await act(async () => {
      Array.from(failedRow.querySelectorAll("button"))
        .find((b) => b.textContent === "Dismiss")!
        .click();
      vi.advanceTimersByTime(100);
    });
    expect(container.textContent).not.toContain("unregistered-failure");
    await act(async () => root.render(<SshSetupProgress />));
    expect(container.textContent).not.toContain("Removed environment detail");
  } finally {
    await act(async () => root.unmount());
    sshSetupProgress.dismiss(id);
    sshSetupProgress.dismiss(failed);
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
