import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  AuthOrchestrationOperateScope,
  buildRemoteOpenUrl,
  EditorId,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { isOpenFavoriteEditorShortcut, shortcutLabelForCommand } from "../../keybindings";
import { usePreferredEditor, useOpenInPreferredEditor } from "../../editorPreferences";
import { useWslEditorDestinations } from "../../wslEditorDestinations";
import { toastManager } from "../ui/toast";
import { editorLabelForPlatform } from "../../editorLabels";
import {
  openRemoteEditorUrl,
  useRemoteCapableEditors,
  useRemoteOpenHint,
  useRemoteOpenState,
} from "../../remoteOpen";
import { useEnvironment } from "../../state/environments";
import { ChevronDownIcon, FolderClosedIcon, SquareArrowOutUpRightIcon } from "lucide-react";

import { Group, GroupSeparator } from "../ui/group";
import {
  Menu,
  MenuItem,
  MenuItemLabel,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuShortcut,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
  MenuTrigger,
} from "../ui/menu";
import {
  AntigravityIcon,
  CursorIcon,
  FileExplorerIcon,
  FinderIcon,
  Icon,
  KiroIcon,
  TraeIcon,
  VisualStudioCode,
  VisualStudioCodeInsiders,
  VSCodium,
  Zed,
} from "../Icons";
import {
  AquaIcon,
  CLionIcon,
  DataGripIcon,
  DataSpellIcon,
  GoLandIcon,
  IntelliJIdeaIcon,
  PhpStormIcon,
  PyCharmIcon,
  RiderIcon,
  RubyMineIcon,
  RustRoverIcon,
  WebStormIcon,
} from "../JetBrainsIcons";
import { cn, isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useComposerMenuState } from "./useComposerMenuState";

type OpenInOption = {
  label: string;
  Icon: Icon;
  value: EditorId;
  kind: "brand" | "generic";
};

export const resolveOpenInOptions = (
  platform: string,
  availableEditors: ReadonlyArray<EditorId>,
) => {
  const baseOptions: ReadonlyArray<Omit<OpenInOption, "label">> = [
    {
      Icon: CursorIcon,
      value: "cursor",
      kind: "brand",
    },
    {
      Icon: TraeIcon,
      value: "trae",
      kind: "brand",
    },
    {
      Icon: KiroIcon,
      value: "kiro",
      kind: "brand",
    },
    {
      Icon: VisualStudioCode,
      value: "vscode",
      kind: "brand",
    },
    {
      Icon: VisualStudioCodeInsiders,
      value: "vscode-insiders",
      kind: "brand",
    },
    {
      Icon: VSCodium,
      value: "vscodium",
      kind: "brand",
    },
    {
      Icon: Zed,
      value: "zed",
      kind: "brand",
    },
    {
      Icon: AntigravityIcon,
      value: "antigravity",
      kind: "brand",
    },
    {
      Icon: IntelliJIdeaIcon,
      value: "idea",
      kind: "brand",
    },
    {
      Icon: AquaIcon,
      value: "aqua",
      kind: "brand",
    },
    {
      Icon: CLionIcon,
      value: "clion",
      kind: "brand",
    },
    {
      Icon: DataGripIcon,
      value: "datagrip",
      kind: "brand",
    },
    {
      Icon: DataSpellIcon,
      value: "dataspell",
      kind: "brand",
    },
    {
      Icon: GoLandIcon,
      value: "goland",
      kind: "brand",
    },
    {
      Icon: PhpStormIcon,
      value: "phpstorm",
      kind: "brand",
    },
    {
      Icon: PyCharmIcon,
      value: "pycharm",
      kind: "brand",
    },
    {
      Icon: RiderIcon,
      value: "rider",
      kind: "brand",
    },
    {
      Icon: RubyMineIcon,
      value: "rubymine",
      kind: "brand",
    },
    {
      Icon: RustRoverIcon,
      value: "rustrover",
      kind: "brand",
    },
    {
      Icon: WebStormIcon,
      value: "webstorm",
      kind: "brand",
    },
    {
      Icon: isMacPlatform(platform)
        ? FinderIcon
        : isWindowsPlatform(platform)
          ? FileExplorerIcon
          : FolderClosedIcon,
      value: "file-manager",
      kind: isMacPlatform(platform) || isWindowsPlatform(platform) ? "brand" : "generic",
    },
  ];
  const availableEditorSet = new Set(availableEditors);
  return baseOptions
    .filter((option) => availableEditorSet.has(option.value))
    .map((option) => ({ ...option, label: editorLabelForPlatform(option.value, platform) }));
};

function getOpenInIconClass(kind: OpenInOption["kind"]) {
  return cn(kind === "brand" ? "text-foreground opacity-100" : "text-muted-foreground");
}

export const OpenInPicker = memo(function OpenInPicker({
  environmentId,
  keybindings,
  availableEditors,
  openInCwd,
  presentation = "toolbar",
  compact = false,
  enableShortcut = true,
  displayMode = "toolbar",
}: {
  environmentId: EnvironmentId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
  presentation?: "toolbar" | "menu";
  compact?: boolean;
  enableShortcut?: boolean;
  displayMode?: "toolbar" | "panel";
}) {
  const isPanel = displayMode === "panel";
  const ActionGroup = isPanel ? "div" : Group;
  const panelAnchorRef = useRef<HTMLDivElement | null>(null);
  const openInEditorMutation = useAtomCommand(shellEnvironment.openInEditor, "open in editor");
  const remote = useRemoteOpenState(environmentId);
  const canOperateHost = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const isHostEditorDenied =
    (remote.mode === "local-exec" || remote.mode === "local-wsl") && !canOperateHost;
  const canOpenEditor = remote.mode !== "remote-unavailable" && !isHostEditorDenied;
  const [menuOpen, setMenuOpen] = useComposerMenuState(isHostEditorDenied);
  const remoteCapableEditors = useRemoteCapableEditors();
  const [remoteHintSeen, markRemoteHintSeen] = useRemoteOpenHint();
  const environmentLabel = useEnvironment(environmentId)?.label ?? "this machine";
  // Remote mode ignores the server's PATH probe: what matters is what runs on
  // the viewing machine, which only the desktop app can probe.
  const effectiveEditors =
    remote.mode === "local-exec" || remote.mode === "local-wsl"
      ? availableEditors
      : remoteCapableEditors;
  const wsl = useWslEditorDestinations(environmentId, availableEditors);
  const launchDestination = useOpenInPreferredEditor(environmentId, availableEditors);
  const [legacyPreferredEditor, setPreferredEditor] = usePreferredEditor(effectiveEditors);
  const preferredEditor = wsl.active ? (wsl.preferred?.editor ?? null) : legacyPreferredEditor;
  const options = useMemo(
    () =>
      wsl.active
        ? wsl.options.flatMap((destination) => {
            const option = resolveOpenInOptions(
              destination.source === "windows" ? "Win32" : "Linux",
              [destination.editor],
            )[0];
            return option
              ? [
                  {
                    ...option,
                    source: destination.source,
                    enabled: destination.enabled,
                    reason: destination.reason,
                  },
                ]
              : [];
          })
        : resolveOpenInOptions(navigator.platform, effectiveEditors).map((option) => ({
            ...option,
            source: "wsl" as const,
            enabled: true,
            reason: undefined,
          })),
    [effectiveEditors, wsl.active, wsl.options],
  );
  const primaryOption =
    options.find(
      ({ value, source }) =>
        value === preferredEditor && (!wsl.active || source === wsl.preferred?.source),
    ) ?? null;

  const openInEditor = useCallback(
    (editorId: EditorId | null, source?: "windows" | "wsl") => {
      if (!openInCwd) return;
      const editor = editorId ?? preferredEditor;
      if (!editor) return;
      if (wsl.active) {
        void launchDestination(openInCwd, {
          editor,
          source: source ?? wsl.preferred?.source ?? "wsl",
        }).then((result) => {
          if (result._tag === "Failure")
            toastManager.add({
              type: "error",
              title: "Could not open editor",
              description: "Check the editor's WSL integration and refresh the editor list.",
            });
        });
        return;
      }
      if (remote.mode === "remote-unavailable") return;
      if (remote.mode === "remote-links") {
        const url = buildRemoteOpenUrl({
          editor,
          host: remote.host.host,
          absolutePath: openInCwd,
        });
        if (url === undefined) return;
        // Only record hint-seen/preferred when the shell actually accepted
        // the URL (an older desktop build can refuse the editor scheme).
        void openRemoteEditorUrl(url).then((opened) => {
          if (!opened) return;
          markRemoteHintSeen();
          setPreferredEditor(editor);
        });
        return;
      }
      if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
      const result = openInEditorMutation({
        environmentId,
        input: {
          cwd: openInCwd,
          editor,
        },
      });
      setPreferredEditor(editor);
      return result;
    },
    [
      environmentId,
      markRemoteHintSeen,
      openInCwd,
      openInEditorMutation,
      preferredEditor,
      remote,
      setPreferredEditor,
      wsl,
      launchDestination,
    ],
  );

  const openFavoriteEditorShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  useEffect(() => {
    if (!enableShortcut || !canOpenEditor) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if (!isOpenFavoriteEditorShortcut(e, keybindings)) return;
      if (!openInCwd) return;
      if (!preferredEditor) return;
      if (
        (remote.mode === "local-exec" || remote.mode === "local-wsl") &&
        !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
      )
        return;

      e.preventDefault();
      void openInEditor(preferredEditor);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    canOpenEditor,
    enableShortcut,
    environmentId,
    keybindings,
    openInCwd,
    openInEditor,
    preferredEditor,
    remote.mode,
  ]);
  const selectedLabel = primaryOption
    ? `${primaryOption.label}${wsl.active ? ` · ${primaryOption.source === "windows" ? "Windows" : wsl.remote.mode === "local-wsl" ? wsl.remote.distro : "WSL"}` : ""}`
    : "editor";
  const primaryLabel = isPanel ? `Open in ${selectedLabel}` : "Open";

  const editorItems = (
    <>
      {remote.mode === "remote-unavailable" ? (
        <MenuItem density={presentation === "menu" ? "touch" : "default"} disabled>
          No SSH route to {environmentLabel}
        </MenuItem>
      ) : (
        <>
          {options.length === 0 && !wsl.loading && (
            <MenuItem density={presentation === "menu" ? "touch" : "default"} disabled>
              No installed editors found
            </MenuItem>
          )}
          {(wsl.active ? (["windows", "wsl"] as const) : (["wsl"] as const)).map((group) => (
            <MenuGroup key={group}>
              {wsl.active && (
                <MenuGroupLabel>
                  {group === "windows"
                    ? "Windows"
                    : `WSL · ${wsl.remote.mode === "local-wsl" ? wsl.remote.distro : ""}`}
                </MenuGroupLabel>
              )}
              {wsl.active &&
                !options.some((option) => option.source === group) &&
                !(group === "windows" && wsl.loading) && (
                  <MenuItem disabled>
                    No {group === "windows" ? "Windows" : "WSL"} editors detected
                  </MenuItem>
                )}
              {options
                .filter((option) => option.source === group)
                .map(({ label, Icon, value, kind, source, enabled, reason }) => (
                  <MenuItem
                    density={presentation === "menu" ? "touch" : "default"}
                    disabled={!openInCwd || !canOpenEditor || !enabled}
                    key={`${source}:${value}`}
                    title={reason}
                    onClick={() => openInEditor(value, source)}
                  >
                    <Icon aria-hidden="true" className={getOpenInIconClass(kind)} />
                    <MenuItemLabel>
                      {label}
                      {reason ? ` — ${reason}` : ""}
                    </MenuItemLabel>
                    {value === preferredEditor &&
                      (!wsl.active || source === wsl.preferred?.source) &&
                      openFavoriteEditorShortcutLabel && (
                        <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
                      )}
                  </MenuItem>
                ))}
            </MenuGroup>
          ))}
          {wsl.active && (
            <>
              {wsl.loading && <MenuItem disabled>Detecting Windows editors…</MenuItem>}
              {wsl.error && <MenuItem disabled>{wsl.error}</MenuItem>}
              {availableEditors.includes("file-manager") && (
                <MenuItem
                  disabled={!openInCwd || !canOpenEditor}
                  onClick={() => {
                    if (openInCwd)
                      void openInEditorMutation({
                        environmentId,
                        input: { editor: "file-manager", cwd: openInCwd },
                      });
                  }}
                >
                  Open in file manager
                </MenuItem>
              )}
              <MenuItem onClick={() => wsl.refresh()}>Refresh editors</MenuItem>
            </>
          )}
          {remote.mode === "remote-links" && !remoteHintSeen && (
            <MenuItem density={presentation === "menu" ? "touch" : "default"} disabled>
              Opens over SSH. Needs your key on {environmentLabel}
            </MenuItem>
          )}
        </>
      )}
    </>
  );
  if (presentation === "menu") {
    return (
      <>
        {primaryOption && (
          <MenuItem
            density={presentation === "menu" ? "touch" : "default"}

            disabled={!openInCwd || !canOpenEditor}
            onClick={() => openInEditor(preferredEditor)}
          >
            <primaryOption.Icon className={cn("size-4", getOpenInIconClass(primaryOption.kind))} />
            <MenuItemLabel>Open in {selectedLabel}</MenuItemLabel>
            {openFavoriteEditorShortcutLabel && (
              <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
            )}
          </MenuItem>
        )}
        <MenuSub>
          <MenuSubTrigger density="touch" disabled={isHostEditorDenied}>
            <SquareArrowOutUpRightIcon className="size-4" />
            <MenuItemLabel>Open in…</MenuItemLabel>
          </MenuSubTrigger>
          <MenuSubPopup>{editorItems}</MenuSubPopup>
        </MenuSub>
      </>
    );
  }

  return (
    <ActionGroup
      aria-label="Open in editor"
      role="group"
      {...(isPanel
        ? { className: THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS, ref: panelAnchorRef }
        : {})}
    >
      <ThreadDetailsControl
        aria-label={compact ? "Open file in preferred editor" : primaryLabel}
        title={`Open in ${selectedLabel}`}
        size={isPanel ? "sm" : "xs"}
        variant={isPanel ? "ghost" : "outline"}
        part="primary"
        panel={isPanel}
        disabled={!preferredEditor || !openInCwd || !canOpenEditor}
        onClick={() => openInEditor(preferredEditor)}
      >
        {primaryOption?.Icon ? (
          <primaryOption.Icon
            aria-hidden="true"
            className={cn(
              isPanel ? THREAD_DETAILS_PANEL_ICON_CLASS : "size-3.5",
              getOpenInIconClass(primaryOption.kind),
            )}
          />
        ) : isPanel ? (
          <SquareArrowOutUpRightIcon
            aria-hidden="true"
            className={THREAD_DETAILS_PANEL_ICON_CLASS}
          />
        ) : null}
        <span
          className={cn(
            compact
              ? "sr-only"
              : "sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5",
            isPanel && cn("not-sr-only ml-0 min-w-0 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS),
          )}
        >
          {primaryLabel}
        </span>
      </ThreadDetailsControl>
      {isPanel ? (
        <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
      ) : (
        <GroupSeparator {...(!compact ? { className: "hidden @3xl/header-actions:block" } : {})} />
      )}
      <Menu open={menuOpen} onOpenChange={setMenuOpen}>
        <MenuTrigger
          disabled={isHostEditorDenied}
          render={
            <ThreadDetailsControl
              aria-label="Choose editor"
              size={isPanel ? "sm" : "icon-xs"}
              variant={isPanel ? "ghost" : "outline"}
              part="secondary"
              panel={isPanel}
            />
          }
        >
          <ChevronDownIcon
            aria-hidden="true"
            className={isPanel ? THREAD_DETAILS_PANEL_CHEVRON_CLASS : "size-4"}
          />
        </MenuTrigger>
        <MenuPopup
          align="end"
          {...(isPanel ? { anchor: panelAnchorRef } : {})}
          className={isPanel ? "w-(--anchor-width)" : undefined}
        >
          {editorItems}
        </MenuPopup>
      </Menu>
    </ActionGroup>
  );
});
