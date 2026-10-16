import type { DesktopSshEnvironmentTarget, DesktopSshExecutionSource } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { buildSshChildEnvironment, type SshAuthOptions } from "./auth.ts";
import { SshCommandError, SshInvalidTargetError } from "./errors.ts";
import { createSetupDetails } from "./setupDetails.ts";

const DEFAULT_SSH_COMMAND_TIMEOUT_MS = 60_000;
const MAX_SSH_ERROR_OUTPUT_LENGTH = 4_000;

/**
 * ssh is a real executable everywhere (`ssh.exe` on Windows), so it is always
 * spawned directly — cmd.exe shell mode would re-tokenize arguments such as
 * identity-file paths containing spaces.
 */
const sshCommandForPlatform = (platform: NodeJS.Platform): string =>
  platform === "win32" ? "ssh.exe" : "ssh";

export const resolveSshCommand = Effect.map(HostProcess.Platform, sshCommandForPlatform);

const encoder = new TextEncoder();

export interface SshCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunSshCommandOptions extends SshAuthOptions {
  /** Only enable for installer output, never authentication or pairing protocols. */
  readonly onDetails?: (line: string) => Effect.Effect<void>;
  /** Suppress remote diagnostics for operations consuming an elevation secret. */
  readonly sensitiveInput?: boolean;
  readonly preHostArgs?: ReadonlyArray<string>;
  readonly remoteCommandArgs?: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly stdinBytes?: Uint8Array;
  readonly timeoutMs?: number;
}

export function parseSshResolveOutput(alias: string, stdout: string): DesktopSshEnvironmentTarget {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const [key, ...rest] = trimmed.split(/\s+/u);
    if (!key || rest.length === 0 || values.has(key)) {
      continue;
    }
    values.set(key, rest.join(" ").trim());
  }

  const hostname = values.get("hostname")?.trim() || alias;
  const username = values.get("user")?.trim() || null;
  const rawPort = values.get("port")?.trim() ?? "";
  const parsedPort = Number.parseInt(rawPort, 10);

  return {
    alias,
    hostname,
    username,
    port: Number.isInteger(parsedPort) ? parsedPort : null,
  };
}

export function targetConnectionKey(target: DesktopSshEnvironmentTarget): string {
  const legacy = `${target.alias}\u0000${target.hostname}\u0000${target.username ?? ""}\u0000${target.port ?? ""}${target.manual ? `\u0000${JSON.stringify([target.manual.profileId, target.manual.name, target.manual.authentication.type, target.manual.authentication.type === "key" ? target.manual.authentication.identityFile : null])}` : ""}`;
  return target.executionSource?.type === "wsl"
    ? `wsl:${target.executionSource.distro}\u0000${legacy}`
    : legacy;
}

// Authentication material travels on stdin, never through wsl.exe's arguments.
// Keep the helper alive for the tunnel's lifetime and remove it on every exit.
const WSL_SSH_WRAPPER = String.raw`set -eu
IFS= read -r secret
IFS= read -r trusted
umask 077
mkdir -p "$HOME/.t3-imaorise/ssh"
helper=$(mktemp -d)
cleanup() { rm -rf "$helper"; }
trap cleanup EXIT HUP INT TERM
printf '%s' "$secret" | base64 -d > "$helper/secret"
printf '%s' "$trusted" | base64 -d > "$helper/trust"
cat > "$helper/askpass" <<'ASKPASS'
#!/bin/sh
folder=$(dirname "$0")
if [ -s "$folder/trust" ] && [ "$*" = "$(cat "$folder/trust")" ]; then printf 'yes\n'; exit 0; fi
case "$*" in *'yes/no'*|*'SHA256:'*) printf 'T3_SSH_PROMPT:%s\n' "$(printf '%s' "$*" | base64 | tr -d '\n')" >&2; exit 1 ;; esac
if [ -s "$folder/secret" ]; then cat "$folder/secret"; exit 0; fi
printf 'T3_SSH_AUTH_PROMPT:%s\n' "$(printf '%s' "$*" | base64 | tr -d '\n')" >&2
exit 1
ASKPASS
chmod 700 "$helper/askpass"
export SSH_ASKPASS="$helper/askpass" SSH_ASKPASS_REQUIRE=force DISPLAY=t3code
unset secret trusted
ssh "$@"
`;

export const prepareSshSpawn = Effect.fn("ssh/command.prepareSshSpawn")(function* (
  target: DesktopSshEnvironmentTarget,
  args: ReadonlyArray<string>,
  input: SshAuthOptions & { readonly stdin?: Stream.Stream<Uint8Array> },
) {
  const manualArgs: string[] = [];
  if (target.manual) {
    if (target.manual.authentication.type === "key") {
      const file = target.manual.authentication.identityFile;
      const windows =
        target.executionSource?.type !== "wsl" && (yield* HostProcess.Platform) === "win32";
      if (
        /[\x00\r\n]/.test(file) ||
        !(windows ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}|~[\\/])/.test(file) : /^(?:\/|~\/)/.test(file))
      )
        return yield* new SshInvalidTargetError({
          message:
            "Enter a full private-key path inside the selected Windows or WSL SSH source, or a path beginning with ~/ .",
        });
    }
    // -F none excludes both user and system SSH configuration. Authentication
    // is owned by this T3 profile, never by a coincidentally matching alias.
    manualArgs.push(
      "-F",
      "none",
      "-o",
      "IdentityAgent=none",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "GlobalKnownHostsFile=none",
    );
    if (target.manual.authentication.type === "password")
      manualArgs.push("-o", "PreferredAuthentications=password", "-o", "PubkeyAuthentication=no");
    else
      manualArgs.push(
        "-o",
        "PreferredAuthentications=publickey",
        "-i",
        target.manual.authentication.identityFile,
      );
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const home = yield* HostProcess.HomeDirectory;
    const trust = path.join(home, ".t3-imaorise", "ssh");
    if (target.executionSource?.type !== "wsl")
      yield* fs.makeDirectory(trust, { recursive: true, mode: 0o700 }).pipe(Effect.orDie);
    manualArgs.push(
      "-o",
      `UserKnownHostsFile="${target.executionSource?.type === "wsl" ? "~/.t3-imaorise/ssh/known_hosts" : path.join(trust, "known_hosts").replaceAll("\\", "/").replaceAll('"', '\\"')}"`,
    );
  }
  const sshArgs = [...manualArgs, ...args];
  if (target.executionSource?.type === "wsl") {
    if ((yield* HostProcess.Platform) !== "win32") {
      return yield* new SshInvalidTargetError({
        message: "This SSH connection requires Windows and its saved WSL distro.",
      });
    }
    return {
      command: "wsl.exe",
      args: [
        "--distribution",
        target.executionSource.distro,
        "--exec",
        "sh",
        "-lc",
        WSL_SSH_WRAPPER,
        "t3-ssh",
        ...sshArgs,
      ],
      env: {},
      stdin: Stream.concat(
        Stream.make(
          encoder.encode(
            `${Buffer.from(input.authSecret ?? "").toString("base64")}\n${Buffer.from(input.trustedHostPrompt ?? "").toString("base64")}\n`,
          ),
        ),
        input.stdin ?? Stream.empty,
      ),
    };
  }
  return {
    command: yield* resolveSshCommand,
    args: sshArgs,
    env: yield* buildSshChildEnvironment(input),
    stdin: input.stdin ?? Stream.empty,
  };
});

/** Names the remote state directory for a target: the first 16 hex chars of its SHA-256 key. */
export const remoteStateKey = Effect.fn("ssh/command.remoteStateKey")(function* (
  target: DesktopSshEnvironmentTarget,
): Effect.fn.Return<string, never, Crypto.Crypto> {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto
    .digest("SHA-256", encoder.encode(targetConnectionKey(target)))
    .pipe(Effect.orDie);
  return Hex.encode(digest).slice(0, 16);
});

function buildSshHostSpec(target: DesktopSshEnvironmentTarget): string {
  const destination = target.manual
    ? target.hostname.trim()
    : target.alias.trim() || target.hostname.trim();
  if (destination.length === 0) {
    throw new Error("SSH target is missing its alias/hostname.");
  }
  if (
    destination.startsWith("-") ||
    target.username?.startsWith("-") ||
    /[\x00-\x1f]/.test(destination) ||
    (target.port !== null &&
      (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535)) ||
    (target.username !== null && /[\x00-\x1f]/.test(target.username))
  ) {
    throw new Error(
      "SSH host and username cannot contain control characters or begin with an option.",
    );
  }
  return target.username ? `${target.username}@${destination}` : destination;
}

export const buildSshHostSpecEffect = (
  target: DesktopSshEnvironmentTarget,
): Effect.Effect<string, SshInvalidTargetError> =>
  Effect.try({
    try: () => buildSshHostSpec(target),
    catch: (cause) =>
      new SshInvalidTargetError({
        message: cause instanceof Error ? cause.message : "SSH target is invalid.",
      }),
  });

export function baseSshArgs(
  target: DesktopSshEnvironmentTarget,
  input?: { readonly batchMode?: "yes" | "no" },
): string[] {
  return [
    "-o",
    `BatchMode=${input?.batchMode ?? "no"}`,
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=ask",
    ...(target.port !== null ? ["-p", String(target.port)] : []),
  ];
}

export function getLastNonEmptyOutputLine(stdout: string): string | null {
  return (
    stdout
      .trim()
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .findLast((entry) => entry.length > 0) ?? null
  );
}

export const collectProcessOutput = <E>(
  stream: Stream.Stream<Uint8Array, E>,
): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

function redactSshErrorOutput(output: string): string {
  const redacted = output.replace(
    /("(?:access_token|bearerToken|credential|pairingToken|token)"\s*:\s*")[^"]+(")/giu,
    "$1[redacted]$2",
  );
  return redacted.length > MAX_SSH_ERROR_OUTPUT_LENGTH
    ? `${redacted.slice(0, MAX_SSH_ERROR_OUTPUT_LENGTH)}\n[truncated]`
    : redacted;
}

function normalizeSshErrorMessage(input: {
  readonly stdout?: string;
  readonly stderr: string;
  readonly fallbackMessage: string;
}): string {
  const cleanedStderr = input.stderr.trim();
  if (cleanedStderr.length > 0) {
    return cleanedStderr;
  }

  const cleanedStdout = input.stdout?.trim() ?? "";
  return cleanedStdout.length > 0 ? cleanedStdout : input.fallbackMessage;
}

function sshTargetLogFields(target: DesktopSshEnvironmentTarget) {
  return {
    alias: target.alias,
    hostname: target.hostname,
    username: target.username,
    port: target.port,
  };
}

function stdinStream(input: string | undefined) {
  return input === undefined ? Stream.empty : Stream.make(encoder.encode(input));
}

const runSshCommandInScope = Effect.fn("ssh/command.runSshCommand.inScope")(function* (
  target: DesktopSshEnvironmentTarget,
  input: RunSshCommandOptions,
  commandScope: Scope.Scope,
): Effect.fn.Return<
  SshCommandResult,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const hostSpec = yield* buildSshHostSpecEffect(target);
  const auth = {
    ...(input.trustedHostPrompt === undefined
      ? {}
      : { trustedHostPrompt: input.trustedHostPrompt }),
    ...(input.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
    ...(input.authSecret === undefined ? {} : { authSecret: input.authSecret }),
  };
  const args = [
    ...baseSshArgs(target, {
      batchMode: input.batchMode ?? (input.interactiveAuth ? "no" : "yes"),
    }),
    ...(input.preHostArgs ?? []),
    hostSpec,
    ...(input.remoteCommandArgs ?? []),
  ];
  const prepared = yield* prepareSshSpawn(target, args, {
    ...auth,
    stdin:
      input.stdinBytes === undefined ? stdinStream(input.stdin) : Stream.make(input.stdinBytes),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: ["ssh"],
          exitCode: null,
          stderr: "",
          message: "Failed to prepare SSH authentication helpers.",
          cause,
        }),
    ),
  );
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const sshCommand = prepared.command;
  yield* Effect.logDebug("ssh.command.start", {
    ...sshTargetLogFields(target),
    command: [sshCommand, ...args],
    hasStdin: input.stdin !== undefined,
    timeoutMs: input.timeoutMs ?? DEFAULT_SSH_COMMAND_TIMEOUT_MS,
  });
  const child = yield* spawner
    .spawn(
      ChildProcess.make(sshCommand, prepared.args, {
        env: prepared.env,
        extendEnv: true,
        stdin: {
          stream: prepared.stdin,
          endOnDone: true,
        },
      }),
    )
    .pipe(
      Effect.provideService(Scope.Scope, commandScope),
      Effect.mapError(
        (cause) =>
          new SshCommandError({
            command: [sshCommand, ...args],
            exitCode: null,
            stderr: "",
            message:
              cause instanceof Error
                ? cause.message
                : `Failed to spawn SSH command for ${hostSpec}.`,
            cause,
          }),
      ),
    );

  const collect = (stream: typeof child.stdout) =>
    Effect.gen(function* () {
      if (!input.onDetails || input.sensitiveInput) return yield* collectProcessOutput(stream);
      const lines: string[] = [];
      const details = createSetupDetails((line) => lines.push(line));
      let result = "";
      yield* stream.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            result = (result + chunk).slice(-1024 * 1024);
            details.push(chunk);
            for (const line of lines.splice(0)) yield* input.onDetails!(line);
          }),
        ),
      );
      details.finish();
      for (const line of lines) yield* input.onDetails(line);
      return result;
    });
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: ["ssh", ...args],
          exitCode: null,
          stderr: "",
          message:
            cause instanceof Error ? cause.message : `Failed to run SSH command for ${hostSpec}.`,
          cause,
        }),
    ),
  );

  if (exitCode !== 0) {
    const diagnosticStdout = input.sensitiveInput ? "" : redactSshErrorOutput(stdout);
    const diagnosticStderr = input.sensitiveInput
      ? "Remote operation failed; sensitive diagnostics withheld."
      : stderr;
    yield* Effect.logWarning("ssh.command.failed", {
      ...sshTargetLogFields(target),
      command: ["ssh", ...args],
      exitCode,
      stdout: diagnosticStdout,
      stderr: diagnosticStderr,
    });
    return yield* new SshCommandError({
      command: ["ssh", ...args],
      exitCode,
      stdout: diagnosticStdout,
      stderr: diagnosticStderr,
      message: normalizeSshErrorMessage({
        stdout: diagnosticStdout,
        stderr: diagnosticStderr,
        fallbackMessage: `SSH command failed for ${hostSpec} (exit ${exitCode}).`,
      }),
    });
  }

  yield* Effect.logDebug("ssh.command.succeeded", {
    ...sshTargetLogFields(target),
    command: ["ssh", ...args],
  });
  return { stdout, stderr };
});

export const runSshCommand = Effect.fn("ssh/command.runSshCommand")(function* (
  target: DesktopSshEnvironmentTarget,
  input: RunSshCommandOptions = {},
): Effect.fn.Return<
  SshCommandResult,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  return yield* Effect.scopedWith((commandScope) =>
    runSshCommandInScope(target, input, commandScope),
  ).pipe(
    Effect.timeoutOption(Duration.millis(input.timeoutMs ?? DEFAULT_SSH_COMMAND_TIMEOUT_MS)),
    Effect.flatMap((result) =>
      Option.match(result, {
        onSome: Effect.succeed,
        onNone: () =>
          Effect.gen(function* () {
            yield* Effect.logWarning("ssh.command.timedOut", {
              ...sshTargetLogFields(target),
              timeoutMs: input.timeoutMs ?? DEFAULT_SSH_COMMAND_TIMEOUT_MS,
              remoteCommandArgs: input.remoteCommandArgs ?? [],
              preHostArgs: input.preHostArgs ?? [],
              hasStdin: input.stdin !== undefined,
            });
            return yield* new SshCommandError({
              command: ["ssh"],
              exitCode: null,
              stderr: "",
              message: `SSH command timed out after ${input.timeoutMs ?? DEFAULT_SSH_COMMAND_TIMEOUT_MS}ms.`,
            });
          }),
      }),
    ),
  );
});

export const resolveSshTarget = Effect.fn("ssh/command.resolveSshTarget")(function* (
  alias: string,
  executionSource?: DesktopSshExecutionSource,
): Effect.fn.Return<
  DesktopSshEnvironmentTarget,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const trimmedAlias = alias.trim();
  if (trimmedAlias.length === 0) {
    return yield* new SshInvalidTargetError({ message: "SSH host alias is required." });
  }

  yield* Effect.logDebug("ssh.target.resolve.start", { alias: trimmedAlias });
  return yield* runSshCommand(
    {
      alias: trimmedAlias,
      hostname: trimmedAlias,
      username: null,
      port: null,
      ...(executionSource === undefined ? {} : { executionSource }),
    },
    { preHostArgs: ["-G"] },
  ).pipe(
    Effect.map((result) => ({
      ...parseSshResolveOutput(trimmedAlias, result.stdout),
      ...(executionSource === undefined ? {} : { executionSource }),
    })),
    Effect.tap((target) =>
      Effect.logDebug("ssh.target.resolve.succeeded", sshTargetLogFields(target)),
    ),
    Effect.catch((cause) =>
      Effect.logDebug("ssh.target.resolve.fallback", { alias: trimmedAlias, cause }).pipe(
        Effect.as({
          alias: trimmedAlias,
          hostname: trimmedAlias,
          username: null,
          port: null,
          ...(executionSource === undefined ? {} : { executionSource }),
        }),
      ),
    ),
  );
});
