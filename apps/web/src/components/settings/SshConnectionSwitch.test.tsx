// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { DesktopBridge } from "@t3tools/contracts";
import { SshConnectionSwitch } from "./SshConnectionSwitch";
import { SshServerControls } from "./SshServerControls";
import { setSshConnectionEnabled } from "../../connection/sshConnectionActions";
import { sshServerLifecycle } from "../../connection/sshServerLifecycle";

it("keeps the switch off after Cancel and synchronizes it after either confirmed Start path", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const target = { alias: "switch-render", hostname: "192.0.2.89", username: "user", port: 22 };
  const environmentId = "switch-render";
  let state: "running" | "stopped" = "stopped";
  let confirm!: (value: boolean) => void;
  const ensure = vi.fn(async () => {
    state = "running";
    return { target, httpBaseUrl: "http://fixture", wsBaseUrl: "ws://fixture", pairingToken: null };
  });
  const bridge = {
    ensureSshEnvironment: ensure,
    stopSshEnvironment: vi.fn(async () => {
      state = "stopped";
    }),
    sshServerStatus: vi.fn(async () => ({
      state,
      environmentId,
      checkedAt: new Date().toISOString(),
    })),
    cancelSshSetup: vi.fn().mockResolvedValue(undefined),
  } as unknown as DesktopBridge;
  function Fixture() {
    const [enabled, setEnabled] = useState(false);
    const persist = async (value: boolean) => {
      setEnabled(value);
      return true;
    };
    return (
      <>
        <SshConnectionSwitch
          label="Fixture"
          enabled={enabled}
          disabled={false}
          onChange={(value) =>
            setSshConnectionEnabled(
              {
                target,
                environmentId,
                label: "Fixture",
                bridge,
                setEnabled: persist,
                notify: () => {},
                confirmStart: () =>
                  new Promise((resolve) => {
                    confirm = resolve;
                  }),
              },
              value,
            )
          }
        />
        <SshServerControls
          target={target}
          environmentId={environmentId}
          label="Fixture"
          bridge={bridge}
          setEnabled={persist}
          confirmStop={async () => true}
          notify={() => {}}
        />
      </>
    );
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root = createRoot(container);
  const toggle = () => container.querySelector('[role="switch"]') as HTMLButtonElement;
  try {
    await act(async () => {
      root.render(<Fixture />);
    });
    await act(async () => {
      toggle().click();
    });
    expect(toggle().getAttribute("aria-busy")).toBe("true");
    expect(ensure).not.toHaveBeenCalled();
    await act(async () => {
      confirm(false);
    });
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("Remote server: Stopped");
    await act(async () => {
      toggle().click();
    });
    await act(async () => {
      confirm(true);
    });
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      toggle().click();
    });
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("Remote server: Running");
    expect(bridge.stopSshEnvironment).not.toHaveBeenCalled();
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Stop remote server…")!
        .click();
    });
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await act(async () => {
      root.render(<Fixture />);
    });
    expect(container.textContent).toContain("Remote server: Stopped");
    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Start remote server")!
        .click();
    });
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    expect(ensure).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    sshServerLifecycle.forgetEnvironment(environmentId, [target]);
    vi.unstubAllGlobals();
  }
});
