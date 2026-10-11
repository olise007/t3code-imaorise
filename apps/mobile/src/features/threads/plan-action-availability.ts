import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import type { LatestProposedPlanState } from "@t3tools/shared/proposedPlan";

/** Plan and run state must come from the same detail projection. */
export function isMobilePlanActionable(input: {
  item: Pick<
    Extract<OrchestrationV2ProjectedTurnItem["item"], { type: "proposed_plan" }>,
    "planId" | "runId" | "streaming"
  > | null;
  plan: Pick<LatestProposedPlanState, "id" | "status"> | null;
  latestRun: { runId: string; status: string } | null;
  implemented: boolean;
}) {
  const { item, plan, latestRun, implemented } = input;
  return (
    item !== null &&
    !implemented &&
    plan?.id === item.planId &&
    plan.status === "active" &&
    !item.streaming &&
    (latestRun === null ||
      (item.runId === latestRun.runId &&
        ["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(
          latestRun.status,
        )))
  );
}

export function showMobilePlanImplementation(input: {
  actionable: boolean;
  hasContent: boolean;
  editingQueuedMessage: boolean;
  voiceInputPresented: boolean;
}) {
  return (
    input.actionable &&
    !input.hasContent &&
    !input.editingQueuedMessage &&
    !input.voiceInputPresented
  );
}
