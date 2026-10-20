import {
  AuthOrchestrationOperateScope,
  EDITORS,
  EditorId,
  EnvironmentAuthorizationError,
  EnvironmentId,
  buildRemoteOpenUrl,
  REMOTE_CAPABLE_EDITOR_IDS,
} from "@t3tools/contracts";
import {
  mapAtomCommandResult,
  type AtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "./hooks/useLocalStorage";
import { useCallback, useMemo } from "react";
import { shellEnvironment } from "./state/shell";
import { useAtomCommand } from "./state/use-atom-command";
import { readEnvironmentScope } from "./state/session";
import {
  useWslEditorDestinations,
  type EditorDestinationPreference,
} from "./wslEditorDestinations";
import { openRemoteEditorUrl } from "./remoteOpen";

const LAST_EDITOR_KEY = "t3code:last-editor";

export class EditorDestinationLaunchError extends Schema.TaggedError<EditorDestinationLaunchError>()(
  "EditorDestinationLaunchError",
  { message: Schema.String },
) {}

export class PreferredEditorEnvironmentRequiredError extends Schema.TaggedError<PreferredEditorEnvironmentRequiredError>()(
  "PreferredEditorEnvironmentRequiredError",
  {
    targetPath: Schema.String,
  },
) {
  override get message(): string {
    return `Cannot open ${this.targetPath} because no environment is selected.`;
  }
}

export class PreferredEditorUnavailableError extends Schema.TaggedError<PreferredEditorUnavailableError>()(
  "PreferredEditorUnavailableError",
  {
    environmentId: EnvironmentId,
    targetPath: Schema.String,
    availableEditorIds: Schema.Array(EditorId),
  },
) {
  override get message(): string {
    return `No available editor can open ${this.targetPath} in environment ${this.environmentId}.`;
  }
}

export function usePreferredEditor(availableEditors: ReadonlyArray<EditorId>) {
  const [lastEditor, setLastEditor] = useLocalStorage(LAST_EDITOR_KEY, null, EditorId);

  const effectiveEditor = useMemo(() => {
    if (lastEditor && availableEditors.includes(lastEditor)) return lastEditor;
    return EDITORS.find((editor) => availableEditors.includes(editor.id))?.id ?? null;
  }, [lastEditor, availableEditors]);

  return [effectiveEditor, setLastEditor] as const;
}

function resolveAndPersistPreferredEditor(availableEditors: readonly EditorId[]): EditorId | null {
  const availableEditorIds = new Set(availableEditors);
  const stored = getLocalStorageItem(LAST_EDITOR_KEY, EditorId);
  if (stored && availableEditorIds.has(stored)) return stored;
  const editor = EDITORS.find((editor) => availableEditorIds.has(editor.id))?.id ?? null;
  if (editor) setLocalStorageItem(LAST_EDITOR_KEY, editor, EditorId);
  return editor ?? null;
}

/**
 * Launch through the selected environment's destination. Recheck host grants at
 * invocation time; persist WSL choices only after the launcher accepts them.
 * Returns structured failures so file actions can keep their existing error UI.
 */
export function useOpenInPreferredEditor(
  environmentId: EnvironmentId | null,
  availableEditors: readonly EditorId[],
) {
  const destinations = useWslEditorDestinations(environmentId, availableEditors);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  type OpenInEditorError = AtomCommandFailure<Awaited<ReturnType<typeof openInEditor>>>;

  return useCallback(
    async (
      targetPath: string,
      destination?: EditorDestinationPreference,
    ): Promise<
      AtomCommandResult<
        EditorId,
        | OpenInEditorError
        | PreferredEditorEnvironmentRequiredError
        | PreferredEditorUnavailableError
        | EnvironmentAuthorizationError
        | EditorDestinationLaunchError
      >
    > => {
      if (environmentId === null) {
        return AsyncResult.failure(
          Cause.fail(
            new PreferredEditorEnvironmentRequiredError({
              targetPath,
            }),
          ),
        );
      }
      if (destinations.remote.mode === "remote-links") {
        try {
          const installed = (await window.desktopBridge?.probeRemoteEditors?.()) ?? [
            "vscode" as const,
          ];
          const available = installed.filter((id) => REMOTE_CAPABLE_EDITOR_IDS.includes(id));
          const saved = getLocalStorageItem(LAST_EDITOR_KEY, EditorId);
          const editor = saved && available.includes(saved) ? saved : available[0];
          const url = editor
            ? buildRemoteOpenUrl({
                editor,
                host: destinations.remote.host.host,
                absolutePath: targetPath,
              })
            : undefined;
          if (!url || !editor || !(await openRemoteEditorUrl(url)))
            throw new Error("The remote editor could not be opened on this device.");
          setLocalStorageItem(LAST_EDITOR_KEY, editor, EditorId);
          return AsyncResult.success(editor);
        } catch (error) {
          return AsyncResult.failure(
            Cause.fail(
              new EditorDestinationLaunchError({
                message: error instanceof Error ? error.message : "Could not open remote editor.",
              }),
            ),
          );
        }
      }
      if (destinations.remote.mode === "remote-unavailable") {
        return AsyncResult.failure(
          Cause.fail(
            new EditorDestinationLaunchError({
              message: "No SSH route is available for this environment.",
            }),
          ),
        );
      }
      if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
        return AsyncResult.failure(
          Cause.fail(
            new EnvironmentAuthorizationError({
              requiredScope: AuthOrchestrationOperateScope,
              message: "This connection cannot open an editor on this environment.",
            }),
          ),
        );
      }
      const selected = destination ?? destinations.preferred;
      if (
        destinations.active &&
        selected &&
        !destinations.options.some(
          (entry) =>
            entry.enabled && entry.editor === selected.editor && entry.source === selected.source,
        )
      ) {
        return AsyncResult.failure(
          Cause.fail(
            new EditorDestinationLaunchError({
              message: "This editor destination is unavailable. Refresh the editor list.",
            }),
          ),
        );
      }
      if (destinations.active && selected?.source === "windows") {
        const remote = destinations.remote;
        if (remote.mode !== "local-wsl")
          return AsyncResult.failure(
            Cause.fail(
              new EditorDestinationLaunchError({ message: "WSL environment is unavailable." }),
            ),
          );
        // Existing file-link paths encode line/column as a trailing suffix.
        const position = /^(.*?):(\d+)(?::(\d+))?$/.exec(targetPath);
        try {
          const opened = await window.desktopBridge!.openWslEditor!({
            backendId: remote.backendId,
            distro: remote.distro,
            editor: selected.editor,
            path: position?.[1] ?? targetPath,
            ...(position ? { line: Number(position[2]), column: Number(position[3] ?? 1) } : {}),
          });
          if (!opened)
            throw new Error(
              "The editor could not open this WSL project. Check the editor's WSL extension and refresh the editor list.",
            );
          destinations.remember(selected);
          return AsyncResult.success(selected.editor);
        } catch (error) {
          return AsyncResult.failure(
            Cause.fail(
              new EditorDestinationLaunchError({
                message:
                  error instanceof Error ? error.message : "Could not open the Windows editor.",
              }),
            ),
          );
        }
      }
      const editor = destinations.active
        ? (selected?.editor ?? null)
        : resolveAndPersistPreferredEditor(availableEditors);
      if (!editor) {
        return AsyncResult.failure(
          Cause.fail(
            new PreferredEditorUnavailableError({
              environmentId,
              targetPath,
              availableEditorIds: availableEditors,
            }),
          ),
        );
      }
      const result = await openInEditor({
        environmentId,
        input: {
          cwd: targetPath,
          editor,
        },
      });
      if (result._tag !== "Failure" && destinations.active && selected)
        destinations.remember(selected);
      return mapAtomCommandResult(result, () => editor);
    },
    [availableEditors, environmentId, openInEditor, destinations],
  );
}
