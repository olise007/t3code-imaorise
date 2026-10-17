// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { DesktopBridge } from "@t3tools/contracts";
import { SshServerControls } from "./SshServerControls";
import { sshSetupProgress } from "../../connection/sshSetupProgress";
import { sshSetupOperations } from "../../connection/sshSetupOperations";
import { sshServerLifecycle } from "../../connection/sshServerLifecycle";

it("confirms Stop, shows pending then verified Stopped, survives reopening, and exposes explicit Start", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const target = { alias: "rendered-lifecycle", hostname: "192.0.2.1", username: "user", port: 22 };
  let serverState: "running" | "stopped" = "running";
  let finish!: () => void;
  const stop = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          serverState = "stopped";
          resolve();
        };
      }),
  );
  const start = vi.fn<DesktopBridge["ensureSshEnvironment"]>(async () => {
    serverState = "running";
    return { target, pairingToken: null, httpBaseUrl: "http://fixture", wsBaseUrl: "ws://fixture" };
  });
  const bridge = {
    stopSshEnvironment: stop,
    ensureSshEnvironment: start,
    sshServerStatus: vi.fn(async () => ({
      state: serverState,
      environmentId: "rendered-lifecycle",
      checkedAt: "2026-10-17T12:00:00Z",
    })),
    cancelSshSetup: vi.fn().mockResolvedValue(undefined),
  } as unknown as DesktopBridge;
  const confirmStop = vi.fn().mockResolvedValue(false);
  const setEnabled = vi.fn().mockResolvedValue(true);
  const notify = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root = createRoot(container);
  const render = () =>
    root.render(
      <SshServerControls
        target={target}
        environmentId="rendered-lifecycle"
        label="Fixture"
        bridge={bridge}
        confirmStop={confirmStop}
        setEnabled={setEnabled}
        notify={notify}
      />,
    );
  const button = (label: string) =>
    Array.from(container.querySelectorAll("button")).find((node) => node.textContent === label)!;
  try {
    await act(async () => {
      render();
    });
    expect(container.textContent).toContain("Remote server: Running");
    await act(async () => {
      button("Stop remote server…").click();
    });
    expect(stop).not.toHaveBeenCalled();
    confirmStop.mockResolvedValue(true);
    await act(async () => {
      button("Stop remote server…").click();
    });
    expect(container.textContent).toContain("Remote server: Stopping");
    expect(setEnabled).toHaveBeenCalledWith(false);
    expect((button("Stop remote server…") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      finish();
    });
    expect(container.textContent).toContain("Remote server: Stopped");
    expect(notify).toHaveBeenCalledWith("Remote server stopped on Fixture");
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await act(async () => {
      render();
    });
    expect(container.textContent).toContain("Remote server: Stopped");
    await act(async () => {
      button("Start remote server").click();
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[1]).toMatchObject({ resumeStoppedServer: true });
    expect(setEnabled).toHaveBeenLastCalledWith(true);
    expect(container.textContent).toContain("Remote server: Running");
    expect(container.textContent).not.toContain("Connected");
    stop.mockRejectedValueOnce(new Error("fixture shutdown failed"));
    await act(async () => {
      button("Stop remote server…").click();
    });
    expect(container.textContent).toContain("Status unknown");
    expect(container.textContent).toContain("fixture shutdown failed");
    expect(button("Retry stop")).toBeDefined();
    expect(button("Start remote server")).toBeDefined();
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    sshServerLifecycle.forgetEnvironment("rendered-lifecycle", [target]);
    vi.unstubAllGlobals();
  }
});

it("awaits owned Start cancellation before removal and never enables a removed connection", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const target = {
    alias: "remove-pending-start",
    hostname: "192.0.2.2",
    username: "user",
    port: 22,
  };
  sshServerLifecycle.bind(target, "remove-pending-start");
  sshServerLifecycle.observe(target, { state: "stopped", checkedAt: "2026-10-17T12:00:00Z" });
  let finish!: () => void;
  const start = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = () =>
          resolve({
            target,
            pairingToken: null,
            httpBaseUrl: "http://fixture",
            wsBaseUrl: "ws://fixture",
          });
      }),
  );
  const bridge = {
    ensureSshEnvironment: start,
    cancelSshSetup: vi.fn().mockResolvedValue(undefined),
    sshServerStatus: vi
      .fn()
      .mockResolvedValue({ state: "stopped", checkedAt: "2026-10-17T12:00:00Z" }),
  } as unknown as DesktopBridge;
  const setEnabled = vi.fn().mockResolvedValue(true);
  const remove = vi.fn().mockResolvedValue(true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <SshServerControls
          target={target}
          environmentId="remove-pending-start"
          label="Fixture"
          bridge={bridge}
          setEnabled={setEnabled}
          confirmStop={async () => true}
          notify={() => {}}
        />,
      );
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((node) => node.textContent === "Start remote server")!
        .click();
    });
    expect(start).toHaveBeenCalledTimes(1);
    let removal!: Promise<void>;
    await act(async () => {
      removal = sshSetupOperations.remove("remove-pending-start", [target], remove);
    });
    expect(remove).not.toHaveBeenCalled();
    await act(async () => {
      finish();
      await removal;
    });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(setEnabled).not.toHaveBeenCalled();
    expect(sshServerLifecycle.read(target).stopIntent).toBe(false);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("cancels before mutation when removal arrives during preflight", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const target = { alias: "cancel-preflight", hostname: "192.0.2.3", username: "user", port: 22 };
  sshServerLifecycle.bind(target, "cancel-preflight");
  let finish!: () => void;
  const initialCancellation = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const start = vi.fn();
  const bridge = {
    ensureSshEnvironment: start,
    cancelSshSetup: vi.fn((_target, id) => (id ? Promise.resolve() : initialCancellation)),
    sshServerStatus: vi
      .fn()
      .mockResolvedValue({ state: "stopped", checkedAt: "2026-10-17T12:00:00Z" }),
  } as unknown as DesktopBridge;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <SshServerControls
          target={target}
          environmentId="cancel-preflight"
          label="Fixture"
          bridge={bridge}
          setEnabled={async () => true}
          confirmStop={async () => true}
          notify={() => {}}
        />,
      );
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((node) => node.textContent === "Start remote server")!
        .click();
    });
    let removal!: Promise<void>;
    await act(async () => {
      removal = sshSetupOperations.remove("cancel-preflight", [target], async () => true);
    });
    await act(async () => {
      finish();
      await removal;
    });
    expect(start).not.toHaveBeenCalled();
    expect(sshSetupProgress.runningOperation(target)).toBeUndefined();
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  }
});

it.each(["cancellation failure", "disable failure"])(
  "finishes progress when preflight reports %s",
  async (failure) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const target = { alias: failure, hostname: "192.0.2.4", username: "user", port: 22 };
    const stop = vi.fn();
    const bridge = {
      stopSshEnvironment: stop,
      cancelSshSetup:
        failure === "cancellation failure"
          ? vi.fn().mockRejectedValue(new Error("fixture cancellation failure"))
          : vi.fn().mockResolvedValue(undefined),
      sshServerStatus: vi.fn().mockResolvedValue({
        state: "running",
        environmentId: failure,
        checkedAt: "2026-10-17T12:00:00Z",
      }),
    } as unknown as DesktopBridge;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <SshServerControls
            target={target}
            environmentId={failure}
            label="Fixture"
            bridge={bridge}
            setEnabled={async () => false}
            confirmStop={async () => true}
            notify={() => {}}
          />,
        );
      });
      await act(async () => {
        Array.from(container.querySelectorAll("button"))
          .find((node) => node.textContent === "Stop remote server…")!
          .click();
      });
      expect(stop).not.toHaveBeenCalled();
      expect(sshSetupProgress.runningOperation(target)).toBeUndefined();
      expect(container.textContent).toContain("Status unknown");
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      sshServerLifecycle.forgetEnvironment(failure, [target]);
      vi.unstubAllGlobals();
    }
  },
);

it("coalesces repeated Stop confirmations without cancelling the first stop", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const target = { alias: "repeat-stop", hostname: "192.0.2.5", username: "user", port: 22 };
  let state = "running";
  let finish!: () => void;
  const confirms: (() => void)[] = [];
  const confirm = () =>
    new Promise<boolean>((resolve) => {
      confirms.push(() => resolve(true));
    });
  const stop = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          state = "stopped";
          resolve();
        };
      }),
  );
  const cancel = vi.fn().mockResolvedValue(undefined);
  const bridge = {
    stopSshEnvironment: stop,
    cancelSshSetup: cancel,
    sshServerStatus: vi.fn(async () => ({
      state,
      environmentId: "repeat-stop",
      checkedAt: "2026-10-17T12:00:00Z",
    })),
  } as unknown as DesktopBridge;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <SshServerControls
          target={target}
          environmentId="repeat-stop"
          label="Fixture"
          bridge={bridge}
          setEnabled={async () => true}
          confirmStop={confirm}
          notify={() => {}}
        />,
      );
    });
    const button = Array.from(container.querySelectorAll("button")).find(
      (node) => node.textContent === "Stop remote server…",
    )!;
    await act(async () => {
      button.click();
      button.click();
    });
    expect(confirms).toHaveLength(2);
    await act(async () => {
      confirms[0]!();
    });
    expect(stop).toHaveBeenCalledTimes(1);
    await act(async () => {
      confirms[1]!();
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
    });
    expect(container.textContent).toContain("Remote server: Stopped");
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    sshServerLifecycle.forgetEnvironment("repeat-stop", [target]);
    vi.unstubAllGlobals();
  }
});
