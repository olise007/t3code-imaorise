import type { DesktopSshEnvironmentTarget, DesktopSshExecutionSource } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  buildSshChildEnvironment,
  isSshAuthFailure,
  retainSshAuthenticationHelper,
  type SshAuthOptions,
} from "./auth.ts";
import { SshCommandError, SshInvalidTargetError } from "./errors.ts";
import { snapshotUserTrust, userTrustPaths } from "./hostTrust.ts";
import { createSetupDetails, sanitizeSetupOutput } from "./setupDetails.ts";

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
  /** Internal file transfer: OpenSSH SCP's SFTP mode, with the same source and authentication. */
  readonly upload?: { readonly localPath: string; readonly remotePath: string };
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
IFS= read -r trust_paths
umask 077
inspection=false
for arg do if [ "$arg" = "-G" ]; then inspection=true; fi; done
if [ -z "$trust_paths" ] && [ "$inspection" = false ]; then mkdir -p "$HOME/.t3-imaorise/ssh"; fi
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
program=$1
shift
if [ -n "$trust_paths" ]; then
  printf '%s' "$trust_paths" | base64 -d > "$helper/trust-paths"
  trust_files=""
  index=0
  while IFS= read -r original; do
    case "$original" in
      none|NUL|/dev/null) trust_files="$trust_files \"$original\""; continue ;;
      '~/'*) original="$HOME/$(printf '%s' "$original" | cut -c3-)" ;;
    esac
    case "$original" in *'%'*|*'$'*) printf 'Unsupported SSH trust path expansion\n' >&2; exit 1 ;; esac
    copy="$helper/known-hosts-$index"
    if [ -e "$original" ]; then cat "$original" > "$copy"; else
      if [ -L "$original" ]; then printf 'Unreadable SSH trust file\n' >&2; exit 1; fi
      : > "$copy"
    fi
    quoted=$(printf '%s' "$copy" | sed 's/\\/\\\\/g;s/"/\\"/g')
    trust_files="$trust_files \"$quoted\""
    index=$((index + 1))
  done < "$helper/trust-paths"
  set -- -o "UpdateHostKeys=no" -o "UserKnownHostsFile=$trust_files" "$@"
fi
"$program" "$@"
`;

export const prepareSshSpawn = Effect.fn("ssh/command.prepareSshSpawn")(function* (
  target: DesktopSshEnvironmentTarget,
  args: ReadonlyArray<string>,
  input: SshAuthOptions & {
    readonly stdin?: Stream.Stream<Uint8Array>;
    readonly sourceCommand?: "ssh" | "scp";
    readonly readOnlyTrustPaths?: readonly string[];
  },
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
    if (target.executionSource?.type !== "wsl" && !input.readOnlyTrustPaths)
      yield* fs.makeDirectory(trust, { recursive: true, mode: 0o700 }).pipe(Effect.orDie);
    manualArgs.push(
      "-o",
      `UserKnownHostsFile="${target.executionSource?.type === "wsl" ? "~/.t3-imaorise/ssh/known_hosts" : path.join(trust, "known_hosts").replaceAll("\\", "/").replaceAll('"', '\\"')}"`,
    );
  }
  const trustArgs =
    input.readOnlyTrustPaths && target.executionSource?.type !== "wsl"
      ? [
          "-o",
          "UpdateHostKeys=no",
          "-o",
          `UserKnownHostsFile=${input.readOnlyTrustPaths.map((file) => '"' + file.replaceAll("\\", "/").replaceAll('"', '\\"') + '"').join(" ")}`,
        ]
      : [];
  const sshArgs = [...trustArgs, ...manualArgs, ...args];
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
        input.sourceCommand ?? "ssh",
        ...sshArgs,
      ],
      env: {},
      stdin: Stream.concat(
        Stream.make(
          encoder.encode(
            `${Buffer.from(input.authSecret ?? "").toString("base64")}\n${Buffer.from(input.trustedHostPrompt ?? "").toString("base64")}\n${Buffer.from(input.readOnlyTrustPaths ? input.readOnlyTrustPaths.join("\n") + "\n" : "").toString("base64")}\n`,
          ),
        ),
        input.stdin ?? Stream.empty,
      ),
    };
  }
  return {
    command:
      input.sourceCommand === "scp"
        ? (yield* HostProcess.Platform) === "win32"
          ? "scp.exe"
          : "scp"
        : yield* resolveSshCommand,
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
  // Editing a manual profile's label, authentication or execution source must
  // reconnect to its existing managed server. Local tunnel and credential keys
  // still use the full target identity; remote state belongs to the stable profile.
  const identity = target.manual
    ? yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))([
        "manual",
        target.manual.profileId,
      ]).pipe(Effect.orDie)
    : targetConnectionKey(target);
  const digest = yield* crypto.digest("SHA-256", encoder.encode(identity)).pipe(Effect.orDie);
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
      (acc, chunk) => (acc + chunk).slice(-1024 * 1024),
    ),
  );

function redactSshErrorOutput(output: string, preserveAuthEvidence = false): string {
  // The authentication layer consumes these internal challenge records. They
  // must survive in the typed error, but not display messages or command logs.
  const evidence = preserveAuthEvidence
    ? [...output.matchAll(/^T3_SSH_(?:AUTH_)?PROMPT:[A-Za-z0-9+/=]{1,3000}(?=\r?$)/gmu)].map(
        (match) => match[0],
      )
    : [];
  const redacted =
    [
      ...evidence,
      sanitizeSetupOutput(
        output.replace(
          /("(?:access_token|bearerToken|credential|pairingToken|token)"\s*:\s*")[^"]+(")/giu,
          "$1[redacted]$2",
        ),
      ),
    ].join("\n") + (output.endsWith("\n") ? "\n" : "");
  return redacted.length > MAX_SSH_ERROR_OUTPUT_LENGTH
    ? `${redacted.slice(0, MAX_SSH_ERROR_OUTPUT_LENGTH)}\n[truncated]`
    : redacted;
}

function normalizeSshErrorMessage(input: {
  readonly stdout?: string;
  readonly stderr: string;
  readonly fallbackMessage: string;
}): string {
  const cleanedStderr = sanitizeSetupOutput(input.stderr).trim();
  const substantiveStderr = cleanedStderr
    .split(/\r?\n/)
    .filter(
      (line) => !/^Warning: Permanently added .* to the list of known hosts\.$/u.test(line.trim()),
    )
    .join("\n")
    .trim();
  const cleanedStdout = sanitizeSetupOutput(input.stdout ?? "").trim();
  if (
    /no space left on device|not enough space on (?:the )?disk|disk (?:is )?full/iu.test(
      `${substantiveStderr}\n${cleanedStdout}`,
    )
  ) {
    return "The remote host ran out of storage while preparing the runtime. Free space and file entries on the filesystem containing the remote user's .t3-imaorise directory, then retry setup. Existing servers have not been replaced.";
  }
  if (substantiveStderr.length > 0) return substantiveStderr;

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
  const host = target.manual
    ? target.hostname.trim()
    : target.alias.trim() || target.hostname.trim();
  const bracketedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const transferHost = target.username ? `${target.username}@${bracketedHost}` : bracketedHost;
  const sourceSsh = target.executionSource?.type === "wsl" ? "ssh" : yield* resolveSshCommand;
  const args = input.upload
    ? [
        "-s",
        "-S",
        sourceSsh,
        "-o",
        `BatchMode=${input.batchMode ?? (input.interactiveAuth ? "no" : "yes")}`,
        "-o",
        "ConnectTimeout=10",
        "-o",
        "StrictHostKeyChecking=ask",
        ...(target.port === null ? [] : ["-P", String(target.port)]),
        "--",
        input.upload.localPath,
        `${transferHost}:${input.upload.remotePath}`,
      ]
    : [
        ...baseSshArgs(target, {
          batchMode: input.batchMode ?? (input.interactiveAuth ? "no" : "yes"),
        }),
        ...(input.preHostArgs ?? []),
        hostSpec,
        ...(input.remoteCommandArgs ?? []),
      ];
  let readOnlyTrustPaths: readonly string[] | undefined;
  if (input.readOnlyHostTrust) {
    // -G inspects the selected source's configuration; it never opens a connection.
    let paths: readonly string[];
    if (target.manual) {
      const path = yield* Path.Path;
      const home = yield* HostProcess.HomeDirectory;
      // Manual profile boundaries are authoritative, including homes containing spaces.
      paths = [
        target.executionSource?.type === "wsl"
          ? "~/.t3-imaorise/ssh/known_hosts"
          : path.join(home, ".t3-imaorise", "ssh", "known_hosts"),
      ];
    } else {
      const config = yield* runSshCommand(target, {
        preHostArgs: ["-G", ...(input.preHostArgs ?? [])],
        timeoutMs: 5_000,
      });
      const sourceHome =
        target.executionSource?.type === "wsl" ? undefined : yield* HostProcess.HomeDirectory;
      paths = yield* Effect.try({
        try: () => userTrustPaths(config.stdout, sourceHome),
        catch: (cause) =>
          new SshInvalidTargetError({
            message:
              cause instanceof Error ? cause.message : "Could not inspect SSH trust configuration.",
          }),
      });
    }
    if (target.executionSource?.type === "wsl") readOnlyTrustPaths = paths;
    else {
      const copies = yield* snapshotUserTrust(paths).pipe(
        Effect.provideService(Scope.Scope, commandScope),
        Effect.mapError(
          (cause) =>
            new SshInvalidTargetError({
              message: `Could not safely inspect SSH trust files: ${cause instanceof Error ? cause.message : "Check file permissions."}`,
            }),
        ),
      );
      readOnlyTrustPaths = copies;
    }
  }
  const prepared = yield* prepareSshSpawn(target, args, {
    ...auth,
    ...(readOnlyTrustPaths ? { readOnlyTrustPaths } : {}),
    ...(input.upload ? { sourceCommand: "scp" as const } : {}),
    stdin:
      input.stdinBytes === undefined ? stdinStream(input.stdin) : Stream.make(input.stdinBytes),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: ["ssh"],
          exitCode: null,
          stderr: "",
          message: `Failed to prepare SSH authentication helpers. ${sanitizeSetupOutput(cause instanceof Error ? cause.message : "Check Windows PowerShell availability and temporary-directory access.").slice(0, 600)}`,
          cause,
        }),
    ),
  );
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* retainSshAuthenticationHelper(prepared.env, commandScope);
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
        stdin: "pipe",
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

  // Observe input failures rather than letting the spawner's detached input
  // fiber fail silently. Read stderr through exit before reporting pipe errors.
  const inputFiber = yield* Stream.run(prepared.stdin, child.stdin).pipe(
    Effect.result,
    Effect.forkIn(commandScope),
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
          command: [sshCommand, ...args],
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
      : redactSshErrorOutput(stderr, input.interactiveAuth === true);
    yield* Effect.logWarning("ssh.command.failed", {
      ...sshTargetLogFields(target),
      command: [sshCommand, ...args],
      exitCode,
      stdout: diagnosticStdout,
      stderr: sanitizeSetupOutput(diagnosticStderr),
    });
    if (input.onDetails)
      yield* input.onDetails(
        `SSH command failed (exit ${exitCode}).\n${diagnosticStderr}\n${diagnosticStdout}`.slice(
          0,
          8192,
        ),
      );
    return yield* new SshCommandError({
      command: [sshCommand, ...args],
      exitCode,
      stdout: diagnosticStdout,
      stderr: diagnosticStderr,
      message:
        !input.sensitiveInput && isSshAuthFailure(new Error(stderr))
          ? "SSH authentication failed. Check the selected user and authentication method."
          : input.upload && /subsystem request failed|sftp-server.*not found/iu.test(stderr)
            ? "The remote SSH server could not start SFTP. Enable its standard OpenSSH SFTP subsystem before retrying runtime setup."
            : normalizeSshErrorMessage({
                stdout: diagnosticStdout,
                stderr: diagnosticStderr,
                fallbackMessage: `SSH command failed for ${hostSpec} (exit ${exitCode}).`,
              }),
    });
  }

  const inputResult = yield* Fiber.join(inputFiber);
  if (Result.isFailure(inputResult)) {
    return yield* new SshCommandError({
      command: [sshCommand, ...args],
      exitCode,
      stdout: input.sensitiveInput ? "" : redactSshErrorOutput(stdout),
      stderr: input.sensitiveInput ? "" : redactSshErrorOutput(stderr),
      message:
        "SSH closed its input before the transfer completed. Check the remote destination's free space and write permissions, then retry setup.",
      cause: inputResult.failure,
    });
  }

  yield* Effect.logDebug("ssh.command.succeeded", {
    ...sshTargetLogFields(target),
    command: [sshCommand, ...args],
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
