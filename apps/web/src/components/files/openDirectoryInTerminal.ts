import type {
  ContextMenuItem,
  ProjectEntry,
  ScopedThreadRef,
  TerminalOpenInput,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { resolveFileContextMenuAbsolutePath } from "~/fileContextMenu";
import { useTerminalUiStateStore } from "~/terminalUiStateStore";

export function directoryTerminalMenuItems(
  kind: ProjectEntry["kind"] | undefined,
  available: boolean,
): ContextMenuItem[] {
  return kind === "directory"
    ? [{ id: "open-in-terminal", label: "Open in terminal", disabled: !available }]
    : [];
}

/** Opens on the directory's host; paths are RPC data, never shell commands. */
export async function openDirectoryInTerminal<A, E>(input: {
  threadRef: ScopedThreadRef;
  workspaceRoot: string;
  relativePath: string;
  terminalId: string;
  worktreePath?: string | null;
  env?: TerminalOpenInput["env"];
  canOpen: () => boolean;
  open: (request: {
    environmentId: ScopedThreadRef["environmentId"];
    input: TerminalOpenInput;
  }) => Promise<AtomCommandResult<A, E>>;
  focus: () => void;
}): Promise<void> {
  if (!input.canOpen()) throw new Error("Terminal access is unavailable for this environment.");
  const cwd = resolveFileContextMenuAbsolutePath({
    environmentId: input.threadRef.environmentId,
    filePath: input.relativePath,
    workspaceRoot: input.workspaceRoot,
  });
  if (cwd === null)
    throw new Error("The selected directory could not be resolved in this workspace.");
  const result = await input.open({
    environmentId: input.threadRef.environmentId,
    input: {
      threadId: input.threadRef.threadId,
      terminalId: input.terminalId,
      cwd,
      ...(input.worktreePath == null ? {} : { worktreePath: input.worktreePath }),
      ...(input.env === undefined ? {} : { env: input.env }),
    },
  });
  if (result._tag === "Failure") {
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    throw new Error(
      failure instanceof Error
        ? failure.message
        : "The terminal could not be opened. Check the directory and environment connection.",
    );
  }
  useTerminalUiStateStore.getState().newTerminal(input.threadRef, input.terminalId);
  input.focus();
}
