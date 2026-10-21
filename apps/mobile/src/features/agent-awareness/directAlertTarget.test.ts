import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import {
  BearerConnectionTarget,
  RelayConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { directAlertTarget } from "./directAlertTarget";

const environmentId = EnvironmentId.make("environment");
const paired: PreparedConnection = {
  environmentId,
  label: "WSL",
  httpBaseUrl: "http://100.64.1.2:4777",
  socketUrl: "ws://100.64.1.2:4777/ws",
  target: new BearerConnectionTarget({ environmentId, label: "WSL", connectionId: "pairing" }),
  httpAuthorization: { _tag: "Bearer", token: "paired-session" },
};
describe("direct notification target", () => {
  it("uses the verified active IP or DNS route and paired credential", () => {
    expect(directAlertTarget(paired, true, "t3code-imaorise")).toEqual({
      environmentId,
      scheme: "t3code-imaorise",
      token: "paired-session",
      url: "http://100.64.1.2:4777/api/direct-agent-activity",
    });
    expect(
      directAlertTarget(
        { ...paired, httpBaseUrl: "https://pc.tailnet.ts.net:4776" },
        true,
        "t3code-imaorise",
      )?.url,
    ).toBe("https://pc.tailnet.ts.net:4776/api/direct-agent-activity");
  });
  it("does not probe older servers, relay routes, or missing credentials", () => {
    expect(directAlertTarget(paired, false, "scheme")).toBeNull();
    expect(directAlertTarget(null, true, "scheme")).toBeNull();
    expect(directAlertTarget({ ...paired, httpAuthorization: null }, true, "scheme")).toBeNull();
    expect(
      directAlertTarget(
        { ...paired, target: new RelayConnectionTarget({ environmentId, label: "cloud" }) },
        true,
        "scheme",
      ),
    ).toBeNull();
  });
});
