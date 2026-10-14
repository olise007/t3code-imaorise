import { isRedirect } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../components/settings/ConnectionsSettings", () => ({ ConnectionsSettings: () => null }));
import { Route } from "./settings.connections";
import { searchableSetting } from "../components/settings/settingsSearch";

describe("WSL settings navigation", () => {
  it.each([
    "wsl-backend",
    "wsl-agent-persistence",
    "wsl-background-server",
    "wsl-pairing",
  ] as const)("forwards old Connections anchor %s with its selection intact", (hash) => {
    const beforeLoad = Route.options.beforeLoad;
    expect(typeof beforeLoad).toBe("function");
    if (typeof beforeLoad !== "function") throw new Error("Missing route forwarding");
    const search = { environmentId: "wsl-environment" };
    try {
      beforeLoad({ location: { hash, search } } as never);
      throw new Error("Expected redirect");
    } catch (error) {
      expect(isRedirect(error)).toBe(true);
      expect(error).toMatchObject({
        options: { to: "/settings/wsl", hash, search, replace: true },
      });
    }
    expect(searchableSetting(hash).id).toBe(hash);
  });
  it("leaves general Connections links on their page", () => {
    const beforeLoad = Route.options.beforeLoad;
    if (typeof beforeLoad !== "function") throw new Error("Missing route forwarding");
    expect(
      beforeLoad({ location: { hash: "connections-environment", search: {} } } as never),
    ).toBeUndefined();
  });
});
