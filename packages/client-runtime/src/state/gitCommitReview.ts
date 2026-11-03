import { Atom } from "effect/reactivity";
import type {
  EnvironmentId,
  GitCommitContext,
  GitRunStackedActionResult,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

export interface GitCommitReviewTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadId?: ThreadId;
  readonly projectId?: ProjectId;
}

/** Keep abandoned messages with the original environment/thread/worktree. */
export const gitCommitDraft = Atom.family((_scope: string) => Atom.make("").pipe(Atom.keepAlive));
export const gitCommitReviewScope = (target: {
  readonly environmentId: string | null;
  readonly cwd: string | null;
  readonly threadId?: string | undefined;
  readonly projectId?: string | undefined;
}) =>
  JSON.stringify([
    target.environmentId,
    target.projectId ?? null,
    target.threadId ?? null,
    target.cwd,
  ]);

export function commitContextMatchesFiles(
  context: GitCommitContext,
  GitRunStackedActionResult,
  filePaths: ReadonlyArray<string>,
) {
  return JSON.stringify([...filePaths].sort()) === JSON.stringify(context.filePaths);
}

/** Commit feedback names the worktree that actually received the commit. */
export function gitCommitSuccessDescription(result: GitRunStackedActionResult) {
  const context = result.commitContext;
  if (!context || result.commit.status !== "created") return result.toast.description;
  return `${context.repositoryRoot} · ${context.branch ?? "Detached HEAD"} · ${result.commit.commitSha}\n${result.toast.description ?? ""}`;
}
