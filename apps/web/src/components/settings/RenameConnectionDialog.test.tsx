// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { RenameConnectionDialog } from "./RenameConnectionDialog";

let root: Root;
let container: HTMLDivElement;
const save = vi.fn<(label: string) => Promise<string | null>>();
const close = vi.fn();
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  save.mockReset().mockResolvedValue(null);
  close.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(<RenameConnectionDialog name="Old machine" onSave={save} onClose={close} />),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function typeName(value: string) {
  const input = document.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () =>
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
it("prefills the name, trims a submitted rename, and closes after success", async () => {
  expect(document.querySelector("input")!.value).toBe("Old machine");
  await typeName("  Production  ");
  await submit();
  expect(save).toHaveBeenCalledWith("Production");
  expect(close).toHaveBeenCalledTimes(1);
});
it("rejects whitespace and lets the user retry after a storage failure", async () => {
  await typeName("   ");
  await submit();
  expect(save).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("cannot be empty");
  await typeName("Production");
  save.mockResolvedValueOnce("Storage unavailable");
  await submit();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Storage unavailable");
  expect(document.querySelector("input")!.value).toBe("Production");
  expect(close).not.toHaveBeenCalled();
  await submit();
  expect(close).toHaveBeenCalledTimes(1);
});
it("discards the draft when cancelled", async () => {
  await typeName("Discard me");
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Cancel")!
      .click(),
  );
  expect(save).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});
it("discards the draft on Escape", async () => {
  await typeName("Discard me");
  await act(async () =>
    document
      .querySelector("input")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(save).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1);
});
