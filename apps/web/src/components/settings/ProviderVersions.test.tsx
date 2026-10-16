// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { ProviderVersions } from "./ProviderVersions";

const fixtures = vi.hoisted(() => ({ query: vi.fn(), update: vi.fn() }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { providerVersions: "query", updateProvider: { permissionAtom: () => true } },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => (command === "query" ? fixtures.query : fixtures.update),
}));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogPanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));
it("requires an exact artifact review, preserves independent labels, and allows explicitly confirmed unknown compatibility", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const release = {
    version: "2.0.0",
    releasedAt: "2026-10-01T00:00:00Z",
    channel: "stable",
    compatibility: "unknown",
    available: true,
    integrity: "sha256:fixture",
    source: "https://vendor.example/2.0.0.tar.gz",
    latestStable: true,
    recommended: false,
    reason: null,
  };
  fixtures.query.mockResolvedValue({
    _tag: "Success",
    value: {
      releases: [
        release,
        {
          ...release,
          version: "2.1.0",
          available: false,
          compatibility: "broken",
          reason: "Known broken",
        },
      ],
      page: 1,
      hasMore: true,
      installedVersion: "1.0.0",
      selectedVersion: "1.0.0",
      affectedInstances: ["Work", "Personal"],
      message: null,
    },
  });
  fixtures.update.mockResolvedValue({ _tag: "Success", value: { providers: [] } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <ProviderVersions
          environmentId={EnvironmentId.make("remote")}
          instanceId={ProviderInstanceId.make("work")}
          provider="codex"
        />,
      );
    });
    const button = (text: string) =>
      Array.from(container.querySelectorAll("button")).find(
        (element) => element.textContent === text,
      )!;
    await act(async () => {
      button("Check for updates").click();
    });
    expect(container.textContent).toContain("Installed: 1.0.0");
    expect(container.textContent).toContain("Selected: 1.0.0");
    expect(container.textContent).toContain("Work, Personal");
    const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(radios[1]?.disabled).toBe(true);
    await act(async () => {
      radios[0]!.click();
    });
    expect(container.textContent).toContain(release.integrity);
    expect(container.textContent).toContain(release.source);
    expect((button("Install 2.0.0") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.click();
    });
    await act(async () => {
      button("Install 2.0.0").click();
    });
    expect(fixtures.update).toHaveBeenCalledWith({
      environmentId: "remote",
      input: {
        provider: "codex",
        instanceId: "work",
        targetVersion: "2.0.0",
        expectedIntegrity: release.integrity,
        allowUnknownCompatibility: true,
      },
    });
    await act(async () => {
      container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    });
    expect(fixtures.query).toHaveBeenLastCalledWith({
      environmentId: "remote",
      input: { provider: "codex", instanceId: "work", page: 1, prereleases: true },
    });
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  }
});
