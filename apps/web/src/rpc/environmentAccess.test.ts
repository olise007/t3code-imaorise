import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import {
  BearerConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";

const state = vi.hoisted(() => ({ allowed: true, prepared: null as PreparedConnection | null }));
vi.mock("~/state/session", () => ({
  readEnvironmentScope: () => state.allowed,
  readPreparedConnection: () => state.prepared,
}));
import {
  createEnvironmentPairingCredential,
  revokeEnvironmentPairingLink,
} from "./environmentAccess";
const id = EnvironmentId.make("wsl-environment");
const descriptor = {
  environmentId: id,
  label: "WSL",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "2.0.1",
  capabilities: {},
};
beforeEach(() => {
  state.allowed = true;
  state.prepared = {
    environmentId: id,
    label: "WSL",
    httpBaseUrl: "http://127.0.0.1:4775",
    socketUrl: "ws://127.0.0.1:4775/ws",
    httpAuthorization: { _tag: "Bearer", token: "private-test-bearer" },
    target: new BearerConnectionTarget({
      environmentId: id,
      label: "WSL",
      connectionId: "wsl-connection",
    }),
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
});
function response(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}
describe("environment access targeting", () => {
  it("creates a link on the selected WSL server with its session and selected scopes", async () => {
    const calls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        calls.push(request);
        return request.url.includes(".well-known")
          ? response(descriptor)
          : response({
              id: "pair-1",
              credential: "private-one-time",
              expiresAt: "2026-10-10T22:30:00.000Z",
            });
      }),
    );
    const result = await createEnvironmentPairingCredential(id, {
      label: "Phone",
      scopes: ["orchestration:read"],
    });
    expect(result.id).toBe("pair-1");
    expect(calls.map((r) => r.url)).toEqual([
      "http://127.0.0.1:4775/.well-known/t3/environment",
      "http://127.0.0.1:4775/api/auth/pairing-token",
    ]);
    expect(calls[1]!.headers.get("Authorization")).toBe("Bearer private-test-bearer");
    expect(await calls[1]!.json()).toEqual({ label: "Phone", scopes: ["orchestration:read"] });
  });
  it("blocks a grant revoked after the dialog opened without sending a request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    state.allowed = false;
    await expect(
      createEnvironmentPairingCredential(id, { scopes: ["orchestration:read"] }),
    ).rejects.toThrow("Manage access");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not mint credentials when the selected endpoint identity changes", async () => {
    const fetch = vi.fn(async () => response({ ...descriptor, environmentId: "windows" }));
    vi.stubGlobal("fetch", fetch);
    await expect(createEnvironmentPairingCredential(id, {})).rejects.toThrow(
      "different environment",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("revokes a WSL link on WSL rather than the primary Windows environment", async () => {
    const calls: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        calls.push(request);
        return request.url.includes(".well-known")
          ? response(descriptor)
          : response({ revoked: true });
      }),
    );
    await revokeEnvironmentPairingLink(id, "pair-1");
    expect(calls[1]!.url).toBe("http://127.0.0.1:4775/api/auth/pairing-links/revoke");
    expect(await calls[1]!.json()).toEqual({ id: "pair-1" });
  });
});
