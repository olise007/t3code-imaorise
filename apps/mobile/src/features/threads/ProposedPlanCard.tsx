import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { projectEnvironment } from "../../state/projects";
import { useRef, useState } from "react";
import { Alert, Pressable, Share, View, TextInput } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Markdown } from "react-native-nitro-markdown";
import { useNavigation } from "@react-navigation/native";
import {
  AuthOrchestrationOperateScope,
  AuthFilesystemWriteScope,
  MessageId,
  ThreadId,
  type EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import {
  buildCollapsedProposedPlanPreviewMarkdown,
  buildPlanImplementationPrompt,
  buildPlanImplementationThreadTitle,
  buildProposedPlanMarkdownFilename,
  normalizePlanMarkdownForExport,
  findLatestProposedPlan,
} from "@t3tools/shared/proposedPlan";
import { proposedPlanTitle } from "@t3tools/shared/proposedPlanText";
import { AppText as Text } from "../../components/AppText";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useSelectedThreadProjection } from "../../state/use-thread-detail";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { updateComposerDraftSettings } from "../../state/use-composer-drafts";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { uuidv4 } from "../../lib/uuid";
import { waitForThreadShellReady } from "./threadForkNavigation";
import { environmentThreadShells } from "../../state/threads";
import { appAtomRegistry } from "../../state/atom-registry";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
async function waitForThreadShell(environmentId: EnvironmentId, threadId: ThreadId) {
  const atom = environmentThreadShells.threadShellAtom(scopeThreadRef(environmentId, threadId));
  return waitForThreadShellReady({ read: () => appAtomRegistry.get(atom) !== null });
}

export function ProposedPlanCard(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  workspaceRoot: string | null | undefined;
  projectedItem: OrchestrationV2ProjectedTurnItem;
}) {
  const { selectedThread, selectedThreadProject, selectedEnvironmentRuntime } =
    useThreadSelection();
  const detail = useSelectedThreadProjection();
  const startTurn = useAtomCommand(threadEnvironment.startTurn);
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const canSave = useEnvironmentScope(props.environmentId, AuthFilesystemWriteScope);
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const [savePath, setSavePath] = useState<string | null>(null);
  const setMode = useAtomCommand(threadEnvironment.setInteractionMode);
  const navigation = useNavigation();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const item = props.projectedItem.item;
  if (item.type !== "proposed_plan") return null;
  const plan = findLatestProposedPlan(detail?.projection ?? null, selectedThread?.latestRun?.runId);
  const actionable =
    plan?.id === item.planId &&
    plan.status === "active" &&
    !item.streaming &&
    selectedThread?.id === props.threadId &&
    selectedThread.environmentId === props.environmentId &&
    (!selectedThread.latestRun ||
      ["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(
        selectedThread.latestRun.status,
      )) &&
    !detail?.projection.runtimeRequests.some((request) => request.status === "pending") &&
    canOperate;
  const exportPlan = async () => {
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
    if (!actionable || !selectedThread || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    const runtimeMode =
      newThread && selectedEnvironmentRuntime?.serverConfig
        ? resolveProjectSettings(
            selectedEnvironmentRuntime.serverConfig.settings,
            selectedThread.projectId,
            selectedThreadProject ?? undefined,
          ).settings.defaultRuntimeMode
        : selectedThread.runtimeMode;
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
          modelSelection: selectedThread.modelSelection,
          runtimeMode,
          interactionMode: "default",
          sourceProposedPlan: { threadId: props.projectedItem.sourceThreadId, planId: item.planId },
          ...(newThread
            ? {
                bootstrap: {
                  createThread: {
                    projectId: selectedThread.projectId,
                    title: buildPlanImplementationThreadTitle(item.markdown),
                    modelSelection: selectedThread.modelSelection,
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
        if (newThread && (await waitForThreadShell(props.environmentId, targetThreadId)))
          navigation.navigate("Thread", {
            environmentId: props.environmentId,
            threadId: targetThreadId,
          });
        else if (!newThread)
          updateComposerDraftSettings(scopedThreadKey(props.environmentId, props.threadId), {
            interactionMode: "default",
          });
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <View className="gap-3 rounded-2xl border border-border bg-card-alt p-4">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
      >
        <Text className="font-t3-bold text-lg">
          {proposedPlanTitle(item.markdown) ?? "Proposed plan"}
        </Text>
        <Text className="text-foreground-muted">
          {expanded ? "Collapse" : "Expand"}
          {item.streaming ? " · Generating…" : ""}
        </Text>
      </Pressable>
      <Markdown options={{ gfm: true }}>
        {expanded ? item.markdown : buildCollapsedProposedPlanPreviewMarkdown(item.markdown)}
      </Markdown>
      {savePath !== null ? (
        <View className="gap-2">
          <TextInput
            accessibilityLabel="Workspace plan path"
            value={savePath}
            onChangeText={setSavePath}
            className="rounded-lg border border-border p-3 text-foreground"
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy || !canSave || !savePath.trim()}
            onPress={() => {
              if (
                !props.workspaceRoot ||
                !readEnvironmentScope(props.environmentId, AuthFilesystemWriteScope)
              )
                return;
              setBusy(true);
              void writeFile({
                environmentId: props.environmentId,
                input: {
                  cwd: props.workspaceRoot,
                  relativePath: savePath.trim(),
                  contents: normalizePlanMarkdownForExport(item.markdown),
                },
              })
                .then((result) => {
                  if (result._tag === "Success") {
                    setSavePath(null);
                    Alert.alert("Plan saved", result.value.relativePath);
                  }
                })
                .finally(() => setBusy(false));
            }}
          >
            <Text>Save to workspace</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => setSavePath(null)}>
            <Text>Cancel</Text>
          </Pressable>
        </View>
      ) : null}
      <View className="flex-row flex-wrap gap-4">
        <Pressable
          accessibilityRole="button"
          onPress={() => void Clipboard.setStringAsync(item.markdown)}
        >
          <Text>Copy</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            void Share.share({
              title: proposedPlanTitle(item.markdown) ?? "Plan",
              message: item.markdown,
            })
          }
        >
          <Text>Share</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={() => void exportPlan()}>
          <Text>Export Markdown</Text>
        </Pressable>
        {canSave && props.workspaceRoot ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setSavePath(buildProposedPlanMarkdownFilename(item.markdown))}
          >
            <Text>Save to workspace</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          disabled={!actionable || busy}
          onPress={() => {
            if (!actionable) return;
            updateComposerDraftSettings(scopedThreadKey(props.environmentId, props.threadId), {
              interactionMode: "plan",
            });
            void setMode({
              environmentId: props.environmentId,
              input: { threadId: props.threadId, interactionMode: "plan" },
            });
            Alert.alert(
              "Refine plan",
              "Enter your changes in the composer and send them in Plan mode.",
            );
          }}
        >
          <Text className={actionable ? "text-primary" : "text-foreground-muted"}>Refine</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={!actionable || busy}
          onPress={() => void implement(false)}
        >
          <Text className={actionable ? "text-primary" : "text-foreground-muted"}>
            Implement here
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={!actionable || busy}
          onPress={() => void implement(true)}
        >
          <Text className={actionable ? "text-primary" : "text-foreground-muted"}>
            Implement in new thread
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
