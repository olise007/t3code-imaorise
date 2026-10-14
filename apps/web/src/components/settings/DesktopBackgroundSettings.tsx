import { useEffect, useState } from "react";
import type { DesktopBackgroundSettings as BackgroundSettings } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

import { isWindowsPlatform } from "~/lib/utils";
import { searchableSetting } from "./settingsSearch";
function useDesktopBackgroundSettings() {
  const bridge = window.desktopBridge;
  const [settings, setSettings] = useState<BackgroundSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!bridge?.getBackgroundSettings) return;
    let active = true;
    void bridge
      .getBackgroundSettings()
      .then((settings) => {
        if (active) setSettings(settings);
      })
      .catch(() => {
        if (active) setError("Could not load background settings.");
      });
    return () => {
      active = false;
    };
  }, [bridge]);
  const save = async (change: Partial<BackgroundSettings>) => {
    if (!bridge?.setBackgroundSettings || !settings || busy) return;
    setBusy(true);
    setError(null);
    try {
      setSettings(await bridge.setBackgroundSettings({ distro: settings.distro, ...change }));
    } catch {
      setError("Could not save background settings. Retry.");
    } finally {
      setBusy(false);
    }
  };
  return { bridge, settings, busy, error, setBusy, setError, setSettings, save };
}
export function DesktopBackgroundSettings(props: { wslEnabled: boolean }) {
  const { bridge, settings, busy, error, setBusy, setError, setSettings, save } =
    useDesktopBackgroundSettings();
  if (!bridge?.getBackgroundSettings) return null;
  if (!settings)
    return error ? (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    ) : null;
  return (
    <>
      <SettingsRow
        {...searchableSetting("wsl-agent-persistence")}
        description={`Applies to ${settings.distro}. Closing Desktop leaves agents and tools running in WSL. Changes apply on the next exit.`}
        control={
          <Switch
            aria-label="Keep agents running when T3 closes"
            checked={settings.keepAgentsRunning}
            disabled={busy}
            onCheckedChange={(keepAgentsRunning) => void save({ keepAgentsRunning })}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("wsl-background-server")}
        description="Stop shuts down this environment's agents and tools. Start reconnects to an existing server when available."
        status={
          error ? (
            <span role="alert" className="text-destructive">
              {error}
            </span>
          ) : settings.serverRunning ? (
            "Running"
          ) : (
            "Stopped or connecting"
          )
        }
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !props.wslEnabled}
            onClick={() => {
              if (!bridge.setBackgroundServerRunning) return;
              setBusy(true);
              setError(null);
              void bridge
                .setBackgroundServerRunning(!settings.serverRunning)
                .then(setSettings)
                .catch(() => setError("Could not change server state. Retry."))
                .finally(() => setBusy(false));
            }}
          >
            {settings.serverRunning ? "Stop background server" : "Start background server"}
          </Button>
        }
      />
    </>
  );
}

export function DesktopTraySettings() {
  const { bridge, settings, busy, error, save } = useDesktopBackgroundSettings();
  if (!bridge?.getBackgroundSettings || !isWindowsPlatform(navigator.platform)) return null;
  if (!settings) return error ? <p role="alert">{error}</p> : null;
  return (
    <>
      {" "}
      <SettingsRow
        {...searchableSetting("close-to-tray")}
        description="Keep the app in the tray when you close its window. Windows only."
        control={
          <Switch
            aria-label="Close to system tray"
            checked={settings.closeToTray}
            disabled={busy}
            onCheckedChange={(closeToTray) => void save({ closeToTray })}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("minimize-to-tray")}
        description="Hide the minimized window from the taskbar. Windows only."
        control={
          <Switch
            aria-label="Minimize to system tray"
            checked={settings.minimizeToTray}
            disabled={busy}
            onCheckedChange={(minimizeToTray) => void save({ minimizeToTray })}
          />
        }
      />
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
