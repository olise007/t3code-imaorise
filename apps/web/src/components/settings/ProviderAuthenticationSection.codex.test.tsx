// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ProviderDriverKind } from "@t3tools/contracts";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";
const fixture = vi.hoisted(() => ({ start: vi.fn(), query: vi.fn() }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { providerAuthState: (input: unknown) => input, startProviderAuth: "start" },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (input: unknown) => {
    fixture.query(input);
    return {
      error: null,
      data: {
        phase: "idle",
        methods: [
          { id: "codex-browser", name: "Codex browser login" },
          { id: "codex-device", name: "Device-code login" },
          { id: "codex-existing", name: "Existing CLI credentials" },
        ],
      },
    };
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => (command === "start" ? fixture.start : vi.fn()),
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({
    title,
    description,
    control,
    children,
  }: {
    title: ReactNode;
    description: ReactNode;
    control: ReactNode;
    children: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {description}
      {control}
      {children}
    </section>
  ),
}));
vi.mock("../ui/select", () => ({
  Select: ({
    children,
    onValueChange,
    value,
  }: {
    children: ReactNode;
    onValueChange: (value: string) => void;
    value: string;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
}));
it.each(["Windows server", "Linux server"])(
  "offers native login on an existing Codex CLI in %s",
  async (environmentLabel) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    fixture.start.mockResolvedValue({ _tag: "Success", value: {} });
    const container = document.createElement("div");
    const root = createRoot(container);
    const environmentId = EnvironmentId.make("remote-codex");
    const instanceId = ProviderInstanceId.make("custom-codex");
    const provider = {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      status: "ready" as const,
      auth: { status: "unauthenticated" as const },
      checkedAt: "2026-10-17T00:00:00Z",
      models: [],
      version: "0.156.1",
      slashCommands: [],
      skills: [],
      setup: { canAuthenticate: true, canInstall: false },
    };
    try {
      await act(async () =>
        root.render(
          <ProviderAuthenticationSection
            environmentId={environmentId}
            environmentLabel={environmentLabel}
            instanceId={instanceId}
            provider={provider}
            readOnly={false}
          />,
        ),
      );
      expect(container.textContent).toContain(environmentLabel);
      expect(
        Array.from(container.querySelectorAll("option")).map((option) => option.textContent),
      ).toContain("Device-code login");
      await act(async () => {
        const select = container.querySelector("select")!;
        select.value = "codex-device";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () => {
        Array.from(container.querySelectorAll("button"))
          .find((button) => button.textContent === "Sign in")!
          .click();
      });
      expect(fixture.start).toHaveBeenLastCalledWith({
        environmentId,
        input: { instanceId, methodId: "codex-device" },
      });
      await act(async () =>
        root.render(
          <ProviderAuthenticationSection
            environmentId={environmentId}
            environmentLabel={environmentLabel}
            instanceId={instanceId}
            provider={provider}
            readOnly
          />,
        ),
      );
      expect(
        Array.from(container.querySelectorAll("button")).find(
          (button) => button.textContent === "Sign in",
        )?.disabled,
      ).toBe(true);
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    }
  },
);
