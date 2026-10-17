import { expect, it, vi } from "vite-plus/test";
import { createSshSetupOperations } from "./sshSetupOperations";
const target = { alias: "same-host", hostname: "192.0.2.9", username: "user", port: 22 };
it("awaits cancellation before removal and blocks replacement operations only on the same source", async () => {
  const events: string[] = [];
  let release!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const forget = vi.fn();
  const operations = createSshSetupOperations(forget);
  operations.register(target, "first", async () => {
    events.push("cancel");
    await cancelled;
    events.push("cancelled");
  });
  const removal = operations.remove("environment", [target], async () => {
    events.push("removed");
    return true;
  });
  expect(events).toEqual(["cancel"]);
  expect(operations.register(target, "replacement", async () => {})).toBe(false);
  const wsl = { ...target, executionSource: { type: "wsl" as const, distro: "Ubuntu" } };
  expect(operations.register(wsl, "independent", async () => {})).toBe(true);
  release();
  await removal;
  expect(events).toEqual(["cancel", "cancelled", "removed"]);
  expect(forget).toHaveBeenCalledWith("environment", [target]);
  expect(operations.isRemoving(target)).toBe(false);
});
it("keeps details after cancellation or catalog failure and ignores a stale cancellation", async () => {
  const forget = vi.fn();
  const operations = createSshSetupOperations(forget);
  const cancel = vi.fn().mockRejectedValue(new Error("Cancellation not acknowledged"));
  operations.register(target, "current", cancel);
  await operations.cancel(target, "older");
  expect(cancel).not.toHaveBeenCalled();
  const remove = vi.fn().mockResolvedValue(true);
  await expect(operations.remove("environment", [target], remove)).rejects.toThrow(
    "Cancellation not acknowledged",
  );
  expect(remove).not.toHaveBeenCalled();
  expect(forget).not.toHaveBeenCalled();
  operations.end(target, "current");
  await operations.remove("environment", [target], async () => false);
  expect(forget).not.toHaveBeenCalled();
});
