import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom } from "../../state/preferences";
import { resolveLegacyPlanModeEnabled } from "../../state/legacy-plan-mode";

/** Plan controls are ready once device preferences load; old toggle values cannot hide them. */
export function useLegacyPlanModeState(): { readonly enabled: boolean; readonly loaded: boolean } {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferences);
  return {
    enabled: resolveLegacyPlanModeEnabled({
      loaded,
      preference: loaded ? preferences.value.planModeEnabled : undefined,
    }),
    loaded,
  };
}
