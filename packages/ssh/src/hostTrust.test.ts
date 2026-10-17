import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { snapshotUserTrust, userTrustPaths } from "./hostTrust.ts";

it("fails closed when OpenSSH erased custom path boundaries", () => {
  expect(() => userTrustPaths("userknownhostsfile /home/user/trust none\n")).toThrow("boundaries");
  expect(() => userTrustPaths("userknownhostsfile /home/user/trust  file\n")).toThrow("boundaries");
  expect(userTrustPaths("userknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2\n")).toEqual([
    "~/.ssh/known_hosts",
    "~/.ssh/known_hosts2",
  ]);
  expect(userTrustPaths("userknownhostsfile NUL\n")).toEqual(["NUL"]);
  expect(
    userTrustPaths(
      "t3sourcehomedir /home/distro user\nuserknownhostsfile /home/distro user/.ssh/known_hosts /home/distro user/.ssh/known_hosts2\n",
      "/home/distro user",
    ),
  ).toEqual(["/home/distro user/.ssh/known_hosts", "/home/distro user/.ssh/known_hosts2"]);
  expect(
    userTrustPaths(
      "userknownhostsfile C:/Users/Test User/.ssh/known_hosts C:/Users/Test User/.ssh/known_hosts2\n",
      "C:\\Users\\Test User",
    ),
  ).toEqual(["C:/Users/Test User/.ssh/known_hosts", "C:/Users/Test User/.ssh/known_hosts2"]);
  expect(() => userTrustPaths("userknownhostsfile relative/path\n")).toThrow("absolute path");
});

it.effect(
  "snapshots changed/revoked records byte-for-byte without modifying source files and cleans owned copies",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const original = path.join(root, "trust file");
      const contents = "@revoked host ssh-ed25519 revoked\n|1|hashed|host ssh-ed25519 changed\n";
      yield* fs.writeFileString(original, contents);
      let copies: readonly string[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          copies = yield* snapshotUserTrust([original, path.join(root, "missing"), "none"]);
          expect(yield* fs.readFileString(copies[0]!)).toBe(contents);
          yield* fs.writeFileString(copies[0]!, "status-only host trust addition\n");
          expect(yield* fs.readFileString(original)).toBe(contents);
          expect(yield* fs.readDirectory(root)).toEqual(["trust file"]);
          expect(copies[2]).toBe("none");
        }),
      );
      expect(yield* fs.exists(copies[0]!)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fails closed for unreadable paths instead of treating them as missing trust", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const result = yield* Effect.result(snapshotUserTrust([root]));
    expect(result._tag).toBe("Failure");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
