// @effect-diagnostics nodeBuiltinImport:off - Windows askpass must be a native executable to preserve multiline OpenSSH arguments.
import * as NodeChildProcess from "node:child_process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";

import { SshPasswordPromptError } from "./errors.ts";
import type { SshSetupApproval, SshSetupReview } from "@t3tools/contracts";

export interface SshPasswordRequest {
  readonly challenge?: "host-key" | "password" | "key-passphrase";
  readonly purpose?: "ssh" | "elevation" | "setup-review";
  readonly setupReview?: SshSetupReview;
  readonly destination: string;
  readonly username: string | null;
  readonly prompt: string;
  readonly attempt: number;
}

interface SshAskpassFile {
  readonly path: string;
  readonly contents: string;
  readonly mode?: number;
}

export interface SshAskpassHelperDescriptor {
  readonly launcherPath: string;
  readonly files: ReadonlyArray<SshAskpassFile>;
}

export interface SshAuthOptions {
  readonly readOnlyHostTrust?: boolean;
  readonly trustedHostPrompt?: string;
  readonly authSecret?: string | null;
  readonly batchMode?: "yes" | "no";
  readonly interactiveAuth?: boolean;
}

export interface SshPasswordPromptShape {
  readonly reviewSetup?: (
    review: SshSetupReview,
  ) => Effect.Effect<SshSetupApproval, SshPasswordPromptError>;
  readonly isAvailable: boolean;
  readonly request: (
    request: SshPasswordRequest,
  ) => Effect.Effect<string | null, SshPasswordPromptError>;
}

export class SshPasswordPrompt extends Context.Service<SshPasswordPrompt, SshPasswordPromptShape>()(
  "@t3tools/ssh/auth/SshPasswordPrompt",
) {
  static readonly disabledLayer = Layer.succeed(
    SshPasswordPrompt,
    SshPasswordPrompt.of({
      isAvailable: false,
      request: () => Effect.succeed(null),
    }),
  );
}

export interface SshChildEnvironmentOptions {
  readonly trustedHostPrompt?: string;
  readonly interactiveAuth?: boolean;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly askpassDirectory?: string;
  readonly authSecret?: string | null;
}

const SSH_ASKPASS_DIR_NAME = "t3code-ssh-askpass";

function joinSshAskpassPath(
  directory: string,
  fileName: string,
  platform: NodeJS.Platform,
): string {
  const trimmed = directory.replace(/[\\/]+$/u, "");
  return platform === "win32" ? `${trimmed}\\${fileName}` : `${trimmed}/${fileName}`;
}

const ASKPASS_POSIX_SCRIPT = `#!/bin/sh
# Invoked by ssh via SSH_ASKPASS when T3 Code re-runs ssh with a cached password
# from the renderer's in-app prompt. Missing credentials request a typed
# challenge during authentication preflight; they are not a launcher failure.
if [ -n "\${T3_SSH_TRUST_PROMPT:-}" ] && [ "$*" = "$T3_SSH_TRUST_PROMPT" ]; then printf 'yes\\n'; exit 0; fi
case "$*" in *'yes/no'*|*'SHA256:'*) printf 'T3_SSH_PROMPT:%s\\n' "$(printf '%s' "$*" | base64 | tr -d '\\n')" >&2; exit 1 ;; esac
if [ "\${T3_SSH_AUTH_SECRET+x}" = "x" ]; then
  printf "%s\\n" "$T3_SSH_AUTH_SECRET"
  exit 0
fi
printf 'T3_SSH_AUTH_PROMPT:%s\\n' "$(printf '%s' "$*" | base64 | tr -d '\\n')" >&2
exit 1
`;

const ASKPASS_WINDOWS_SOURCE = `using System;
using System.Text;
public static class T3SshAskpass {
  public static int Main(string[] args) {
    Console.OutputEncoding = new UTF8Encoding(false);
    string prompt = String.Join(" ", args);
    string trusted = Environment.GetEnvironmentVariable("T3_SSH_TRUST_PROMPT");
    if (!String.IsNullOrEmpty(trusted) && String.Equals(prompt, trusted, StringComparison.Ordinal)) { Console.WriteLine("yes"); return 0; }
    bool confirm = Environment.GetEnvironmentVariable("SSH_ASKPASS_PROMPT") == "confirm" || prompt.Contains("yes/no") || prompt.Contains("SHA256:");
    if (confirm) { Console.Error.WriteLine("T3_SSH_PROMPT:" + Convert.ToBase64String(Encoding.UTF8.GetBytes(prompt))); return 1; }
    string secret = Environment.GetEnvironmentVariable("T3_SSH_AUTH_SECRET");
    if (secret != null) { Console.WriteLine(secret); return 0; }
    Console.Error.WriteLine("T3_SSH_AUTH_PROMPT:" + Convert.ToBase64String(Encoding.UTF8.GetBytes(prompt)));
    return 1;
  }
}
`;

const getDefaultSshAskpassDirectory = Effect.fn("ssh/auth.getDefaultSshAskpassDirectory")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parentDirectory = yield* fs.makeTempDirectory({ prefix: "t3code-ssh-runtime-" });
    return path.join(parentDirectory, SSH_ASKPASS_DIR_NAME);
  },
);

export const buildSshAskpassHelperDescriptor = Effect.fn(
  "ssh/auth.buildSshAskpassHelperDescriptor",
)(function* (input: {
  readonly directory: string;
}): Effect.fn.Return<SshAskpassHelperDescriptor, never, Path.Path> {
  const platform = yield* HostProcess.Platform;
  const path = yield* Path.Path;
  const directory = input.directory;

  if (platform === "win32") {
    return {
      launcherPath: joinSshAskpassPath(directory, "ssh-askpass.exe", platform),
      files: [
        {
          path: joinSshAskpassPath(directory, "ssh-askpass.cs", platform),
          contents: ASKPASS_WINDOWS_SOURCE,
        },
      ],
    };
  }

  return {
    launcherPath: path.join(directory, "ssh-askpass.sh"),
    files: [
      {
        path: path.join(directory, "ssh-askpass.sh"),
        contents: ASKPASS_POSIX_SCRIPT,
        mode: 0o700,
      },
    ],
  };
});

const ensureSshAskpassHelpers = Effect.fn("ssh/auth.ensureSshAskpassHelpers")(function* (input: {
  readonly directory: string;
}): Effect.fn.Return<string, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const descriptor = yield* buildSshAskpassHelperDescriptor(input);
  const platform = yield* HostProcess.Platform;

  yield* fs.makeDirectory(path.dirname(descriptor.launcherPath), { recursive: true });

  for (const file of descriptor.files) {
    const existing = yield* fs.exists(file.path);
    const current = existing ? yield* fs.readFileString(file.path) : null;
    if (current !== file.contents) {
      yield* fs.writeFileString(file.path, file.contents);
    }
    if (file.mode !== undefined && platform !== "win32") {
      yield* fs.chmod(file.path, file.mode);
    }
  }

  if (platform === "win32" && !(yield* fs.exists(descriptor.launcherPath))) {
    // Windows PowerShell compiles a small .NET Framework console executable.
    // No prompt or credential is passed through cmd.exe or the compiler.
    yield* Effect.tryPromise({
      try: (signal) =>
        new Promise<void>((resolve, reject) => {
          NodeChildProcess.execFile(
            "powershell.exe",
            [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "$ErrorActionPreference='Stop'; Add-Type -Path $env:T3_SSH_HELPER_SOURCE -OutputAssembly $env:T3_SSH_HELPER_OUTPUT -OutputType ConsoleApplication",
            ],
            {
              signal,
              timeout: 20_000,
              windowsHide: true,
              env: {
                ...process.env,
                T3_SSH_HELPER_SOURCE: descriptor.files[0]!.path,
                T3_SSH_HELPER_OUTPUT: descriptor.launcherPath,
              },
            },
            (error) => (error ? reject(error) : resolve()),
          );
        }),
      catch: (cause) =>
        PlatformError.systemError({
          _tag: "Unknown",
          module: "SshAskpass",
          method: "compile",
          description:
            "Could not prepare the Windows authentication helper. Windows PowerShell and .NET Framework are required.",
          cause,
        }),
    });
  }
  return descriptor.launcherPath;
});

export const buildSshChildEnvironment = Effect.fn("ssh/auth.buildSshChildEnvironment")(function* (
  input: SshChildEnvironmentOptions = {},
): Effect.fn.Return<
  NodeJS.ProcessEnv,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const baseEnv = { ...input.baseEnv };
  if (!input.interactiveAuth) {
    return baseEnv;
  }

  const platform = yield* HostProcess.Platform;
  const hostDisplay = input.baseEnv
    ? input.baseEnv.DISPLAY
    : yield* Config.String("DISPLAY").pipe(
        Config.option,
        Effect.orElseSucceed(() => Option.none<string>()),
        Effect.map(Option.getOrUndefined),
      );
  const directory = input.askpassDirectory ?? (yield* getDefaultSshAskpassDirectory());
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sshAskpass = yield* ensureSshAskpassHelpers({ directory }).pipe(
    Effect.onExit((exit) =>
      exit._tag === "Failure" && input.askpassDirectory === undefined
        ? fs.remove(path.dirname(directory), { recursive: true, force: true }).pipe(Effect.ignore)
        : Effect.void,
    ),
  );

  return {
    ...baseEnv,
    SSH_ASKPASS: sshAskpass,
    SSH_ASKPASS_REQUIRE: "force",
    ...(input.trustedHostPrompt === undefined
      ? {}
      : { T3_SSH_TRUST_PROMPT: input.trustedHostPrompt }),
    ...(input.authSecret === undefined ? {} : { T3_SSH_AUTH_SECRET: input.authSecret ?? "" }),
    ...(platform === "win32" || baseEnv.DISPLAY || hostDisplay ? {} : { DISPLAY: "t3code" }),
  };
});

/** Remove only the temporary helper created by this operation after its SSH process exits. */
export const retainSshAuthenticationHelper = Effect.fn("ssh/auth.retainHelper")(function* (
  environment: NodeJS.ProcessEnv,
  scope: Scope.Scope,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const helper = environment.SSH_ASKPASS;
  if (!helper) return;
  const directory = path.dirname(helper);
  const parent = path.dirname(directory);
  if (
    path.basename(directory) !== SSH_ASKPASS_DIR_NAME ||
    !path.basename(parent).startsWith("t3code-ssh-runtime-")
  )
    return;
  yield* Scope.addFinalizer(
    scope,
    fs.remove(parent, { recursive: true, force: true }).pipe(Effect.ignore),
  );
});

export function isSshAuthFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    /permission denied \((?:publickey|password|keyboard-interactive|hostbased|gssapi-with-mic)[^)]*\)/u.test(
      normalized,
    ) ||
    /authentication failed/u.test(normalized) ||
    /too many authentication failures/u.test(normalized)
  );
}
