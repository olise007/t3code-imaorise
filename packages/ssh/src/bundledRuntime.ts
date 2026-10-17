import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { runSshCommand, getLastNonEmptyOutputLine } from "./command.ts";
import type { SshAuthOptions } from "./auth.ts";
import { isSshAuthFailure } from "./auth.ts";
import { SshLaunchError } from "./errors.ts";
import {
  inspectAndPrepare,
  linuxInspectionScript,
  windowsInspectionScript,
  runtimeRequirements,
} from "./prerequisites.ts";
import type { SshRuntimeRequirements } from "@t3tools/contracts";

export interface BundledSshArchives {
  readonly version: string;
  readonly linux: {
    readonly path: string;
    readonly sha256: string;
    readonly requirements?: SshRuntimeRequirements;
  };
  readonly windows: {
    readonly path: string;
    readonly sha256: string;
    readonly requirements?: SshRuntimeRequirements;
  };
}
export interface PreparedSshRuntime {
  readonly platform: "linux" | "windows";
  readonly relativeExecutable: string;
  readonly version: string;
  readonly selectedProviders?: readonly string[];
}

const quotePs = (value: string) => `'${value.replaceAll("'", "''")}'`;
export const powershellArgs = (script: string) => [
  "powershell.exe",
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-EncodedCommand",
  Buffer.from(
    `$ProgressPreference='SilentlyContinue'; $env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+$env:PSModulePath; $env:Path+=';'+[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User'); [Console]::InputEncoding=New-Object Text.UTF8Encoding($false); [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); $OutputEncoding=[Console]::OutputEncoding; ${script}`,
    "utf16le",
  ).toString("base64"),
];

// The outer command is shell-independent ASCII. The actual script is transferred
// on stdin into a private user temporary file and removed even if execution fails.
export const powershellFileArgs = () =>
  powershellArgs(
    // Preference variables do not cross the child PowerShell process boundary.
    `$ErrorActionPreference='Stop'; $p=Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString()+'.ps1'); try { [IO.File]::WriteAllText($p,'$ProgressPreference=''SilentlyContinue'''+[Environment]::NewLine+[Console]::In.ReadToEnd(),(New-Object Text.UTF8Encoding($true))); & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $p; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE} } finally { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue }`,
  );

export const remoteRuntimeInvocation = (
  runtime: PreparedSshRuntime,
  args: ReadonlyArray<string>,
) =>
  runtime.platform === "windows"
    ? {
        remoteCommandArgs: powershellFileArgs(),
        stdin: `$ErrorActionPreference='Stop'\nSet-Location -LiteralPath $HOME\n& (Join-Path $HOME ${quotePs(runtime.relativeExecutable)}) ${args.map(quotePs).join(" ")}\nif($LASTEXITCODE -ne 0){exit $LASTEXITCODE}\n`,
      }
    : {
        remoteCommandArgs: ["sh", "-l", "-s"],
        stdin: `set -eu\ncd "$HOME"\nexec "$HOME"/'${runtime.relativeExecutable}' ${args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ")}\n`,
      };

export const detectRemotePlatform = Effect.fn("ssh.runtime.detect")(function* (
  target: DesktopSshEnvironmentTarget,
  auth: SshAuthOptions,
) {
  const linux = yield* Effect.result(
    runSshCommand(target, { ...auth, remoteCommandArgs: ["uname", "-sm"] }),
  );
  if (
    linux._tag === "Success" &&
    getLastNonEmptyOutputLine(linux.success.stdout)?.startsWith("Linux ")
  ) {
    if (getLastNonEmptyOutputLine(linux.success.stdout) !== "Linux x86_64")
      return yield* new SshLaunchError({
        message: "Automatic SSH setup supports Linux x64 and Windows x64 only.",
        stdout: "",
      });
    return "linux" as const;
  }
  if (
    linux._tag === "Success" &&
    !/^(MINGW|MSYS|CYGWIN)/.test(getLastNonEmptyOutputLine(linux.success.stdout) ?? "")
  ) {
    return yield* new SshLaunchError({
      message: "Automatic SSH setup supports Linux x64 and Windows x64 only.",
      stdout: "",
    });
  }
  if (linux._tag === "Failure" && isSshAuthFailure(linux.failure)) return yield* linux.failure;
  const windows = yield* runSshCommand(target, {
    ...auth,
    remoteCommandArgs: powershellArgs(
      `if([Environment]::Is64BitOperatingSystem -and $env:PROCESSOR_ARCHITECTURE -ne 'ARM64'){Write-Output 'windows-x64'}else{exit 1}`,
    ),
  });
  if (getLastNonEmptyOutputLine(windows.stdout) !== "windows-x64")
    return yield* new SshLaunchError({
      message: "The remote host is unsupported or cannot run PowerShell.",
      stdout: "",
    });
  return "windows" as const;
});

export function linuxInstallScript(hash: string, suffix = "") {
  return `set -eu
umask 077
root="$HOME/.t3-imaorise/runtime/sha256-${hash}"
archive="$HOME/.t3-imaorise/runtime/upload-${hash}${suffix}.tar.gz"
if [ -x "$root/t3" ] && [ "$(cat "$root/.archive-sha256" 2>/dev/null)" = '${hash}' ]; then "$root/t3" --version >/dev/null; "$root/t3" __ssh-helper verify-runtime >/dev/null; exit 0; fi
mkdir -p "$HOME/.t3-imaorise/runtime"
if ! mkdir "$root.lock" 2>/dev/null; then printf 'Another runtime setup is in progress; retry when it finishes.\\n' >&2; exit 1; fi
trap 'rmdir "$root.lock" 2>/dev/null || true; rm -f "$archive"' EXIT
stage=$(mktemp -d "$HOME/.t3-imaorise/runtime/.stage-XXXXXX")
trap 'rm -rf "$stage" "$root.lock"; rm -f "$archive"' EXIT
trap 'exit 130' HUP INT TERM
if command -v sha256sum >/dev/null; then actual=$(sha256sum "$archive" | cut -d' ' -f1); else actual=$(shasum -a 256 "$archive" | cut -d' ' -f1); fi
[ "$actual" = '${hash}' ] || { printf 'Runtime checksum mismatch\\n' >&2; exit 1; }
tar -xzf "$archive" -C "$stage" --strip-components=1
"$stage/t3" --version >/dev/null
"$stage/t3" __ssh-helper verify-runtime >/dev/null
printf '%s' '${hash}' > "$stage/.archive-sha256"
[ ! -e "$root" ] || { printf 'Existing runtime requires inspection\\n' >&2; exit 1; }
mv "$stage" "$root"
`;
}

/** Check the destination filesystem before uploading; activation never removes old runtimes. */
export function runtimeStorageScript(
  platform: "linux" | "windows",
  archiveBytes: number,
  requirements?: SshRuntimeRequirements,
) {
  // Older sidecars lack payload measurements. Use a conservative estimate for
  // those archives; current builds ship measured logical sizes and entry counts.
  const unpackedBytes = requirements?.unpackedBytes;
  const entries = requirements?.unpackedEntries;
  const validEntries =
    entries !== undefined && Number.isSafeInteger(entries) && entries >= 0 ? entries : 0;
  const requiredBytes = Math.ceil(
    archiveBytes +
      (unpackedBytes !== undefined && Number.isSafeInteger(unpackedBytes) && unpackedBytes >= 0
        ? unpackedBytes
        : archiveBytes * 8) +
      validEntries * 4096 +
      64 * 1024 * 1024,
  );
  if (platform === "windows")
    return `$ErrorActionPreference='Stop'
$probe=Join-Path $HOME '.t3-imaorise/runtime'
while(!(Test-Path -LiteralPath $probe -PathType Container)){$probe=Split-Path -LiteralPath $probe}
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; namespace T3 { public static class RuntimeStorage { [DllImport("kernel32.dll", EntryPoint="GetDiskFreeSpaceExW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool Available(string path, out ulong free, out ulong total, out ulong totalFree); } }'
[UInt64]$free=0; [UInt64]$total=0; [UInt64]$totalFree=0
if(![T3.RuntimeStorage]::Available($probe,[ref]$free,[ref]$total,[ref]$totalFree)){throw 'Cannot determine free space for the remote runtime destination. Check home-directory access.'}
if($free -lt ${requiredBytes}){throw "Insufficient remote runtime storage: need ${requiredBytes} bytes free, available $free bytes. Free space on the destination drive and retry setup."}
`;
  return `set -eu
probe="$HOME/.t3-imaorise/runtime"
while [ ! -d "$probe" ]; do probe=$(dirname "$probe"); done
available=$(LC_ALL=C df -Pk "$probe" | awk 'NR == 2 {print $4}')
case "$available" in ''|*[!0-9]*) printf 'Cannot determine free space for the remote runtime. Check the destination filesystem.\\n' >&2; exit 1;; esac
if [ "$available" -lt ${Math.ceil(requiredBytes / 1024)} ]; then printf 'Insufficient remote runtime storage: need ${Math.ceil(requiredBytes / 1024)} KiB free; available %s KiB. Free space on the destination filesystem and retry setup.\\n' "$available" >&2; exit 1; fi
${
  validEntries > 0
    ? `available=$(LC_ALL=C df -Pi "$probe" 2>/dev/null | awk 'NR == 2 {print $4}')
case "$available" in ''|*[!0-9]*) ;; *) if [ "$available" -lt ${validEntries + 64} ]; then printf 'Insufficient free file entries (inodes) for the remote runtime: need ${validEntries + 64}; available %s. Free file entries and retry setup.\\n' "$available" >&2; exit 1; fi;; esac`
    : ""
}
`;
}

export function windowsInstallScript(hash: string, suffix = "") {
  return `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$parent=Join-Path $HOME '.t3-imaorise/runtime'
$root=Join-Path $parent 'sha256-${hash}'
$archive=Join-Path $parent 'upload-${hash}${suffix}.zip'
if((Test-Path -LiteralPath "$root/t3.exe") -and (Test-Path -LiteralPath "$root/.archive-sha256") -and ((Get-Content -LiteralPath "$root/.archive-sha256" -Raw) -eq '${hash}')){ & "$root/t3.exe" --version | Out-Null; if($LASTEXITCODE -ne 0){throw 'Runtime failed its readiness check'}; & "$root/t3.exe" __ssh-helper verify-runtime | Out-Null; if($LASTEXITCODE -ne 0){throw 'Runtime native components failed their readiness check'}; exit 0 }
$lock=Join-Path $parent 'sha256-${hash}.lock'
$handle=[IO.File]::Open($lock,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
$stage=Join-Path $parent ('.stage-'+[Guid]::NewGuid().ToString())
try {
 if((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne '${hash}'){throw 'Runtime checksum mismatch'}
 Expand-Archive -LiteralPath $archive -DestinationPath $stage
 $entry=@(Get-ChildItem -LiteralPath $stage -Filter t3.exe -Recurse)
 if($entry.Count -ne 1){throw 'Runtime archive has no unique entry point'}
 & $entry[0].FullName --version | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Runtime failed its readiness check'}
 & $entry[0].FullName __ssh-helper verify-runtime | Out-Null
 if($LASTEXITCODE -ne 0){throw 'Runtime native components failed their readiness check'}
 [IO.File]::WriteAllText((Join-Path $entry[0].DirectoryName '.archive-sha256'),'${hash}')
 if(Test-Path -LiteralPath $root){throw 'Existing runtime requires inspection'}
 Move-Item -LiteralPath $entry[0].DirectoryName -Destination $root
} finally { $handle.Dispose(); Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue }
`;
}

const sourceArchivePath = Effect.fn("ssh.runtime.sourceArchivePath")(function* (
  target: DesktopSshEnvironmentTarget,
  path: string,
) {
  const source = target.executionSource;
  if (source?.type !== "wsl") return path;
  if ((yield* HostProcess.Platform) !== "win32")
    return yield* new SshLaunchError({
      message: "The saved WSL SSH source requires Windows.",
      stdout: "",
    });
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make("wsl.exe", [
          "--distribution",
          source.distro,
          "--exec",
          "wslpath",
          "-u",
          path,
        ]),
      );
      const [stdout, , code] = yield* Effect.all(
        [
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.stderr.pipe(Stream.runDrain),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      const resolved = stdout.trim();
      if (code !== 0 || !resolved.startsWith("/") || /[\x00\r\n]/u.test(resolved))
        return yield* new SshLaunchError({
          message:
            "The selected WSL distro cannot access the bundled runtime archive. Check Windows-drive access in that distro.",
          stdout: "",
        });
      return resolved;
    }),
  ).pipe(
    Effect.timeout("10 seconds"),
    Effect.mapError(
      (cause) =>
        new SshLaunchError({
          message:
            "Could not resolve the runtime archive inside the saved WSL SSH source. Check that distro's Windows-drive access.",
          stdout: "",
          cause,
        }),
    ),
  );
});

/** Native SFTP avoids PowerShell 5.1's large redirected-input stalls. */
export const uploadRuntimeArchive = Effect.fn("ssh.runtime.upload")(function* (
  target: DesktopSshEnvironmentTarget,
  auth: SshAuthOptions,
  platform: "linux" | "windows",
  localPath: string,
  hash: string,
  suffix: string,
) {
  if (!/^[a-f0-9]{64}$/u.test(hash) || !/^[-a-zA-Z0-9]*$/u.test(suffix))
    return yield* new SshLaunchError({
      message: "The runtime upload identity is invalid.",
      stdout: "",
    });
  const name = `upload-${hash}${suffix}.${platform === "windows" ? "zip" : "tar.gz"}`;
  const destination = yield* runSshCommand(target, {
    ...auth,
    remoteCommandArgs: platform === "windows" ? powershellFileArgs() : ["sh", "-s"],
    stdin:
      platform === "windows"
        ? `$ErrorActionPreference='Stop'; $d=Join-Path $HOME '.t3-imaorise/runtime'; [IO.Directory]::CreateDirectory($d)|Out-Null; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Join-Path $d '${name}')))`
        : `set -eu\numask 077\nmkdir -p "$HOME/.t3-imaorise/runtime"\nprintf '%s' "$HOME/.t3-imaorise/runtime/${name}" | base64 | tr -d '\\n'\nprintf '\\n'\n`,
  });
  const encoded = getLastNonEmptyOutputLine(destination.stdout) ?? "";
  const path = Buffer.from(encoded, "base64").toString("utf8");
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) ||
    encoded.length > 65536 ||
    /[\x00\r\n]/u.test(path) ||
    !(platform === "windows" ? /^(?:[A-Za-z]:[\\/]|[\\/]{2})/u.test(path) : path.startsWith("/"))
  )
    return yield* new SshLaunchError({
      message: "SSH returned an invalid runtime destination for the login user.",
      stdout: "",
    });
  const remotePath =
    platform === "windows" ? path.replaceAll("\\", "/").replace(/^([A-Za-z]:)/u, "/$1") : path;
  yield* runSshCommand(target, {
    ...auth,
    upload: { localPath: yield* sourceArchivePath(target, localPath), remotePath },
    timeoutMs: 300_000,
  });
});

export const prepareBundledRuntime = Effect.fn("ssh.runtime.prepare")(function* (
  target: DesktopSshEnvironmentTarget,
  auth: SshAuthOptions,
  bundles: BundledSshArchives,
  progress: (stage: string) => Effect.Effect<void> = () => Effect.void,
  setup: { readonly supportsReview?: boolean; readonly reviewRequested?: boolean } = {},
) {
  const platform = yield* detectRemotePlatform(target, auth);
  const archive = platform === "windows" ? bundles.windows : bundles.linux;
  if (
    archive.requirements?.architecture !== undefined &&
    archive.requirements.architecture !== "x64"
  )
    return yield* new SshLaunchError({
      message:
        "This desktop installation does not bundle the x64 server runtime required by the selected remote host.",
      stdout: "",
    });
  if (!/^[a-f0-9]{64}$/.test(archive.sha256))
    return yield* new SshLaunchError({
      message: "The bundled SSH runtime has no valid checksum.",
      stdout: "",
    });
  const hash = archive.sha256;
  yield* progress("Verifying bundled runtime…");
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* fs.readFile(archive.path).pipe(
    Effect.mapError(
      (cause) =>
        new SshLaunchError({
          message: "The matching bundled SSH runtime is missing. Reinstall this desktop build.",
          stdout: "",
          cause,
        }),
    ),
  );
  const actual = Hex.encode(yield* crypto.digest("SHA-256", bytes).pipe(Effect.orDie));
  if (actual !== archive.sha256)
    return yield* new SshLaunchError({
      message: "The bundled SSH runtime failed checksum verification.",
      stdout: "",
    });
  const selectedProviders = yield* inspectAndPrepare({
    target,
    auth,
    requirements: archive.requirements ?? runtimeRequirements(platform, bundles.version),
    supportsReview: setup.supportsReview === true,
    reviewRequested: false,
    providers: [],
    progress,
    windowsCommand: powershellFileArgs(),
    inspect: () =>
      runSshCommand(target, {
        ...auth,
        remoteCommandArgs: platform === "windows" ? powershellFileArgs() : ["sh", "-l", "-s"],
        stdin: platform === "windows" ? windowsInspectionScript : linuxInspectionScript,
      }),
  });
  const runtime: PreparedSshRuntime = {
    platform,
    relativeExecutable: `.t3-imaorise/runtime/sha256-${hash}/${platform === "windows" ? "t3.exe" : "t3"}`,
    version: bundles.version,
    selectedProviders,
  };
  yield* progress("Checking the installed remote runtime…");
  const warm = yield* Effect.result(
    runSshCommand(target, { ...auth, ...remoteRuntimeInvocation(runtime, ["--version"]) }),
  );
  if (warm._tag === "Success" && warm.success.stdout.includes(bundles.version)) {
    yield* runSshCommand(target, {
      ...auth,
      ...remoteRuntimeInvocation(runtime, ["__ssh-helper", "verify-runtime"]),
    });
    return runtime;
  }
  const suffix = `-${Hex.encode(yield* crypto.randomBytes(8).pipe(Effect.orDie))}`;
  yield* progress("Checking remote storage capacity…");
  yield* runSshCommand(target, {
    ...auth,
    remoteCommandArgs: platform === "windows" ? powershellFileArgs() : ["sh", "-s"],
    stdin: runtimeStorageScript(platform, bytes.length, archive.requirements),
  });
  yield* progress("Transferring the matching runtime over SSH…");
  yield* Effect.gen(function* () {
    yield* uploadRuntimeArchive(target, auth, platform, archive.path, hash, suffix);
    yield* progress("Verifying and installing remote runtime…");
    yield* runSshCommand(target, {
      ...auth,
      remoteCommandArgs: platform === "windows" ? powershellFileArgs() : ["sh", "-s"],
      stdin:
        platform === "windows"
          ? windowsInstallScript(hash, suffix)
          : linuxInstallScript(hash, suffix),
      timeoutMs: 120_000,
    });
  }).pipe(
    Effect.ensuring(
      runSshCommand(target, {
        ...auth,
        remoteCommandArgs:
          platform === "windows"
            ? powershellArgs(
                `Remove-Item -LiteralPath (Join-Path $HOME '.t3-imaorise/runtime/upload-${hash}${suffix}.zip') -Force -ErrorAction SilentlyContinue`,
              )
            : ["sh", "-c", `'rm -f "$HOME/.t3-imaorise/runtime/upload-${hash}${suffix}.tar.gz"'`],
        timeoutMs: 10_000,
      }).pipe(Effect.ignore),
    ),
  );
  return runtime;
});
