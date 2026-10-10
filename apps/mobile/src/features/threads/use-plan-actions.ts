import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { useSyncExternalStore } from "react";
import { Alert } from "react-native";
import { useNavigation } from "@react-navigation/native";
import {
  AuthOrchestrationOperateScope,
  MessageId,
  ThreadId,
  type EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import {
  buildPlanImplementationPrompt,
  buildPlanImplementationThreadTitle,
  buildProposedPlanMarkdownFilename,
  normalizePlanMarkdownForExport,
  findLatestProposedPlan,
} from "@t3tools/shared/proposedPlan";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useSelectedThreadProjection } from "../../state/use-thread-detail";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { useEnvironmentScope } from "../../state/session";
import {
  getComposerDraftSnapshot,
  updateComposerDraftSettings,
} from "../../state/use-composer-drafts";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { waitForThreadShellReady } from "./threadForkNavigation";
import { environmentThreadShells } from "../../state/threads";
import { appAtomRegistry } from "../../state/atom-registry";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  beginPlanAction,
  finishPlanAction,
  planActionStatus,
  subscribePlanActions,
  focusPlanComposer,
} from "./plan-action-state";
async function waitForThreadShell(environmentId: EnvironmentId, threadId: ThreadId) {
  const atom = environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, threadId));
  return waitForThreadShellReady({ read: () => appAtomRegistry.get(atom) !== null });
}

export function usePlanActions(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  projectedItem?: OrchestrationV2ProjectedTurnItem;
}) {
  const { selectedThread, selectedThreadProject, selectedEnvironmentRuntime } =
    useThreadSelection();
  const detail = useSelectedThreadProjection();
  const startTurn = useAtomCommand(threadEnvironment.startTurn);
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const setMode = useAtomCommand(threadEnvironment.setInteractionMode);
  const navigation = useNavigation();
  const plan = findLatestProposedPlan(detail?.projection ?? null, selectedThread?.latestRun?.runId);
  const projectedItem =
    props.projectedItem ??
    detail?.projection.visibleTurnItems.findLast(
      (candidate) => candidate.item.type === "proposed_plan" && candidate.item.planId === plan?.id,
    );
  const item = projectedItem?.item.type === "proposed_plan" ? projectedItem.item : null;
  const key = `${props.environmentId}:${props.threadId}:${item?.planId ?? "none"}`;
  const status = useSyncExternalStore(subscribePlanActions, () => planActionStatus(key));
  const busy = status === "busy";
  const implemented = status === "submitted";
  const actionable =
    item !== null &&
    !implemented &&
    plan?.id === item.planId &&
    plan.status === "active" &&
    !item.streaming &&
    (!selectedThread?.latestRun || item.runId === selectedThread.latestRun.runId) &&
    selectedThread?.id === props.threadId &&
    selectedThread.environmentId === props.environmentId &&
    (!selectedThread.latestRun ||
      ["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(
        selectedThread.latestRun.status,
      )) &&
    !detail?.projection.runtimeRequests.some((request) => request.status === "pending") &&
    canOperate;
  const exportPlan = async () => {
    if (!item) return;
    const uri = `${FileSystem.cacheDirectory}${buildProposedPlanMarkdownFilename(item.markdown)}`;
    try {
      await FileSystem.writeAsStringAsync(uri, normalizePlanMarkdownForExport(item.markdown));
      await Sharing.shareAsync(uri, { mimeType: "text/markdown", dialogTitle: "Export plan" });
    } catch (error) {
      Alert.alert(
        "Could not export plan",
        error instanceof Error ? error.message : "Export failed.",
      );
    }
  };
  const implement = async (newThread: boolean) => {
    if (!actionable || !selectedThread || !item || !projectedItem || !beginPlanAction(key)) return;
    let succeeded = false;
    const draft = getComposerDraftSnapshot(scopedThreadKey(props.environmentId, props.threadId));
    const modelSelection = draft.modelSelection ?? selectedThread.modelSelection;
    const runtimeMode =
      newThread && selectedEnvironmentRuntime?.serverConfig
        ? resolveProjectSettings(
            selectedEnvironmentRuntime.serverConfig.settings,
            selectedThread.projectId,
            selectedThreadProject ?? undefined,
          ).settings.defaultRuntimeMode
        : (draft.runtimeMode ?? selectedThread.runtimeMode);
    const targetThreadId = newThread ? ThreadId.make(uuidv4()) : props.threadId;
    try {
      const result = await startTurn({
        environmentId: props.environmentId,
        input: {
          threadId: targetThreadId,
          message: {
            messageId: MessageId.make(uuidv4()),
            role: "user",
            text: buildPlanImplementationPrompt(item.markdown),
            attachments: [],
          },
          modelSelection,
          runtimeMode,
          interactionMode: "default",
          sourceProposedPlan: { threadId: projectedItem.sourceThreadId, planId: item.planId },
          ...(newThread
            ? {
                bootstrap: {
                  createThread: {
                    projectId: selectedThread.projectId,
                    title: buildPlanImplementationThreadTitle(item.markdown),
                    modelSelection,
                    runtimeMode,
                    interactionMode: "default" as const,
                    branch: selectedThread.branch,
                    worktreePath: selectedThread.worktreePath,
                    createdAt: new Date().toISOString(),
                  },
                },
              }
            : {}),
        },
      });
      if (result._tag === "Success") {
        succeeded = true;
        if (newThread && (await waitForThreadShell(props.environmentId, targetThreadId)))
          navigation.navigate("Thread", {
            environmentId: props.environmentId,
            threadId: targetThreadId,
          });
        else if (!newThread)
          updateComposerDraftSettings(scopedThreadKey(props.environmentId, props.threadId), {
            interactionMode: "default",
          });
        else
          Alert.alert(
            "Thread created",
            "The new thread is still synchronizing. Open it from the thread list when it appears.",
          );
      } else {
        Alert.alert(
          "Could not implement plan",
          "Check your connection and permissions, then retry. Your draft has been preserved.",
        );
      }
    } catch {
      Alert.alert(
        "Could not implement plan",
        "Check your connection and retry. Your draft has been preserved.",
      );
    } finally {
      finishPlanAction(key, succeeded);
    }
  };
  const refine = async () => {
    if (!actionable || busy) return;
    const result = await setMode({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, interactionMode: "plan" },
    });
    if (result._tag === "Success") {
      updateComposerDraftSettings(scopedThreadKey(props.environmentId, props.threadId), {
        interactionMode: "plan",
      });
      focusPlanComposer(props.environmentId, props.threadId);
    }
  };
  return { item, actionable, busy, implement, refine, exportPlan };
}
