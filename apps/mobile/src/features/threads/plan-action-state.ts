// Card and composer share a lock; the server projection remains authoritative.
const states = new Map<string, "busy" | "submitted">();
const listeners = new Set<() => void>();
const composerFocus = new Map<string, () => void>();
export const planActionStatus = (key: string) => states.get(key) ?? "idle";
export function subscribePlanActions(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function beginPlanAction(key: string) {
  if (states.has(key)) return false;
  states.set(key, "busy");
  listeners.forEach((listener) => listener());
  return true;
}
export function finishPlanAction(key: string, succeeded: boolean) {
  if (succeeded) states.set(key, "submitted");
  else states.delete(key);
  listeners.forEach((listener) => listener());
}
export function registerPlanComposer(environmentId: string, threadId: string, focus: () => void) {
  const key = `${environmentId}:${threadId}`;
  composerFocus.set(key, focus);
  return () => {
    if (composerFocus.get(key) === focus) composerFocus.delete(key);
  };
}
export function focusPlanComposer(environmentId: string, threadId: string) {
  composerFocus.get(`${environmentId}:${threadId}`)?.();
}
