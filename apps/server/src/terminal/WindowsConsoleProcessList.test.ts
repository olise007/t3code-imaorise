// @effect-diagnostics nodeBuiltinImport:off
import * as NodeEvents from "node:events";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { windowsConsoleProcessList } from "./WindowsConsoleProcessList.ts";
const state = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("node:child_process", () => ({ fork: state.fork }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
const peer = () => Object.assign(new NodeEvents.EventEmitter(), { kill: vi.fn() });
it("returns a verified shell console list through the narrow packaged helper", async () => {
  const child = peer();
  state.fork.mockReturnValue(child);
  const result = windowsConsoleProcessList(100001);
  child.emit("message", { consoleProcessList: [100001, 100002] });
  expect(await result).toEqual([100001, 100002]);
  expect(state.fork.mock.calls[0]?.slice(0, 2)).toEqual(["__pty-console-list", ["100001"]]);
  expect(child.kill).not.toHaveBeenCalled();
});
it.each(["error", "exit", "disconnect"])(
  "contains helper %s without failing the host",
  async (event) => {
    const child = peer();
    state.fork.mockReturnValue(child);
    const result = windowsConsoleProcessList(100001);
    child.emit(event, new Error("fixture child ended"));
    expect(await result).toEqual([100001]);
  },
);
it("bounds a stuck helper and refuses a list containing the host", async () => {
  vi.useFakeTimers();
  const child = peer();
  state.fork.mockReturnValue(child);
  const result = windowsConsoleProcessList(100001);
  child.emit("message", { consoleProcessList: [process.pid, 100001] });
  expect(await result).toEqual([100001]);
  const stuck = peer();
  state.fork.mockReturnValue(stuck);
  const timeout = windowsConsoleProcessList(100001);
  vi.advanceTimersByTime(5000);
  expect(await timeout).toEqual([100001]);
  expect(stuck.kill).toHaveBeenCalledTimes(1);
});
it("contains synchronous spawn failure", async () => {
  state.fork.mockImplementation(() => {
    throw new Error("spawn unavailable");
  });
  expect(await windowsConsoleProcessList(100001)).toEqual([100001]);
});
