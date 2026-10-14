import {
  AuthPreviewOperateScope,
  type BrowserProfile,
  type PreviewViewportSetting,
} from "@t3tools/contracts";
import { useEffect } from "react";

import { useClientSettings, useClientSettingsHydrated } from "~/hooks/useSettings";
import { useServerConfigs } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentsWithScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

const selectProfiles = (settings: { readonly browserProfiles: ReadonlyArray<BrowserProfile> }) =>
  settings.browserProfiles;
const selectDefaultProfileId = (settings: { readonly browserDefaultProfileId: string }) =>
  settings.browserDefaultProfileId;
const selectDefaultViewport = (settings: {
  readonly browserDefaultViewport: PreviewViewportSetting;
}) => settings.browserDefaultViewport;

/**
 * Tells each environment that hosts browser tabs which profiles this client
 * has, plus its default viewport, so agent opens honor these preferences.
 * These preferences live in client settings; the server keeps the latest report in memory. A reconnect brings a new
 * server config, which sends the report again.
 */
export function BrowserProfileReporter() {
  const hydrated = useClientSettingsHydrated();
  const profiles = useClientSettings(selectProfiles);
  const defaultProfileId = useClientSettings(selectDefaultProfileId);
  const defaultViewport = useClientSettings(selectDefaultViewport);
  const { environments } = useEnvironments();
  const serverConfigs = useServerConfigs();
  const operable = useEnvironmentsWithScope(environments, AuthPreviewOperateScope);
  const report = useAtomCommand(previewEnvironment.reportProfiles, { reportFailure: false });

  useEffect(() => {
    if (!hydrated) return;
    for (const [environmentId, config] of serverConfigs) {
      if (!config.environment.capabilities.serverBrowser || !operable.has(environmentId)) continue;
      void report({ environmentId, input: { profiles, defaultProfileId, defaultViewport } });
    }
  }, [defaultProfileId, defaultViewport, hydrated, operable, profiles, report, serverConfigs]);

  return null;
}
