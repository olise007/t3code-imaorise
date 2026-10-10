import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient } from "effect/http";
import * as ProcessRunner from "../processRunner.ts";
import { ensurePinnedRuntimeInstalled } from "./pinnedRuntime.ts";

it.layer(NodeServices.layer)("Imaorise managed updates", (it) => {
  it.effect("refuses official runtime downloads before network or filesystem changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "imaorise-update-test-" });
      const failure = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        fs,
        path,
        version: "1.2.3",
        platform: "linux",
        arch: "x64",
        httpClient: HttpClient.make(() => Effect.die("unexpected network request")),
        runner: ProcessRunner.ProcessRunner.of({ run: () => Effect.die("unexpected process") }),
        validate: () => Effect.die("unexpected validation"),
      }).pipe(Effect.flip);
      assert.include(failure.message, "disabled in T3 Code Imaorise");
      assert.deepEqual(yield* fs.readDirectory(baseDir), []);
    }),
  );
});
