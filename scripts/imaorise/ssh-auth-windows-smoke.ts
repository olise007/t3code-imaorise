// @effect-diagnostics nodeBuiltinImport:off - Hosted disposable OpenSSH authentication fixture.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as SshAuth from "@t3tools/ssh/auth";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";

if (process.env.GITHUB_ACTIONS !== "true" || process.platform !== "win32")
  throw new Error("Hosted Windows fixture only.");
// Secrets are generated for this disposable runner and supplied over stdin.
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
  root: string;
  port: number;
  username: string;
  password: string;
  passphrase: string;
  identity: string;
  differentHostKey: string;
};
const home = NodePath.join(input.root, "manual SSH client");
await NodeFSP.mkdir(home, { recursive: true });
const program = Effect.gen(function* () {
  const requests: SshAuth.SshPasswordRequest[] = [];
  let cancel = false;
  const service = yield* SshTunnel.SshEnvironmentManager;
  const target: DesktopSshEnvironmentTarget = {
    alias: "must-not-use-an-alias",
    hostname: "127.0.0.1",
    username: input.username,
    port: input.port,
    manual: {
      profileId: "password-fixture",
      name: "Disposable Windows password fixture",
      authentication: { type: "password" },
    },
  };
  const prompt = SshAuth.SshPasswordPrompt.of({
    isAvailable: true,
    request: (request) =>
      Effect.sync(() => {
        requests.push(request);
        if (cancel) return null;
        if (request.challenge === "host-key") {
          NodeAssert.match(request.prompt, /SHA256:/);
          return "yes";
        }
        return request.challenge === "key-passphrase" ? input.passphrase : input.password;
      }),
  });
  const authenticate = (target: DesktopSshEnvironmentTarget, secret?: string) =>
    service
      .ensureEnvironment(target, {
        testOnly: true,
        ...(secret === undefined ? {} : { authSecret: secret }),
      })
      .pipe(Effect.provideService(SshAuth.SshPasswordPrompt, prompt));
  const first = yield* authenticate(target);
  NodeAssert.equal(first.httpBaseUrl, "");
  NodeAssert.ok(requests.some((request) => request.challenge === "host-key"));
  NodeAssert.ok(requests.some((request) => request.challenge === "password"));
  const retry = {
    ...target,
    manual: { ...target.manual!, profileId: "incorrect-password-fixture" },
  };
  yield* authenticate(retry, "incorrect-disposable-fixture-password");
  const key: DesktopSshEnvironmentTarget = {
    ...target,
    manual: {
      profileId: "encrypted-key-fixture",
      name: "Encrypted key",
      authentication: { type: "key", identityFile: input.identity },
    },
  };
  yield* authenticate(key);
  NodeAssert.ok(requests.some((request) => request.challenge === "key-passphrase"));
  cancel = true;
  const cancellation = yield* Effect.result(
    authenticate({
      ...target,
      hostname: "localhost",
      manual: { ...target.manual!, profileId: "cancel-fixture" },
    }),
  );
  NodeAssert.equal(cancellation._tag, "Failure");
  cancel = false;
  const trust = NodePath.join(home, ".t3-imaorise", "ssh", "known_hosts");
  yield* Effect.promise(() =>
    NodeFSP.writeFile(trust, `[127.0.0.1]:${input.port} ${input.differentHostKey}\n`),
  );
  const previousPrompts = requests.length;
  const changed = yield* Effect.result(
    authenticate({ ...target, manual: { ...target.manual!, profileId: "changed-host-fixture" } }),
  );
  NodeAssert.equal(changed._tag, "Failure");
  NodeAssert.equal(requests.length, previousPrompts);
  NodeAssert.ok(
    (yield* Effect.promise(() => NodeFSP.readFile(trust, "utf8"))).includes(input.differentHostKey),
  );
  console.log(
    "Passed native Windows host trust, password retry, encrypted key, cancellation, and changed-host rejection.",
  );
}).pipe(
  Effect.scoped,
  Effect.provide(SshTunnel.SshEnvironmentManager.layer()),
  Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici, NetService.layer)),
  Effect.provideService(HostProcess.HomeDirectory, home),
);
await Effect.runPromise(program);
