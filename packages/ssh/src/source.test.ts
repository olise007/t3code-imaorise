import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { prepareSshSpawn, targetConnectionKey } from "./command.ts";

const target = { alias: "build box", hostname: "host", username: "developer", port: 2222 };

it("keeps legacy connection IDs while separating equal aliases across distros", () => {
  assert.equal(
    targetConnectionKey(target),
    targetConnectionKey({ ...target, executionSource: { type: "local" } }),
  );
  const ubuntu = { ...target, executionSource: { type: "wsl" as const, distro: "Ubuntu" } };
  const debian = { ...target, executionSource: { type: "wsl" as const, distro: "Debian" } };
  assert.notEqual(targetConnectionKey(ubuntu), targetConnectionKey(debian));
});

it.effect("passes WSL arguments literally and sends authentication only through stdin", () =>
  Effect.gen(function* () {
    const command = yield* prepareSshSpawn(
      { ...target, executionSource: { type: "wsl", distro: "Ubuntu 26.04" } },
      ["-N", "-L", "4773:127.0.0.1:3773", "dev box;echo bad"],
      {
        authSecret: "private-password",
        trustedHostPrompt: "fingerprint",
        stdin: Stream.make(new TextEncoder().encode("payload")),
      },
    );
    assert.equal(command.command, "wsl.exe");
    assert.include(command.args, "Ubuntu 26.04");
    assert.equal(command.args.at(-1), "dev box;echo bad");
    assert.notInclude(command.args.join(" "), "private-password");
    assert.isUndefined(Reflect.get(command.env, "T3_SSH_AUTH_SECRET"));
    const chunks = yield* Stream.runCollect(command.stdin);
    const bytes = Buffer.concat(Array.from(chunks, (chunk) => Buffer.from(chunk))).toString();
    assert.equal(Buffer.from(bytes.split("\n")[0]!, "base64").toString(), "private-password");
    assert.isTrue(bytes.endsWith("payload"));
  }).pipe(Effect.provide(NodeServices.layer), Effect.provideService(HostProcess.Platform, "win32")),
);

it.effect("refuses WSL profiles on another operating system instead of falling back", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      prepareSshSpawn({ ...target, executionSource: { type: "wsl", distro: "Ubuntu" } }, [], {}),
    );
    assert.equal(result._tag, "Failure");
  }).pipe(Effect.provide(NodeServices.layer), Effect.provideService(HostProcess.Platform, "linux")),
);
