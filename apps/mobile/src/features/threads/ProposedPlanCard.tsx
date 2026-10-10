import { useState, type ComponentProps } from "react";
import { Alert, Pressable, Share, View, TextInput } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import * as Clipboard from "expo-clipboard";
import { Markdown } from "react-native-nitro-markdown";
import {
  AuthFilesystemWriteScope,
  type EnvironmentId,
  type ThreadId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import {
  buildProposedPlanMarkdownFilename,
  normalizePlanMarkdownForExport,
} from "@t3tools/shared/proposedPlan";
import { stripDisplayedPlanMarkdown, proposedPlanTitle } from "@t3tools/shared/proposedPlanText";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { withUniwind } from "uniwind";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { usePlanActions } from "./use-plan-actions";

const ThemedStop = withUniwind(Stop, {
  stopColor: { fromClassName: "colorClassName", styleProperty: "color" },
});

export function ProposedPlanCard(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  workspaceRoot: string | null | undefined;
  projectedItem: OrchestrationV2ProjectedTurnItem;
  markdownStyles: Pick<ComponentProps<typeof Markdown>, "theme" | "styles" | "renderers">;
}) {
  const actions = usePlanActions(props);
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const canSave = useEnvironmentScope(props.environmentId, AuthFilesystemWriteScope);
  const [expanded, setExpanded] = useState(false);
  const [savePath, setSavePath] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const item = actions.item;
  if (!item) return null;
  const menuActions = [
    { id: "copy", title: "Copy plan" },
    { id: "share", title: "Share plan" },
    { id: "export", title: "Export Markdown" },
    ...(canSave && props.workspaceRoot ? [{ id: "save", title: "Save to workspace" }] : []),
    {
      id: "here",
      title: "Implement here",
      attributes: { disabled: !actions.actionable || actions.busy },
    },
    {
      id: "new",
      title: "Implement in a new thread",
      attributes: { disabled: !actions.actionable || actions.busy },
    },
  ];
  return (
    <View className="gap-3 rounded-2xl border border-border bg-card-alt p-4">
      <View className="flex-row items-center gap-2">
        <Text className="rounded bg-subtle px-2 py-1 text-xs font-t3-bold">Plan</Text>
        <Text className="min-w-0 flex-1 font-t3-bold text-base">
          {proposedPlanTitle(item.markdown) ?? "Proposed plan"}
        </Text>
        <ControlPillMenu
          accessibilityLabel="Plan actions"
          actions={menuActions}
          onPressAction={({ nativeEvent }) => {
            switch (nativeEvent.event) {
              case "copy":
                void Clipboard.setStringAsync(item.markdown);
                break;
              case "share":
                void Share.share({
                  title: proposedPlanTitle(item.markdown) ?? "Plan",
                  message: item.markdown,
                });
                break;
              case "export":
                void actions.exportPlan();
                break;
              case "save":
                setSavePath(buildProposedPlanMarkdownFilename(item.markdown));
                break;
              case "here":
                void actions.implement(false);
                break;
              case "new":
                void actions.implement(true);
                break;
            }
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Plan actions"
            className="size-11 items-center justify-center rounded-xl active:bg-subtle"
          >
            <Text className="text-xl">⋯</Text>
          </Pressable>
        </ControlPillMenu>
      </View>
      {item.streaming ? (
        <Text className="text-xs text-foreground-muted">Generating plan…</Text>
      ) : null}
      <View style={expanded ? undefined : { maxHeight: 240, overflow: "hidden" }}>
        <Markdown options={{ gfm: true }} {...props.markdownStyles}>
          {stripDisplayedPlanMarkdown(item.markdown)}
        </Markdown>
        {!expanded ? (
          <View
            pointerEvents="none"
            accessible={false}
            style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 48 }}
          >
            <Svg width="100%" height="100%">
              <Defs>
                <LinearGradient id="planFade" x1="0" y1="0" x2="0" y2="1">
                  <ThemedStop offset="0" colorClassName="text-card-alt" stopOpacity="0" />
                  <ThemedStop offset="1" colorClassName="text-card-alt" />
                </LinearGradient>
              </Defs>
              <Rect width="100%" height="100%" fill="url(#planFade)" />
            </Svg>
          </View>
        ) : null}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        className="min-h-11 items-center justify-center rounded-xl bg-subtle active:bg-subtle-strong"
      >
        <Text className="text-sm font-t3-bold">{expanded ? "Collapse plan" : "Expand plan"}</Text>
      </Pressable>
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
            disabled={saving || !canSave || !savePath.trim()}
            className="min-h-11 justify-center"
            onPress={() => {
              if (
                !props.workspaceRoot ||
                !readEnvironmentScope(props.environmentId, AuthFilesystemWriteScope)
              )
                return;
              setSaving(true);
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
                  } else
                    Alert.alert(
                      "Could not save plan",
                      "Check the path and your workspace permissions, then retry.",
                    );
                })
                .finally(() => setSaving(false));
            }}
          >
            <Text>Save to workspace</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            className="min-h-11 justify-center"
            onPress={() => setSavePath(null)}
          >
            <Text>Cancel</Text>
          </Pressable>
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        disabled={!actions.actionable || actions.busy}
        className="min-h-11 justify-center"
        onPress={() => void actions.refine()}
      >
        <Text className={actions.actionable ? "text-primary" : "text-foreground-muted"}>
          Refine plan
        </Text>
      </Pressable>
    </View>
  );
}
