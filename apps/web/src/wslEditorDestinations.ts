import { EditorId, WSL_EDITOR_SCHEMES, type EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useLocalStorage, getLocalStorageItem } from "./hooks/useLocalStorage";
import { useRemoteOpenResolution } from "./remoteOpen";

export const EditorDestinationPreference = Schema.Struct({
  editor: EditorId,
  source: Schema.Literals(["windows", "wsl"]),
});
export type EditorDestinationPreference = typeof EditorDestinationPreference.Type;
export type EditorDestination = EditorDestinationPreference & {
  readonly enabled: boolean;
  readonly reason?: string;
};

/** Keep installations distinct and preserve the backend's original WSL ordering. */
export function combineEditorDestinations(
  wsl: readonly EditorId[],
  windows: readonly EditorId[],
): EditorDestination[] {
  return [
    ...Array.from(new Set(windows))
      .filter((editor) => editor !== "file-manager")
      .map((editor): EditorDestination => ({
        editor,
        source: "windows",
        enabled: WSL_EDITOR_SCHEMES[editor] !== undefined,
        ...(WSL_EDITOR_SCHEMES[editor] ? {} : { reason: "No supported WSL launch integration" }),
      })),
    ...Array.from(new Set(wsl))
      .filter((editor) => editor !== "file-manager")
      .map((editor): EditorDestination => ({ editor, source: "wsl", enabled: true })),
  ];
}

/** Legacy preferences select the WSL command first, matching historical behaviour. */
export function resolveEditorDestination(
  options: readonly EditorDestination[],
  saved: EditorDestinationPreference | null,
  legacy: EditorId | null,
): EditorDestination | null {
  return (
    options.find(
      (option) =>
        option.enabled && option.editor === saved?.editor && option.source === saved?.source,
    ) ??
    options.find(
      (option) => !saved && option.enabled && option.source === "wsl" && option.editor === legacy,
    ) ??
    options.find((option) => option.enabled && option.source === "wsl") ??
    options.find((option) => option.enabled) ??
    null
  );
}

// Share probes across toolbar, markdown and file-menu consumers without polling.
let revision = 0;
const listeners = new Set<() => void>();
const probes = new Map<string, Promise<readonly EditorId[]>>();
const signatures = new Map<string, string>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Combined choices are available only on a desktop with the new optional bridge. */
export function useWslEditorDestinations(
  environmentId: EnvironmentId | null,
  editors: readonly EditorId[],
) {
  const resolution = useRemoteOpenResolution(environmentId);
  const remote = resolution.state;
  const bridge = window.desktopBridge;
  const active =
    remote.mode === "local-wsl" &&
    bridge?.probeLocalEditors !== undefined &&
    bridge.openWslEditor !== undefined;
  const key = active ? `${remote.backendId}:${remote.distro}` : "";
  const editorSignature = `${resolution.connectionPhase ?? ""}:${editors.join(",")}`;
  const version = useSyncExternalStore(subscribe, () => revision);
  const [probe, setProbe] = useState<{
    key: string;
    signature: string;
    version: number;
    editors: readonly EditorId[];
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!active) return;
    if (signatures.get(key) !== editorSignature) {
      probes.delete(key);
      signatures.set(key, editorSignature);
    }
    let cancelled = false;
    let pending = probes.get(key);
    if (!pending) {
      pending = Promise.resolve().then(() => bridge!.probeLocalEditors!());
      probes.set(key, pending);
    }
    pending.then(
      (editors) => {
        if (!cancelled)
          setProbe({ key, signature: editorSignature, version, editors, error: null });
      },
      () => {
        probes.delete(key);
        if (!cancelled)
          setProbe({
            key,
            signature: editorSignature,
            version,
            editors: [],
            error: "Could not detect Windows editors. Refresh to retry.",
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active, bridge, key, version, editorSignature]);
  const current =
    probe?.key === key && probe.version === version && probe.signature === editorSignature
      ? probe
      : null;
  const options = active ? combineEditorDestinations(editors, current?.editors ?? []) : [];
  const [saved, setSaved] = useLocalStorage(
    `t3code:editor-destination:${environmentId ?? "none"}`,
    null,
    EditorDestinationPreference,
  );
  let legacy: EditorId | null = null;
  if (active && !saved) {
    try {
      legacy = getLocalStorageItem("t3code:last-editor", EditorId);
    } catch {
      /* Corrupt legacy preferences must not prevent opening a project. */
    }
  }
  const preferred = resolveEditorDestination(options, saved, legacy);
  const refresh = useCallback(() => {
    probes.delete(key);
    revision++;
    listeners.forEach((listener) => listener());
  }, [key]);
  return {
    active,
    remote,
    options,
    preferred,
    remember: setSaved,
    refresh,
    loading: active && current === null,
    error: current?.error ?? null,
  };
}
