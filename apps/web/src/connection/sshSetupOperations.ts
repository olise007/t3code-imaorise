import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import { sshServerLifecycle } from "./sshServerLifecycle";
import { sshSetupProgress, sshSetupTargetKey } from "./sshSetupProgress";

/** Cancellation and removal serialize by the complete SSH source/profile identity. */
export function createSshSetupOperations(
  forget: (environmentId: string, targets: readonly DesktopSshEnvironmentTarget[]) => void,
) {
  const active = new Map<string, { id: string; cancel: () => Promise<unknown> }>();
  const removing = new Set<string>();
  const cancel = async (target: DesktopSshEnvironmentTarget, operationId?: string) => {
    const current = active.get(sshSetupTargetKey(target));
    if (current && (operationId === undefined || current.id === operationId))
      await current.cancel();
  };
  return {
    isRemoving: (target: DesktopSshEnvironmentTarget) => removing.has(sshSetupTargetKey(target)),
    register: (target: DesktopSshEnvironmentTarget, id: string, cancel: () => Promise<unknown>) => {
      const key = sshSetupTargetKey(target);
      if (removing.has(key) || active.has(key)) return false;
      active.set(key, { id, cancel });
      return true;
    },
    end: (target: DesktopSshEnvironmentTarget, id: string) => {
      const key = sshSetupTargetKey(target);
      if (active.get(key)?.id === id) active.delete(key);
    },
    cancel,
    remove: async (
      environmentId: string,
      targets: readonly DesktopSshEnvironmentTarget[],
      remove: () => Promise<boolean>,
    ) => {
      const keys = targets.map(sshSetupTargetKey);
      if (keys.some((key) => removing.has(key)))
        throw new Error("Connection removal is already in progress.");
      for (const key of keys) removing.add(key);
      try {
        await Promise.all(targets.map((target) => cancel(target)));
        if (await remove()) forget(environmentId, targets);
      } finally {
        for (const key of keys) removing.delete(key);
      }
    },
  };
}

export const sshSetupOperations = createSshSetupOperations((environmentId, targets) => {
  sshSetupProgress.forgetEnvironment(environmentId, targets);
  sshServerLifecycle.forgetEnvironment(environmentId, targets);
});
