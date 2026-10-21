import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId } from "@t3tools/contracts";
import Constants from "expo-constants";
import * as Option from "effect/Option";
import { useEffect, useMemo, useState } from "react";
import { AppState } from "react-native";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { environmentServerConfigsAtom } from "../../state/server";
import { usePreparedConnection } from "../../state/session";
import {
  refreshDirectAlerts,
  supportsDirectAlerts,
  syncDirectAlertTargets,
  useDirectAlerts,
} from "./directAlerts";
import { directAlertTarget } from "./directAlertTarget";

function DirectTarget({
  environmentId,
  allowed,
  active,
  supported,
}: {
  environmentId: EnvironmentId;
  allowed: string[];
  active: boolean;
  supported: boolean;
}) {
  const prepared = usePreparedConnection(environmentId);
  const preferences = useDirectAlerts();
  useEffect(() => {
    if (
      !active ||
      Option.isNone(prepared) ||
      !preferences.enabled ||
      !preferences.selectedIds.includes(environmentId)
    )
      return;
    const scheme = Constants.expoConfig?.scheme;
    const target = directAlertTarget(
      prepared.value,
      supported,
      (Array.isArray(scheme) ? scheme[0] : scheme) ?? "t3code-imaorise",
    );
    if (target) syncDirectAlertTargets(allowed, [target]);
  }, [
    environmentId,
    prepared,
    preferences.enabled,
    preferences.selectedIds,
    allowed,
    active,
    supported,
  ]);
  return null;
}

export function DirectAlertsCoordinator() {
  const { isLoadingSavedConnection } = useSavedRemoteConnections();
  const environments = useWorkspaceEnvironments();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const preferences = useDirectAlerts();
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    refreshDirectAlerts();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refreshDirectAlerts();
      setActive(state === "active");
    });
    return () => subscription.remove();
  }, []);
  const allowed = useMemo(
    () =>
      environments
        .filter((environment) => {
          const config = configs.get(environment.environmentId);
          return (
            environment.isEnabled &&
            !environment.isRelayManaged &&
            (!config || config.environment.capabilities.directAgentActivity === true)
          );
        })
        .map((environment) => environment.environmentId),
    [environments, configs],
  );
  useEffect(() => {
    if (!isLoadingSavedConnection && active) syncDirectAlertTargets(allowed, []);
  }, [isLoadingSavedConnection, active, allowed, preferences.enabled, preferences.selectedIds]);
  if (!supportsDirectAlerts || isLoadingSavedConnection) return null;
  return allowed.map((environmentId) => (
    <DirectTarget
      key={environmentId}
      environmentId={environmentId}
      allowed={allowed}
      active={active}
      supported={configs.get(environmentId)?.environment.capabilities.directAgentActivity === true}
    />
  ));
}
