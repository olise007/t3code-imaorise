import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import { SshPasswordPromptError } from "@t3tools/ssh/errors";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import { targetConnectionKey } from "@t3tools/ssh/command";
import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";

import * as DesktopSshEnvironment from "./DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";

function makeTempHomeDir() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-env-test-" });
  });
}

describe("sshEnvironment", () => {
  it.effect.each([true, false])(
    "saves verified credentials only through available secure storage (%s)",
    (available) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* makeTempHomeDir();
        const cached = new Map<string, string>();
        const supplied: (string | undefined)[] = [];
        const encrypted: string[] = [];
        const target: DesktopSshEnvironmentTarget = {
          alias: "fixture",
          hostname: "192.0.2.10",
          username: "DOMAIN\\fixture",
          port: 2222,
          executionSource: { type: "local" },
          manual: {
            profileId: "manual-fixture",
            name: "Fixture",
            authentication: { type: "password" },
          },
        };
        const manager = SshTunnel.SshEnvironmentManager.of({
          ensureEnvironment: (target, options) =>
            Effect.gen(function* () {
              supplied.push(options?.authSecret);
              if (options?.authSecret === "incorrect-fixture")
                return yield* new SshPasswordPromptError({
                  message: "Incorrect fixture credential",
                });
              cached.set(targetConnectionKey(target), options?.authSecret ?? "saved-fixture");
              return { target, httpBaseUrl: "", wsBaseUrl: "", pairingToken: null };
            }),
          authenticatedSecret: (target) => cached.get(targetConnectionKey(target)),
          forgetAuthentication: (target) =>
            Effect.sync(() => {
              cached.delete(targetConnectionKey(target));
            }),
          disconnectEnvironment: () => Effect.void,
          stopEnvironment: () => Effect.void,
        });
        const environment = yield* DesktopSshEnvironment.make.pipe(
          Effect.provideService(SshTunnel.SshEnvironmentManager, manager),
          Effect.provideService(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
            request: () => Effect.die("Unexpected prompt"),
            resolve: () => Effect.die("Unexpected resolution"),
          }),
          Effect.provideService(ElectronSafeStorage.ElectronSafeStorage, {
            isEncryptionAvailable: Effect.succeed(available),
            selectedStorageBackend: Effect.succeed(Option.none()),
            encryptString: (value) =>
              Effect.sync(() => {
                encrypted.push(value);
                return new TextEncoder().encode("protected-fixture");
              }),
            decryptString: () => Effect.succeed("saved-fixture"),
          }),
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.Platform, "win32"),
        );
        const first = yield* environment.ensureEnvironment(target, {
          testOnly: true,
          authSecret: "saved-fixture",
          rememberSecret: true,
        });
        assert.deepEqual(encrypted, available ? ["saved-fixture"] : []);
        if (available) {
          const files = yield* fs.readDirectory(path.join(home, ".t3-imaorise", "ssh", "secrets"));
          assert.equal(files.length, 1);
          assert.notInclude(
            yield* fs.readFileString(path.join(home, ".t3-imaorise", "ssh", "secrets", files[0]!)),
            "saved-fixture",
          );
        } else assert.include(first.setupWarnings?.join(" ") ?? "", "was not saved");
        yield* environment.ensureEnvironment(target, { testOnly: true });
        assert.equal(supplied.at(-1), available ? "saved-fixture" : undefined);
        yield* environment.ensureEnvironment(
          { ...target, executionSource: { type: "wsl", distro: "Ubuntu" } },
          { testOnly: true },
        );
        assert.isUndefined(supplied.at(-1));
        yield* environment
          .ensureEnvironment(target, {
            authSecret: "incorrect-fixture",
            rememberSecret: true,
            testOnly: true,
          })
          .pipe(Effect.flip);
        assert.deepEqual(encrypted, available ? ["saved-fixture"] : []);
        yield* environment.forgetCredentials!(target);
        if (available)
          assert.deepEqual(
            yield* fs.readDirectory(path.join(home, ".t3-imaorise", "ssh", "secrets")),
            [],
          );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici, NetService.layer),
        ),
      ),
  );
  it.effect("cancels only the matching operation and acknowledges cleanup before retry", () =>
    Effect.gen(function* () {
      const home = yield* makeTempHomeDir();
      const entered = yield* Deferred.make<void>();
      let calls = 0;
      let cleaned = false;
      const target = { alias: "fixture", hostname: "192.0.2.10", username: "fixture", port: 22 };
      const manager = SshTunnel.SshEnvironmentManager.of({
        ensureEnvironment: (target) =>
          Effect.gen(function* () {
            calls++;
            if (calls === 1)
              return yield* Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Effect.sync(() => {
                    cleaned = true;
                  }),
                ),
              );
            return { target, httpBaseUrl: "", wsBaseUrl: "", pairingToken: null };
          }),
        disconnectEnvironment: () => Effect.void,
        stopEnvironment: () => Effect.void,
      });
      const service = yield* DesktopSshEnvironment.make.pipe(
        Effect.provideService(SshTunnel.SshEnvironmentManager, manager),
        Effect.provideService(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
          request: () => Effect.die("Unexpected prompt"),
          resolve: () => Effect.die("Unexpected resolution"),
        }),
        Effect.provideService(HostProcess.HomeDirectory, home),
      );
      const first = yield* service
        .ensureEnvironment(target, { operationId: "first" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* service.cancelSetup(target, "obsolete");
      assert.isFalse(cleaned);
      const duplicate = yield* service
        .ensureEnvironment(target, { operationId: "second" })
        .pipe(Effect.result);
      assert.equal(duplicate._tag, "Failure");
      assert.equal(calls, 1);
      yield* service.cancelSetup(target, "first");
      yield* Fiber.await(first);
      assert.isTrue(cleaned);
      yield* service.ensureEnvironment(target, { operationId: "second" });
      assert.equal(calls, 2);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici, NetService.layer),
      ),
    ),
  );

  it("keeps prompt presentation diagnostics distinct from the legacy wrapper message", () => {
    const cause = new DesktopSshPasswordPrompts.DesktopSshPromptPresentationError({
      requestId: "prompt-1",
      destination: "devbox",
      operation: "send-prompt-request",
      cause: new Error("renderer send failed"),
    });

    assert.equal(cause.message, "Failed to present SSH password prompt for devbox.");
    assert.equal(
      DesktopSshEnvironment.toSshPasswordPromptError(cause).message,
      "T3 Code window is not available for SSH authentication.",
    );
  });

  it("treats password prompt timeouts as cancellable authentication prompts", () => {
    assert.equal(
      DesktopSshEnvironment.isDesktopSshPasswordPromptCancellation(
        new SshPasswordPromptError({
          message: "SSH authentication timed out for devbox.",
          cause: new DesktopSshPasswordPrompts.DesktopSshPromptTimedOutError({
            requestId: "prompt-1",
            destination: "devbox",
          }),
        }),
      ),
      true,
    );
  });

  it.effect("wires desktop host discovery through the ssh package runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDir = yield* makeTempHomeDir();
      const sshDir = path.join(homeDir, ".ssh");
      yield* fs.makeDirectory(path.join(sshDir, "config.d"), { recursive: true });
      yield* fs.writeFileString(
        path.join(sshDir, "config"),
        ["Host devbox", "  HostName devbox.example.com", "Include config.d/*.conf", ""].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(sshDir, "config.d", "team.conf"),
        [
          "Host staging",
          "  HostName staging.example.com",
          "Host *",
          "  ServerAliveInterval 30",
          "",
        ].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(sshDir, "known_hosts"),
        [
          "known.example.com ssh-ed25519 AAAA",
          "|1|hashed|entry ssh-ed25519 AAAA",
          "[bastion.example.com]:2222 ssh-ed25519 AAAA",
          "",
        ].join("\n"),
      );

      const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
      const hosts = yield* sshEnvironment.discoverHosts({ homeDir });
      assert.deepEqual(hosts, [
        {
          alias: "bastion.example.com",
          hostname: "bastion.example.com",
          username: null,
          port: null,
          source: "known-hosts",
        },
        {
          alias: "devbox",
          hostname: "devbox",
          username: null,
          port: null,
          source: "ssh-config",
        },
        {
          alias: "known.example.com",
          hostname: "known.example.com",
          username: null,
          port: null,
          source: "known-hosts",
        },
        {
          alias: "staging",
          hostname: "staging",
          username: null,
          port: null,
          source: "ssh-config",
        },
      ]);
    }).pipe(
      Effect.provide(
        DesktopSshEnvironment.layer().pipe(
          Layer.provideMerge(
            Layer.succeed(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
              request: () => Effect.die("unexpected password prompt request"),
              resolve: () => Effect.die("unexpected password prompt resolution"),
            }),
          ),
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(NodeHttpClient.layerUndici),
          Layer.provideMerge(NetService.layer),
        ),
      ),
      Effect.scoped,
    ),
  );
});
