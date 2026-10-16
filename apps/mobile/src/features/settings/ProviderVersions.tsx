import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Alert, Modal, ScrollView, View } from "react-native";
import type {
  EnvironmentId,
  ProviderVersionCatalog,
  ServerProvider,
  ProviderVersionRelease,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AppText as Text } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";

export function ProviderVersions({
  environmentId,
  provider,
}: {
  environmentId: EnvironmentId;
  provider: ServerProvider;
}) {
  const [open, setOpen] = useState(false);
  const [prereleases, setPrereleases] = useState(false);
  const [data, setData] = useState<ProviderVersionCatalog | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowed = useAtomValue(serverEnvironment.updateProvider.permissionAtom(environmentId));
  const query = useAtomCommand(serverEnvironment.providerVersions, { reportFailure: false });
  const update = useAtomCommand(serverEnvironment.updateProvider, { reportFailure: false });
  async function load(page = 1, includePrereleases = prereleases) {
    setPending(true);
    setError(null);
    const result = await query({
      environmentId,
      input: {
        provider: provider.driver,
        instanceId: provider.instanceId,
        page,
        prereleases: includePrereleases,
      },
    });
    if (result._tag === "Success") setData(result.value);
    else setError(String(squashAtomCommandFailure(result)));
    setPending(false);
  }
  async function install(release: ProviderVersionRelease) {
    if (!allowed || !release.available || !release.integrity) return;
    setPending(true);
    setError(null);
    const result = await update({
      environmentId,
      input: {
        provider: provider.driver,
        instanceId: provider.instanceId,
        targetVersion: release.version,
        expectedIntegrity: release.integrity,
        allowUnknownCompatibility: release.compatibility === "unknown",
      },
    });
    if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
    setPending(false);
    if (result._tag === "Success") await load(data?.page ?? 1);
  }
  return (
    <>
      <SettingsActionRow
        icon="arrow.down.circle"
        label={`${provider.displayName || provider.driver} · Choose version / Check for updates`}
        onPress={() => {
          setOpen(true);
          void load();
        }}
      />
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <ScrollView
          className="flex-1 bg-background"
          contentContainerClassName="gap-3 px-5 pb-12 pt-12"
        >
          <SettingsActionRow
            icon="xmark"
            label="Close version chooser"
            onPress={() => setOpen(false)}
          />
          <Text className="text-lg text-foreground">
            {provider.displayName || provider.driver} versions
          </Text>
          <SettingsActionRow
            icon="line.3.horizontal.decrease"
            label={prereleases ? "Hide prereleases" : "Show prereleases"}
            disabled={pending}
            onPress={() => {
              setPrereleases(!prereleases);
              void load(1, !prereleases);
            }}
          />
          {pending ? (
            <Text className="text-foreground-muted">
              Preparing the selected operation. Provider status remains available after closing this
              view.
            </Text>
          ) : null}
          {error ? <Text className="text-danger-foreground">{error}</Text> : null}
          {data?.message ? <Text className="text-foreground-muted">{data.message}</Text> : null}
          {data ? (
            <Text className="text-foreground-muted">
              Affected instances: {data.affectedInstances.join(", ")}
            </Text>
          ) : null}
          {data?.releases.map((release) => (
            <View key={release.version} className="gap-1">
              <SettingsActionRow
                icon="arrow.down.circle"
                disabled={pending || !allowed || !release.available}
                label={`${release.version} · ${release.channel}${data.installedVersion === release.version ? " · Installed" : ""}${data.selectedVersion === release.version ? " · Selected" : ""}${release.latestStable ? " · Latest stable" : ""}${release.recommended ? " · Recommended" : ""}`}
                onPress={() =>
                  Alert.alert(
                    `Install ${release.version}?`,
                    `${release.compatibility === "unknown" ? "Compatibility is unknown; this release may prevent agents from starting.\n\n" : ""}Affects ${data.affectedInstances.join(", ")}.\n\n${release.source}\n${release.integrity}`,
                    [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Install this version",
                        onPress: () => {
                          void install(release);
                        },
                      },
                    ],
                  )
                }
              />
              <Text className="text-sm text-foreground-muted">
                {release.compatibility}
                {release.releasedAt
                  ? ` · ${new Date(release.releasedAt).toLocaleDateString()}`
                  : ""}
                {release.reason ? ` · ${release.reason}` : ""}
              </Text>
            </View>
          ))}
          <SettingsActionRow
            icon="chevron.left"
            label="Previous 50"
            disabled={pending || !data || data.page <= 1}
            onPress={() => void load((data?.page ?? 1) - 1)}
          />
          <SettingsActionRow
            icon="chevron.right"
            label="Next 50"
            disabled={pending || !data?.hasMore}
            onPress={() => void load((data?.page ?? 1) + 1)}
          />
        </ScrollView>
      </Modal>
    </>
  );
}
