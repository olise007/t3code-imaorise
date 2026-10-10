import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect("leaves official profiles untouched and starts a fresh personal profile", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "imaorise-profile-test-" });
    for (const name of ["t3code", "t3code-v2", "T3 Code (Alpha)"]) {
      yield* fs.makeDirectory(path.join(directory, name), { recursive: true });
      yield* fs.writeFileString(path.join(directory, name, "Local State"), "official-profile");
    }
    const destination = yield* resolveUserDataPath({
      appDataDirectory: directory,
      isDevelopment: false,
      platform: "win32",
    });
    assert.equal(destination, path.join(directory, "t3code-imaorise"));
    assert.isFalse(yield* fs.exists(destination));
    for (const name of ["t3code", "t3code-v2", "T3 Code (Alpha)"]) {
      assert.equal(
        yield* fs.readFileString(path.join(directory, name, "Local State")),
        "official-profile",
      );
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("identifies a failed source read and preserves its cause", () => {
  const sourceState = "/profiles/t3code-imaorise-legacy/Local State";
  const cause = PlatformError.systemError({
    _tag: "PermissionDenied",
    module: "FileSystem",
    method: "readFileString",
    pathOrDescriptor: sourceState,
  });
  return Effect.gen(function* () {
    const error = yield* resolveUserDataPath({
      appDataDirectory: "/profiles",
      isDevelopment: false,
      platform: "win32",
    }).pipe(Effect.flip);
    assert.equal(error.operation, "read");
    assert.equal(error.resourcePath, sourceState);
    assert.equal(error.category, "PermissionDenied");
    assert.strictEqual(error.cause, cause);
  }).pipe(
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: (path) => Effect.succeed(path === sourceState),
        readFileString: () => Effect.fail(cause),
      }),
    ),
    Effect.provide(NodeServices.layer),
  );
});

it.effect.each(["t3code-imaorise-legacy", "T3 Code Imaorise"])(
  "preserves Windows credential keys from %s without copying browser databases",
  (sourceName) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-profile-" });
      const source = path.join(directory, sourceName);
      const destination = path.join(directory, "t3code-imaorise");
      const state = '{"os_crypt":{"encrypted_key":"test-encrypted-key"}}';
      yield* fs.makeDirectory(path.join(directory, "T3 Code Imaorise"), { recursive: true });
      yield* fs.makeDirectory(path.join(source, "IndexedDB"), { recursive: true });
      yield* fs.writeFileString(path.join(source, "Local State"), state);
      yield* fs.writeFileString(path.join(source, "IndexedDB", "LOCK"), "V1 owns this database");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
      });
      assert.equal(yield* fs.readFileString(path.join(destination, "Local State")), state);
      assert.equal(yield* fs.readFileString(path.join(source, "Local State")), state);
      assert.isFalse(yield* fs.exists(path.join(destination, "IndexedDB")));
      yield* fs.writeFileString(path.join(destination, "Local State"), "existing V2 state");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
      });
      assert.equal(
        yield* fs.readFileString(path.join(destination, "Local State")),
        "existing V2 state",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
