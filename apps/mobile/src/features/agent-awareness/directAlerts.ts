import { requireOptionalNativeModule } from "expo";
import { AppState, Platform } from "react-native";
import { useSyncExternalStore } from "react";

interface NativeDirectAlerts {
  getDirectState(): string;
  setDirectSelection(enabled: boolean, ids: string): void;
  syncDirectTargets(allowed: string, updates: string): void;
  openDirectBatterySettings(): void;
}
export interface DirectAlertTarget {
  environmentId: string;
  url: string;
  token: string;
  scheme: string;
}
interface DirectAlertState {
  enabled: boolean;
  selectedIds: string[];
  running: boolean;
  statuses: Record<string, string>;
}
const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<NativeDirectAlerts>("T3AgentNotifications")
    : null;
export const supportsDirectAlerts = typeof native?.getDirectState === "function";
let state: DirectAlertState = { enabled: false, selectedIds: [], running: false, statuses: {} };
const listeners = new Set<() => void>();
export function refreshDirectAlerts(): void {
  if (!supportsDirectAlerts) return;
  const next = JSON.parse(native!.getDirectState()) as DirectAlertState;
  if (JSON.stringify(next) !== JSON.stringify(state)) {
    state = next;
    listeners.forEach((listener) => listener());
  }
}
export function useDirectAlerts(): DirectAlertState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}
export function setDirectAlertSelection(enabled: boolean, ids: string[]): void {
  if (AppState.currentState !== "active") throw new Error("Open T3 to change background alerts.");
  native?.setDirectSelection(enabled, JSON.stringify(ids));
  refreshDirectAlerts();
}
export function syncDirectAlertTargets(allowed: string[], targets: DirectAlertTarget[]): void {
  if (!supportsDirectAlerts || AppState.currentState !== "active") return;
  try {
    native!.syncDirectTargets(JSON.stringify(allowed), JSON.stringify(targets));
  } catch {
    state = {
      ...state,
      statuses: {
        ...state.statuses,
        setup: "Could not start alerts. Turn alerts off and on while T3 is open.",
      },
    };
    listeners.forEach((listener) => listener());
  }
}
export function openDirectBatterySettings(): void {
  native?.openDirectBatterySettings();
}
