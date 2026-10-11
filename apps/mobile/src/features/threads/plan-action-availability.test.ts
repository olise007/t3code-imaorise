import { describe, expect, it } from "vite-plus/test";
import { PlanId, RunId } from "@t3tools/contracts";
import { isMobilePlanActionable, showMobilePlanImplementation } from "./plan-action-availability";

const planId = PlanId.make("plan");
const runId = RunId.make("run");
const ready = {
  item: { planId, runId, streaming: false },
  plan: { id: planId, status: "active" as const },
  latestRun: { runId, status: "completed" },
  implemented: false,
};

describe("mobile plan availability", () => {
  it("becomes actionable when detail completes without needing a shell update", () => {
    expect(isMobilePlanActionable({ ...ready, latestRun: { runId, status: "running" } })).toBe(
      false,
    );
    expect(isMobilePlanActionable({ ...ready, item: { ...ready.item, streaming: true } })).toBe(
      false,
    );
    expect(isMobilePlanActionable(ready)).toBe(true);
  });

  it("rejects old, superseded, missing, and already submitted plans", () => {
    expect(
      isMobilePlanActionable({ ...ready, latestRun: { runId: "new-run", status: "completed" } }),
    ).toBe(false);
    expect(
      isMobilePlanActionable({ ...ready, plan: { id: PlanId.make("new-plan"), status: "active" } }),
    ).toBe(false);
    expect(isMobilePlanActionable({ ...ready, plan: null })).toBe(false);
    expect(isMobilePlanActionable({ ...ready, item: null })).toBe(false);
    expect(isMobilePlanActionable({ ...ready, implemented: true })).toBe(false);
  });

  it("switches from Implement to Send while typing and restores Implement after clearing", () => {
    const presentation = {
      actionable: true,
      hasContent: false,
      editingQueuedMessage: false,
      voiceInputPresented: false,
    };
    expect(showMobilePlanImplementation(presentation)).toBe(true);
    expect(showMobilePlanImplementation({ ...presentation, hasContent: true })).toBe(false);
    expect(showMobilePlanImplementation(presentation)).toBe(true);
    expect(showMobilePlanImplementation({ ...presentation, editingQueuedMessage: true })).toBe(
      false,
    );
    expect(showMobilePlanImplementation({ ...presentation, voiceInputPresented: true })).toBe(
      false,
    );
    expect(showMobilePlanImplementation({ ...presentation, actionable: false })).toBe(false);
  });
});
