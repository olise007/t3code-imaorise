import { describe, expect, it } from "vite-plus/test";
import {
  beginPlanAction,
  finishPlanAction,
  planActionStatus,
  subscribePlanActions,
  registerPlanComposer,
  focusPlanComposer,
} from "./plan-action-state";
describe("plan actions across card and composer", () => {
  it("allows one submission, retries a failure, and prevents replay after success", () => {
    let updates = 0;
    const unsubscribe = subscribePlanActions(() => updates++);
    expect(beginPlanAction("environment:thread:plan")).toBe(true);
    expect(beginPlanAction("environment:thread:plan")).toBe(false);
    expect(planActionStatus("environment:thread:plan")).toBe("busy");
    finishPlanAction("environment:thread:plan", false);
    expect(beginPlanAction("environment:thread:plan")).toBe(true);
    finishPlanAction("environment:thread:plan", true);
    expect(beginPlanAction("environment:thread:plan")).toBe(false);
    expect(beginPlanAction("another:thread:plan")).toBe(true);
    finishPlanAction("another:thread:plan", false);
    expect(updates).toBe(6);
    unsubscribe();
  });
  it("focuses only the requested environment and thread and releases an unmounted editor", () => {
    let focused = 0;
    const unregister = registerPlanComposer("env", "thread", () => focused++);
    focusPlanComposer("other", "thread");
    expect(focused).toBe(0);
    focusPlanComposer("env", "thread");
    expect(focused).toBe(1);
    unregister();
    focusPlanComposer("env", "thread");
    expect(focused).toBe(1);
  });
});
