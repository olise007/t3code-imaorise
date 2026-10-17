import { afterEach, expect, it, vi } from "vite-plus/test";
import type { DesktopBridge } from "@t3tools/contracts";
import { runSshServerAction, setSshConnectionEnabled } from "./sshConnectionActions";
import { sshServerLifecycle } from "./sshServerLifecycle";
import { sshSetupOperations } from "./sshSetupOperations";

const target = { alias: "connection-actions", hostname: "192.0.2.88", username: "user", port: 22 };
const environmentId = "connection-actions";
afterEach(() => sshServerLifecycle.forgetEnvironment(environmentId, [target]));

function fixture() {
  let state: "running" | "stopped" = "running";
  const ensure = vi.fn<DesktopBridge["ensureSshEnvironment"]>(async () => {
    state = "running";
    return { target, httpBaseUrl: "http://fixture", wsBaseUrl: "ws://fixture", pairingToken: null };
  });
  const stop = vi.fn(async () => {
    state = "stopped";
  });
  const status = vi.fn(async () => ({ state, environmentId, checkedAt: new Date().toISOString() }));
  return {
    target,
    environmentId,
    label: "Fixture",
    bridge: {
      ensureSshEnvironment: ensure,
      stopSshEnvironment: stop,
      sshServerStatus: status,
      cancelSshSetup: vi.fn().mockResolvedValue(undefined),
    } as unknown as DesktopBridge,
    setEnabled: vi.fn().mockResolvedValue(true),
    confirmStart: vi.fn().mockResolvedValue(true),
    notify: vi.fn(),
    ensure,
    stop,
    status,
    stopped: () => {
      state = "stopped";
    },
  };
}

it("connects through the application runtime without an extra preparation, and disconnect never stops the server", async () => {
  const input = fixture();
  expect(await setSshConnectionEnabled(input, true)).toBe(true);
  expect(input.setEnabled).toHaveBeenCalledWith(true);
  expect(input.ensure).not.toHaveBeenCalled();
  expect(await setSshConnectionEnabled(input, false)).toBe(true);
  expect(input.setEnabled).toHaveBeenLastCalledWith(false);
  expect(input.stop).not.toHaveBeenCalled();
  expect(input.confirmStart).not.toHaveBeenCalled();
});

it("preserves stop intent on Cancel, then resumes exactly once through the same explicit Start service", async () => {
  const input = fixture();
  input.stopped();
  input.confirmStart.mockResolvedValueOnce(false);
  expect(await setSshConnectionEnabled(input, true)).toBe(false);
  expect(sshServerLifecycle.read(target).stopIntent).toBe(true);
  expect(input.setEnabled).not.toHaveBeenCalled();
  expect(input.ensure).not.toHaveBeenCalled();
  expect(await setSshConnectionEnabled(input, true)).toBe(true);
  expect(input.ensure).toHaveBeenCalledTimes(1);
  expect(input.ensure.mock.calls[0]).toMatchObject([
    target,
    { resumeStoppedServer: true, expectedEnvironmentId: environmentId },
  ]);
  expect(input.setEnabled).toHaveBeenCalledTimes(1);
  expect(sshServerLifecycle.read(target).state).toBe("running");
  expect(sshServerLifecycle.read(target).stopIntent).toBe(false);
});

it("does not enable a connection when server verification fails", async () => {
  const input = fixture();
  input.status.mockRejectedValue(
    new Error("Host key verification failed. Authenticate explicitly."),
  );
  expect(await runSshServerAction(input, "start")).toBe(false);
  expect(input.setEnabled).not.toHaveBeenCalled();
  expect(input.notify).not.toHaveBeenCalled();
  expect(sshServerLifecycle.read(target).state).toBe("unknown");
});

it("rejects late switch results while removal awaits cancellation", async () => {
  const input = fixture();
  let finish!: () => void;
  input.status.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () =>
          resolve({ state: "running", environmentId, checkedAt: new Date().toISOString() });
      }),
  );
  const connecting = setSshConnectionEnabled(input, true);
  const remove = vi.fn().mockResolvedValue(true);
  const removal = sshSetupOperations.remove(environmentId, [target], remove);
  expect(remove).not.toHaveBeenCalled();
  finish();
  expect(await connecting).toBe(false);
  await removal;
  expect(input.setEnabled).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledTimes(1);
});

it("coalesces concurrent connects while awaiting Start approval", async () => {
  const input = fixture();
  sshServerLifecycle.observe(target, { state: "stopped", checkedAt: new Date().toISOString() });
  let answer!: (value: boolean) => void;
  input.confirmStart.mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  const first = setSshConnectionEnabled(input, true);
  expect(await setSshConnectionEnabled(input, true)).toBe(false);
  expect(input.confirmStart).toHaveBeenCalledTimes(1);
  answer(true);
  expect(await first).toBe(true);
  expect(input.ensure).toHaveBeenCalledTimes(1);
});
