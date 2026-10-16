import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderVersionCatalog,
  ProviderVersionRelease,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogDescription,
} from "../ui/dialog";

export function ProviderVersions({
  environmentId,
  instanceId,
  provider,
  readOnly = false,
}: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  provider: ProviderDriverKind;
  readOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ProviderVersionCatalog | null>(null);
  const [selected, setSelected] = useState<ProviderVersionRelease | null>(null);
  const [prereleases, setPrereleases] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canUpdate = useAtomValue(serverEnvironment.updateProvider.permissionAtom(environmentId));
  const query = useAtomCommand(serverEnvironment.providerVersions, { reportFailure: false });
  const update = useAtomCommand(serverEnvironment.updateProvider, { reportFailure: false });
  async function load(page = 1, includePrereleases = prereleases) {
    setPending(true);
    setError(null);
    setSelected(null);
    setConfirmed(false);
    const result = await query({
      environmentId,
      input: { provider, instanceId, page, prereleases: includePrereleases },
    });
    if (result._tag === "Success") setData(result.value);
    else setError(String(squashAtomCommandFailure(result)));
    setPending(false);
  }
  async function install() {
    if (!selected?.available || !selected.integrity || !confirmed) return;
    setPending(true);
    setError(null);
    const result = await update({
      environmentId,
      input: {
        provider,
        instanceId,
        targetVersion: selected.version,
        expectedIntegrity: selected.integrity,
        allowUnknownCompatibility: selected.compatibility === "unknown",
      },
    });
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    setPending(false);
    if (result._tag === "Success") await load(data?.page ?? 1);
  }
  return (
    <div className="space-y-2 px-3 py-3 sm:px-4">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setOpen(true);
            void load();
          }}
        >
          Check for updates
        </Button>
        <Button
          size="sm"
          variant="ghost-muted"
          onClick={() => {
            setOpen(true);
            if (!data) void load();
          }}
        >
          Choose version
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-h-[85dvh] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Choose {provider} version</DialogTitle>
            <DialogDescription>
              Downloads are verified before activation. Running agents and sign-in flows keep their
              current executable until they finish.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={prereleases}
                  disabled={pending}
                  onChange={(event) => {
                    setPrereleases(event.target.checked);
                    void load(1, event.target.checked);
                  }}
                />
                Show prereleases
              </label>
              {pending ? (
                <p role="status" className="text-sm">
                  Preparing the selected operation… You can close this dialog and check provider
                  status.
                </p>
              ) : null}
              {error ? (
                <p role="alert" className="break-words text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              {data?.message ? (
                <p className="text-sm text-muted-foreground">{data.message}</p>
              ) : null}
              {data ? (
                <p className="text-xs">
                  Affected instances: {data.affectedInstances.join(", ") || instanceId}
                </p>
              ) : null}
              <ul className="max-h-72 space-y-2 overflow-y-auto">
                {data?.releases.map((release) => (
                  <li key={release.version}>
                    <label className="flex items-start gap-2 text-sm">
                      <input
                        type="radio"
                        name={`version-${instanceId}`}
                        checked={selected?.version === release.version}
                        disabled={pending || !release.available}
                        onChange={() => {
                          setSelected(release);
                          setConfirmed(false);
                        }}
                      />
                      <span>
                        <span className="font-medium">{release.version}</span> · {release.channel} ·{" "}
                        {release.compatibility}
                        {data.installedVersion === release.version ? " · Installed" : ""}
                        {data.selectedVersion === release.version ? " · Selected" : ""}
                        {release.latestStable ? " · Latest stable" : ""}
                        {release.recommended ? " · Recommended" : ""}
                        {release.releasedAt ? (
                          <span className="block text-xs text-muted-foreground">
                            {new Date(release.releasedAt).toLocaleDateString()}
                          </span>
                        ) : null}
                        {release.reason ? (
                          <span className="block text-xs text-muted-foreground">
                            {release.reason}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="flex items-center justify-between gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || !data || data.page <= 1}
                  onClick={() => void load((data?.page ?? 1) - 1)}
                >
                  Previous 50
                </Button>
                <span className="text-xs">Page {data?.page ?? 1}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || !data?.hasMore}
                  onClick={() => void load((data?.page ?? 1) + 1)}
                >
                  Next 50
                </Button>
              </div>
              {selected ? (
                <div className="space-y-2 text-xs">
                  <p className="break-all">Source: {selected.source}</p>
                  <p className="break-all">Integrity: {selected.integrity}</p>
                  {selected.dependencies?.map((dependency) => (
                    <p key={dependency.name} className="break-all">
                      Dependency: {dependency.name} {dependency.version} · {dependency.source} ·{" "}
                      {dependency.integrity}
                    </p>
                  ))}
                  {selected.compatibility === "unknown" ? (
                    <p className="text-warning">
                      Compatibility with this T3 Code release has not been verified. Choosing this
                      release may prevent agents from starting.
                    </p>
                  ) : null}
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      disabled={pending}
                      onChange={(event) => setConfirmed(event.target.checked)}
                    />
                    I approve installing this exact version for the listed instances
                    {selected.compatibility === "unknown"
                      ? " and accept its unknown compatibility"
                      : ""}
                    .
                  </label>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending || readOnly || !canUpdate || !confirmed}
                    onClick={() => void install()}
                  >
                    Install {selected.version}
                  </Button>
                </div>
              ) : null}
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
