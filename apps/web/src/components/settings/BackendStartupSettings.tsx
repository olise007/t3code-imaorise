import { useEffect, useState } from "react";
import type { DesktopBridge, DesktopBackendStartupState } from "@t3tools/contracts";
import { Button } from "~/components/ui/button";

export function BackendStartupSettings({ bridge }: { bridge: DesktopBridge }) {
  const [states, setStates] = useState<readonly DesktopBackendStartupState[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await bridge.getBackendStartupStates?.();
        if (active && next) setStates(next);
      } catch {
        if (active) setError("Could not read backend startup status.");
      } finally {
        if (active) timer = setTimeout(refresh, 2000);
      }
    };
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [bridge]);
  return (
    <div aria-live="polite" className="space-y-2">
      {error && <p className="text-sm text-destructive">{error}</p>}
      {states.map(({ id, label, status }) =>
        status ? (
          <div key={id} className="flex items-center justify-between gap-3 px-4 py-2">
            <p className="text-sm text-muted-foreground">
              {label}:{" "}
              {status.diagnostic ??
                (status.phase === "retrying"
                  ? `Retrying on port ${status.port} (${status.attempt}/5)`
                  : status.phase === "running"
                    ? `Running on port ${status.port}`
                    : `Starting on port ${status.port}`)}
            </p>
            {(status.phase === "slow" || status.phase === "failed") && (
              <Button
                size="sm"
                variant="outline"
                disabled={pending !== null}
                onClick={async () => {
                  if (pending !== null) return;
                  setPending(id);
                  setError(null);
                  try {
                    await bridge.retryBackendStartup?.(id);
                  } catch {
                    setError("Backend retry failed. Check startup diagnostics and try again.");
                  } finally {
                    setPending(null);
                  }
                }}
              >
                {pending === id ? "Retrying…" : "Retry"}
              </Button>
            )}
          </div>
        ) : null,
      )}
    </div>
  );
}
