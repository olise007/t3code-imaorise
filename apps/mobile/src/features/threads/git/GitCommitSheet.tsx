import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { gitEnvironment } from "../../../state/git";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../../components/AndroidScreenHeader";
import { SymbolView } from "../../../components/AppSymbol";
import { MaterialScreenContent } from "../../../components/MaterialScreenContent";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../../components/AppText";
import { cn } from "../../../lib/cn";
import { useEnvironmentQuery } from "../../../state/query";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { vcsEnvironment } from "../../../state/vcs";
import { SheetActionButton } from "./gitSheetComponents";

type GitCommitSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

export function GitCommitSheet(_props: GitCommitSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const { canWriteSourceControl, canChangeThreadBranch } = gitActions;

  const gitStatus = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );

  const busy = gitState.gitOperationLabel !== null;
  const isDefaultRef = gitStatus.data?.isDefaultRef ?? false;
  const allFiles = gitStatus.data?.workingTree?.files ?? [];

  const [dialogCommitMessage, setDialogCommitMessage] = useState("");
  const [excludedFiles, setExcludedFiles] = useState<ReadonlySet<string>>(new Set());
  const [isEditingFiles, setIsEditingFiles] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [skippedCommitFiles, setSkippedCommitFiles] = useState<readonly string[]>([]);
  const [emptyPreviewKey, setEmptyPreviewKey] = useState<string | null>(null);
  const canGenerateCommitMessage = useAtomValue(
    gitEnvironment.generateCommitMessage.permissionAtom(selectedThread?.environmentId ?? null),
  );
  const generateMessage = useAtomCommand(gitEnvironment.generateCommitMessage, {
    reportFailure: false,
  });
  const previewRequest = useRef(0);
  const previewPending = useRef(false);
  const preview = useRef({ key: "", message: "", mounted: true });
  useEffect(
    () => () => {
      preview.current.mounted = false;
    },
    [],
  );

  const selectedFiles = allFiles.filter((file) => !excludedFiles.has(file.path));
  const allSelected = excludedFiles.size === 0;
  const noneSelected = selectedFiles.length === 0;
  const previewKey = JSON.stringify([
    selectedThread?.environmentId,
    selectedThread?.id,
    selectedThreadCwd,
    selectedFiles,
    gitStatus.dataUpdatedAt,
  ]);
  const hasEmptyPreview = emptyPreviewKey === previewKey;
  const visibleSkippedFiles = skippedCommitFiles.filter((filePath) => excludedFiles.has(filePath));
  useEffect(() => {
    setSkippedCommitFiles([]);
    setEmptyPreviewKey(null);
    setExcludedFiles(new Set());
  }, [selectedThread?.environmentId, selectedThread?.id, selectedThreadCwd]);
  useEffect(() => {
    if (preview.current.key !== previewKey) previewRequest.current++;
    preview.current = { key: previewKey, message: dialogCommitMessage, mounted: true };
  }, [previewKey, dialogCommitMessage]);
  const generate = async () => {
    if (
      !selectedThread ||
      !selectedThreadCwd ||
      previewPending.current ||
      busy ||
      noneSelected ||
      !canGenerateCommitMessage
    )
      return;
    previewPending.current = true;
    const snapshot = preview.current;
    const request = ++previewRequest.current;
    setGenerating(true);
    setGenerationError(null);
    setEmptyPreviewKey(null);
    try {
      const result = await generateMessage({
        environmentId: selectedThread.environmentId,
        input: {
          cwd: selectedThreadCwd,
          threadId: selectedThread.id,
          filePaths: selectedFiles.map((file) => file.path),
          skipIgnoredFiles: true,
        },
      });
      const current = preview.current;
      if (
        request !== previewRequest.current ||
        !current.mounted ||
        current.key !== snapshot.key ||
        current.message !== snapshot.message
      )
        return;
      if (result._tag === "Success") {
        const skipped = new Set(result.value.skippedFilePaths ?? []);
        setSkippedCommitFiles((previous) => [...new Set([...previous, ...skipped])]);
        if (skipped.size > 0) {
          setExcludedFiles((previous) => new Set([...previous, ...skipped]));
        }
        if (result.value.message !== null) setDialogCommitMessage(result.value.message);
        else {
          setEmptyPreviewKey(
            JSON.stringify([
              selectedThread?.environmentId,
              selectedThread?.id,
              selectedThreadCwd,
              selectedFiles.filter((file) => !skipped.has(file.path)),
              gitStatus.dataUpdatedAt,
            ]),
          );
        }
      } else if (!isAtomCommandInterrupted(result))
        setGenerationError(String(squashAtomCommandFailure(result)));
    } finally {
      previewPending.current = false;
      if (preview.current.mounted) setGenerating(false);
    }
  };

  const selectedInsertions = selectedFiles.reduce((sum, file) => sum + file.insertions, 0);
  const selectedDeletions = selectedFiles.reduce((sum, file) => sum + file.deletions, 0);
  const selectedFilePreview = selectedFiles.slice(0, 3);

  const runCommitAction = async (featureBranch: boolean) => {
    if (!canWriteSourceControl || (featureBranch && !canChangeThreadBranch)) return;
    const commitMessage = dialogCommitMessage.trim();
    if (!commitMessage || generating || busy || noneSelected || hasEmptyPreview) return;
    navigation.goBack();
    await gitActions.onRunSelectedThreadGitAction({
      action: "commit",
      featureBranch,
      ...(commitMessage ? { commitMessage } : {}),
      ...(!allSelected ? { filePaths: selectedFiles.map((file) => file.path) } : {}),
    });
  };

  return (
    <View
      collapsable={false}
      className="bg-sheet ios:flex-1"
      style={Platform.OS === "android" ? { maxHeight: windowHeight * 0.92 } : undefined}
    >
      {Platform.OS === "android" ? (
        <NativeStackScreenOptions
          options={{
            sheetCornerRadius: 28,
            sheetAllowedDetents: "fitToContents",
          }}
        />
      ) : null}
      {Platform.OS === "android" ? (
        <AndroidSheetHeader
          title="Commit changes"
          onBack={() => navigation.goBack()}
          hideBottomBorder
        />
      ) : null}
      <MaterialScreenContent fitToContents>
        <ScrollView
          nestedScrollEnabled
          className="android:shrink android:grow-0 ios:flex-1"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
          contentContainerClassName="android:gap-2 android:p-2 ios:gap-4 ios:px-5 ios:pt-2"
          contentContainerStyle={
            Platform.OS === "android"
              ? { paddingBottom: Math.max(insets.bottom, 18) + 18 }
              : undefined
          }
        >
          <View className="gap-3 bg-card p-4 android:rounded-[20px] ios:rounded-[22px] ios:border ios:border-border">
            <View className="android:gap-1 ios:flex-row ios:items-center ios:justify-between ios:gap-3">
              <Text className="text-foreground-muted text-sm font-medium">Branch</Text>
              <Text className="text-foreground text-base android:font-t3-medium ios:font-t3-bold">
                {gitStatus.data?.refName ?? "(detached HEAD)"}
              </Text>
            </View>
            {isDefaultRef ? (
              <Text className="text-xs leading-normal text-warning-foreground">
                Warning: this is the default branch.
              </Text>
            ) : null}
          </View>

          <View className="gap-3 bg-card p-4 android:rounded-[20px] ios:rounded-[22px] ios:border ios:border-border">
            <View className="flex-row items-center justify-between gap-3">
              <View className="gap-1">
                <Text className="text-foreground text-base android:font-t3-medium ios:font-t3-bold">
                  Files
                </Text>
                <Text className="text-foreground-muted text-xs leading-normal">
                  {selectedFiles.length} selected · +{formatDiffCount(selectedInsertions)} / -
                  {formatDiffCount(selectedDeletions)}
                </Text>
              </View>
              <View className="flex-row items-center gap-2">
                {!allSelected && isEditingFiles ? (
                  <Pressable
                    className="rounded-full px-3 android:min-h-12 android:justify-center android:active:bg-subtle ios:bg-subtle ios:py-2"
                    onPress={() => {
                      previewRequest.current++;
                      setExcludedFiles(new Set());
                    }}
                  >
                    <Text className="android:text-primary-text android:text-sm android:font-t3-medium ios:text-foreground ios:text-2xs ios:font-t3-bold ios:uppercase">
                      Reset
                    </Text>
                  </Pressable>
                ) : null}
                <Pressable
                  className="rounded-full px-3 android:min-h-12 android:justify-center android:active:bg-subtle ios:bg-subtle ios:py-2"
                  onPress={() => setIsEditingFiles((current) => !current)}
                >
                  <Text className="android:text-primary-text android:text-sm android:font-t3-medium ios:text-foreground ios:text-2xs ios:font-t3-bold ios:uppercase">
                    {isEditingFiles ? "Done" : "Edit"}
                  </Text>
                </Pressable>
              </View>
            </View>

            {allFiles.length === 0 ? (
              <Text className="text-foreground-secondary text-sm leading-normal">
                No changed files are available to commit.
              </Text>
            ) : !isEditingFiles ? (
              <View className="gap-2">
                {selectedFilePreview.map((file) => (
                  <View key={file.path} className="flex-row items-center justify-between gap-3">
                    <Text className="text-foreground flex-1 text-sm font-medium" numberOfLines={1}>
                      {file.path}
                    </Text>
                    <Text className="text-xs font-t3-bold text-adaptive-emerald-700-300">
                      +{formatDiffCount(file.insertions)}
                    </Text>
                    <Text className="text-xs font-t3-bold text-adaptive-rose-700-300">
                      -{formatDiffCount(file.deletions)}
                    </Text>
                  </View>
                ))}
                {selectedFiles.length > selectedFilePreview.length ? (
                  <Text className="text-foreground-muted text-xs leading-snug">
                    +{selectedFiles.length - selectedFilePreview.length} more files
                  </Text>
                ) : null}
              </View>
            ) : (
              <View className="gap-2">
                {allFiles.map((file) => {
                  const included = !excludedFiles.has(file.path);
                  return (
                    <Pressable
                      key={file.path}
                      className={cn(
                        "px-4 py-3 android:rounded-xl ios:rounded-[18px] ios:border",
                        included
                          ? "android:bg-subtle ios:border-border"
                          : "ios:border-border-subtle",
                      )}
                      accessibilityRole="checkbox"
                      accessibilityLabel={file.path}
                      accessibilityState={{ checked: included }}
                      onPress={() => {
                        previewRequest.current++;
                        setExcludedFiles((current) => {
                          const next = new Set(current);
                          if (next.has(file.path)) {
                            next.delete(file.path);
                          } else {
                            next.add(file.path);
                          }
                          return next;
                        });
                      }}
                    >
                      {Platform.OS !== "android" ? (
                        <View
                          className={`absolute inset-0 rounded-[18px] ${included ? "bg-card" : "bg-subtle"}`}
                        />
                      ) : null}
                      <View className="flex-row items-start justify-between gap-3">
                        {Platform.OS === "android" ? (
                          <View
                            className={cn(
                              "mt-0.5 size-5 items-center justify-center rounded-sm",
                              included ? "bg-primary" : "border border-input-border",
                            )}
                          >
                            {included ? (
                              <SymbolView
                                name="checkmark"
                                size={16}
                                tintColorClassName="accent-primary-foreground"
                                type="monochrome"
                              />
                            ) : null}
                          </View>
                        ) : null}
                        <View className="flex-1 gap-1">
                          <Text
                            selectable
                            className={`text-sm font-t3-bold ${included ? "text-foreground" : "text-foreground-muted"}`}
                          >
                            {file.path}
                          </Text>
                          {!included ? (
                            <Text className="text-foreground-muted text-2xs leading-normal">
                              Excluded from this commit
                            </Text>
                          ) : null}
                        </View>
                        <View className="items-end gap-1">
                          <Text className="text-xs font-t3-bold text-adaptive-emerald-700-300">
                            +{formatDiffCount(file.insertions)}
                          </Text>
                          <Text className="text-xs font-t3-bold text-adaptive-rose-700-300">
                            -{formatDiffCount(file.deletions)}
                          </Text>
                        </View>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>

          <View className="android:gap-3 android:rounded-[20px] android:bg-card android:p-4 ios:gap-2">
            <Text className="text-foreground android:text-base android:font-t3-medium ios:text-sm ios:font-t3-bold">
              Commit message
            </Text>
            <SheetActionButton
              icon="pencil"
              label={generating ? "Generating…" : "Generate commit message"}
              disabled={!canGenerateCommitMessage || noneSelected || busy || generating}
              onPress={() => void generate()}
            />
            {generationError && (
              <Text accessibilityRole="alert" className="text-destructive">
                {generationError}
              </Text>
            )}
            {visibleSkippedFiles.length > 0 && (
              <Text accessibilityRole="alert" className="text-warning-foreground">
                {`Ignored files were excluded from this commit:\n${visibleSkippedFiles.join("\n")}`}
              </Text>
            )}
            {hasEmptyPreview && (
              <Text accessibilityRole="alert" className="text-foreground-muted">
                No selected changes remain to describe. Refresh or change the file selection.
              </Text>
            )}
            <TextInput
              multiline
              accessibilityLabel="Commit message"
              value={dialogCommitMessage}
              onChangeText={(message) => {
                previewRequest.current++;
                setDialogCommitMessage(message);
              }}
              placeholder="Write a message or generate one to review"
              textAlignVertical="top"
              className="min-h-[128px] px-4 py-3.5 android:rounded-xl android:bg-sheet-solid ios:rounded-[20px]"
            />
          </View>

          <View className="android:gap-2 ios:flex-row ios:gap-3">
            <View className="ios:flex-1">
              <SheetActionButton
                icon="arrow.branch"
                label="Commit on new branch"
                disabled={
                  !canChangeThreadBranch ||
                  noneSelected ||
                  hasEmptyPreview ||
                  busy ||
                  generating ||
                  !dialogCommitMessage.trim()
                }
                onPress={() => void runCommitAction(true)}
              />
            </View>
            <View className="ios:flex-1">
              <SheetActionButton
                icon="checkmark.circle"
                label="Commit"
                tone="primary"
                disabled={
                  !canWriteSourceControl ||
                  noneSelected ||
                  hasEmptyPreview ||
                  busy ||
                  generating ||
                  !dialogCommitMessage.trim()
                }
                onPress={() => void runCommitAction(false)}
              />
            </View>
          </View>
        </ScrollView>
      </MaterialScreenContent>
    </View>
  );
}
