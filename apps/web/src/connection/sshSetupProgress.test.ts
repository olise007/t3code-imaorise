import { afterEach, expect, it, vi } from "vite-plus/test";
import { createSshSetupProgress } from "./sshSetupProgress";
const target = { alias: "fixture", hostname: "fixture", port: 22, username: "user" };
afterEach(() => vi.useRealTimers());

it("keeps independent attempts across subscribers and batches updates", () => {
  vi.useFakeTimers();
  const store = createSshSetupProgress();
  const listener = vi.fn();
  const unsubscribe = store.subscribe(listener);
  const a = store.begin(target);
  const b = store.begin({ ...target, executionSource: { type: "wsl", distro: "Ubuntu" } });
  store.append(a, "Authentication");
  store.append(b, "Inspection");
  expect(listener).not.toHaveBeenCalled();
  vi.advanceTimersByTime(100);
  expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();
  store.finish(a, "succeeded");
  expect(store.snapshot().find((item) => item.id === b)?.status).toBe("running");
  const reopened = vi.fn();
  store.subscribe(reopened);
  expect(store.snapshot().find((item) => item.id === a)?.lines[0]?.text).toBe("Authentication");
});

it("retains active work and only ten completed attempts with bounded, sanitized details", () => {
  vi.useFakeTimers();
  const store = createSshSetupProgress();
  const active = store.begin(target);
  for (let index = 0; index < 12; index++) {
    const id = store.begin(target);
    store.finish(id, "failed");
  }
  expect(store.snapshot()).toHaveLength(11);
  for (let index = 0; index < 2100; index++) store.append(active, `line ${index}`);
  store.append(active, "password=hidden https://auth.openai.com/oauth?code=private");
  const item = store.snapshot().find((attempt) => attempt.id === active)!;
  expect(item.truncated).toBe(true);
  expect(item.lines).toHaveLength(2000);
  expect(item.lines.at(-1)?.text).not.toMatch(/hidden|private|auth.openai/);
});

it("forgets removed environment attempts without erasing another source or accepting late output", () => {
  vi.useFakeTimers();
  const store = createSshSetupProgress();
  const local = store.begin(target);
  const wsl = store.begin({ ...target, executionSource: { type: "wsl", distro: "Ubuntu" } });
  store.associateEnvironment(local, "removed");
  store.append(local, "Private connection details");
  store.finish(local, "succeeded");
  store.forgetEnvironment("removed", [target]);
  store.append(local, "Late progress");
  store.finish(local, "failed");
  expect(store.snapshot().map((attempt) => attempt.id)).toEqual([wsl]);
  store.dismiss(wsl);
  expect(store.snapshot()).toHaveLength(1);
  store.finish(wsl, "failed");
  store.dismiss(wsl);
  expect(store.snapshot()).toEqual([]);
});
