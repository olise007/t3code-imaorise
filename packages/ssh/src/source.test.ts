// @effect-diagnostics nodeBuiltinImport:off - Execute the source-owned shell helper against disposable files, without connecting to a host.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
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

it.effect(
  "WSL readonly trust copies preserve records and leave no source trust directory or helpers",
  () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return; // The hosted Windows fixture covers native OpenSSH.
      const root = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-source-trust-")),
      );
      try {
        const original = NodePath.join(root, "source trust");
        const contents = "@revoked host ssh-ed25519 revoked\n";
        yield* Effect.promise(() => NodeFSP.writeFile(original, contents));
        const observer = NodePath.join(root, "observe.cjs");
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            observer,
            `#!${process.execPath}
const fs=require('node:fs');const arg=process.argv.find(x=>x.startsWith('UserKnownHostsFile='));const file=arg.match(/"([^"]+)"/)[1];process.stdout.write(JSON.stringify({file,contents:fs.readFileSync(file,'utf8')}));`,
            { mode: 0o700 },
          ),
        );
        const prepared = yield* prepareSshSpawn(
          { ...target, executionSource: { type: "wsl", distro: "Fixture" } },
          [observer],
          { readOnlyTrustPaths: [original] },
        );
        const input = Buffer.concat(
          Array.from(yield* Stream.runCollect(prepared.stdin), (chunk) => Buffer.from(chunk)),
        );
        const script = prepared.args[prepared.args.indexOf("-lc") + 1]!;
        const result = NodeChildProcess.spawnSync("sh", ["-c", script, "t3-ssh", observer], {
          input,
          env: { ...process.env, HOME: root },
          encoding: "utf8",
          timeout: 5_000,
        });
        assert.equal(result.status, 0, result.stderr);
        const observation = JSON.parse(result.stdout) as { file: string; contents: string };
        assert.equal(observation.contents, contents);
        const inspection = NodeChildProcess.spawnSync(
          "sh",
          ["-c", script, "t3-ssh", "/bin/true", "-G"],
          {
            input: "\n\n\n",
            env: { ...process.env, HOME: root },
            encoding: "utf8",
            timeout: 5_000,
          },
        );
        assert.equal(inspection.status, 0, inspection.stderr);
        assert.equal(inspection.stdout, `t3sourcehomedir ${root}\n`);
        assert.equal(yield* Effect.promise(() => NodeFSP.readFile(original, "utf8")), contents);
        assert.isFalse(
          yield* Effect.promise(() =>
            NodeFSP.access(observation.file).then(
              () => true,
              () => false,
            ),
          ),
        );
        assert.isFalse(
          yield* Effect.promise(() =>
            NodeFSP.access(NodePath.join(root, ".t3-imaorise")).then(
              () => true,
              () => false,
            ),
          ),
        );
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true }));
      }
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcess.Platform, "win32"),
    ),
);
