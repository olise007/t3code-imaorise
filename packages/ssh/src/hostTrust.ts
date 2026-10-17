import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";

/** OpenSSH's config dump erases path quoting. Never guess ambiguous trust-file boundaries. */
export function userTrustPaths(config: string): string[] {
  const value = config
    .split(/\r?\n/)
    .find((line) => line.startsWith("userknownhostsfile "))
    ?.slice(19);
  if (!value || /[\x00\r\n]/.test(value))
    throw new Error("Could not inspect SSH user trust configuration.");
  if (value === "~/.ssh/known_hosts ~/.ssh/known_hosts2")
    return ["~/.ssh/known_hosts", "~/.ssh/known_hosts2"];
  if (/\s/.test(value))
    throw new Error(
      "Status requires an unambiguous SSH trust-file path. OpenSSH does not preserve quoted path boundaries in its configuration output. Use a single path without spaces or a T3 manual profile; existing trust settings were not changed.",
    );
  if (!/^(?:~[\\/]|[\\/]|[A-Za-z]:[\\/]|none$|NUL$)/i.test(value))
    throw new Error(
      "Cannot safely resolve this SSH trust-file path. Use an absolute path in SSH configuration.",
    );
  return [value];
}

export const snapshotUserTrust = Effect.fn("ssh/trust.snapshot")(function* (
  paths: readonly string[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const folder = yield* fs.makeTempDirectory({ prefix: "t3-ssh-trust-" });
  yield* fs.chmod(folder, 0o700);
  yield* Scope.addFinalizer(
    yield* Scope.Scope,
    fs.remove(folder, { recursive: true, force: true }).pipe(Effect.ignore),
  );
  return yield* Effect.forEach(paths, (original, index) =>
    Effect.gen(function* () {
      if (/^(?:none|NUL|\/dev\/null)$/i.test(original)) return original;
      const expanded = original.replace(/^~(?=[\\/])/, home).replaceAll("%d", home);
      if (/%|\$\{/.test(expanded))
        return yield* Effect.fail(
          new Error(
            "This SSH trust-file expansion cannot be safely inspected. Use an absolute source-owned path.",
          ),
        );
      const contents = yield* fs.readFile(expanded).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(new Uint8Array()),
        ),
      );
      const destination = path.join(folder, String(index));
      yield* fs.writeFile(destination, contents, { mode: 0o600 });
      return destination;
    }),
  );
});
