import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  completeConfirmDialogClose,
  isConfirmDialogActive,
  readConfirmDialogState,
  registerConfirmDialogHost,
  requestConfirmDialog,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
} from "./confirmDialog";

function requireConfirmation(confirmation: Promise<boolean> | undefined): Promise<boolean> {
  if (!confirmation) {
    throw new Error("Expected a registered confirmation host.");
  }
  return confirmation;
}

describe("confirm dialog coordinator", () => {
  beforeEach(() => {
    resetConfirmDialogForTests();
  });

  it("returns undefined until a themed host is mounted", () => {
    expect(requestConfirmDialog("Confirm this action?")).toBeUndefined();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
  });

  it("resolves a displayed confirmation and waits for its close transition", async () => {
    const unregister = registerConfirmDialogHost();
    const confirmation = requireConfirmation(
      requestConfirmDialog("Delete this thread?", { variant: "destructive" }),
    );

    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      message: "Delete this thread?",
      variant: "destructive",
    });

    respondToConfirmDialog(true);
    await expect(confirmation).resolves.toBe(true);
    // Still on screen while it closes, so nothing may cover it yet.
    expect(isConfirmDialogActive()).toBe(true);
    expect(readConfirmDialogState()).toEqual({
      status: "closing",
      message: "Delete this thread?",
      variant: "destructive",
    });

    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    expect(isConfirmDialogActive()).toBe(false);
    unregister();
  });

  it("serializes concurrent confirmations", async () => {
    const unregister = registerConfirmDialogHost();
    const first = requireConfirmation(requestConfirmDialog("Delete the project?"));
    const second = requireConfirmation(requestConfirmDialog("Delete the worktree too?"));

    respondToConfirmDialog(false);
    await expect(first).resolves.toBe(false);
    expect(readConfirmDialogState()).toEqual({
      status: "closing",
      message: "Delete the project?",
      variant: "default",
    });

    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      message: "Delete the worktree too?",
      variant: "default",
    });

    respondToConfirmDialog(true);
    await expect(second).resolves.toBe(true);
    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
  });

  it("cancels active and queued confirmations if the last host unmounts", async () => {
    const unregister = registerConfirmDialogHost();
    const active = requireConfirmation(requestConfirmDialog("Delete the thread?"));
    const queued = requireConfirmation(requestConfirmDialog("Delete the worktree too?"));

    unregister();

    await expect(Promise.all([active, queued])).resolves.toEqual([false, false]);
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
  });

  it("ignores responses after the active dialog has been closed", () => {
    const unregister = registerConfirmDialogHost();
    const confirmation = requireConfirmation(requestConfirmDialog("Continue?"));

    respondToConfirmDialog(true);
    respondToConfirmDialog(false);
    completeConfirmDialogClose();

    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
    return expect(confirmation).resolves.toBe(true);
  });
});

it("retains an explicit Start action label through confirmation and close", async () => {
  resetConfirmDialogForTests();
  const unregister = registerConfirmDialogHost();
  const pending = requestConfirmDialog("Start the server?", {
    confirmLabel: "Start server and connect",
  });
  expect(readConfirmDialogState()).toMatchObject({ confirmLabel: "Start server and connect" });
  respondToConfirmDialog(true);
  expect(await pending).toBe(true);
  expect(readConfirmDialogState()).toMatchObject({ confirmLabel: "Start server and connect" });
  completeConfirmDialogClose();
  unregister();
});

it("cancels only the owned confirmation when its connection is removed", async () => {
  resetConfirmDialogForTests();
  const unregister = registerConfirmDialogHost();
  const controller = new AbortController();
  const first = requestConfirmDialog("Start?", { signal: controller.signal });
  const next = requestConfirmDialog("Unrelated action?");
  controller.abort();
  expect(await first).toBe(false);
  completeConfirmDialogClose();
  expect(readConfirmDialogState()).toMatchObject({ message: "Unrelated action?" });
  respondToConfirmDialog(true);
  expect(await next).toBe(true);
  completeConfirmDialogClose();
  unregister();
});

it("removes a cancelled queued Start without closing another confirmation", async () => {
  resetConfirmDialogForTests();
  const unregister = registerConfirmDialogHost();
  const first = requestConfirmDialog("Unrelated action?");
  const controller = new AbortController();
  const queued = requestConfirmDialog("Start?", { signal: controller.signal });
  controller.abort();
  expect(await queued).toBe(false);
  expect(readConfirmDialogState()).toMatchObject({ message: "Unrelated action?" });
  respondToConfirmDialog(true);
  expect(await first).toBe(true);
  completeConfirmDialogClose();
  expect(readConfirmDialogState()).toEqual({ status: "idle" });
  unregister();
});
