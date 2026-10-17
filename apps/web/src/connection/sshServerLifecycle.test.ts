import { expect, it } from "vite-plus/test";
import { createSshServerLifecycle } from "./sshServerLifecycle";
const target = { alias: "one", hostname: "192.0.2.1", username: "user", port: 22 };
const stopped = { state: "stopped" as const, checkedAt: "2026-10-17T12:00:00Z" };

it("persists explicit stop independently of connection state and labels reopened observations cached", async () => {
  let saved = "[]";
  const storage = {
    getItem: () => saved,
    setItem: (_key: string, value: string) => {
      saved = value;
    },
  };
  const store = createSshServerLifecycle(storage);
  store.bind(target, "verified-one");
  expect(await store.run(target, "stop", () => Promise.resolve(stopped))).toBe(true);
  const reopened = createSshServerLifecycle(storage);
  expect(reopened.read(target)).toMatchObject({ state: "stopped", stopIntent: true, cached: true });
  reopened.observe(target, { state: "unknown", checkedAt: stopped.checkedAt });
  expect(reopened.read(target)).toMatchObject({
    state: "unknown",
    stopIntent: true,
    cached: false,
  });
});
it("serializes known shared-environment routes, rejects late removed results and isolates other sources", async () => {
  const store = createSshServerLifecycle();
  const alias = { ...target, alias: "two" };
  const wsl = { ...target, executionSource: { type: "wsl" as const, distro: "Ubuntu" } };
  store.bind(target, "one");
  store.bind(alias, "one");
  store.bind(wsl, "two");
  let complete!: (value: typeof stopped) => void;
  const operation = store.run(
    target,
    "stop",
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  expect(store.read(alias).state).toBe("stopping");
  expect(store.read(wsl).state).toBe("unknown");
  expect(
    await store.run(alias, "start", () => Promise.resolve({ ...stopped, state: "running" })),
  ).toBe(false);
  store.forgetEnvironment("one", [target, alias]);
  complete(stopped);
  expect(await operation).toBe(false);
  expect(store.read(target).stopIntent).toBe(false);
});
it("keeps failed or unverified stops unknown and paused; only a verified explicit start clears stop intent", async () => {
  const store = createSshServerLifecycle();
  expect(
    await store.run(target, "stop", () =>
      Promise.reject(new Error("socket closed password=secret")),
    ),
  ).toBe(false);
  expect(store.read(target)).toMatchObject({ state: "unknown", stopIntent: true });
  expect(store.read(target).error).not.toContain("secret");
  expect(
    await store.run(target, "start", () => Promise.resolve({ ...stopped, state: "unknown" })),
  ).toBe(false);
  expect(store.read(target).stopIntent).toBe(true);
  expect(
    await store.run(target, "start", () => Promise.resolve({ ...stopped, state: "running" })),
  ).toBe(true);
  expect(store.read(target).stopIntent).toBe(false);
});
it("rejects a changed attested environment and preserves independent profiles", async () => {
  const store = createSshServerLifecycle();
  store.bind(target, "one");
  store.observe(target, { ...stopped, state: "running", environmentId: "other" });
  expect(store.read(target).state).toBe("unknown");
  expect(
    await store.run(target, "start", () =>
      Promise.resolve({ ...stopped, state: "running", environmentId: "other" }),
    ),
  ).toBe(false);
  expect(store.read(target).environmentId).toBe("one");
});
