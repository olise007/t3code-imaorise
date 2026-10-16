import {
  SshRuntimeRequirements,
  SshSetupApproval,
  type DesktopSshEnvironmentTarget,
  type SshProviderChoice,
  type SshSetupReview,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SshPasswordPrompt, type SshAuthOptions } from "./auth.ts";
import { runSshCommand, targetConnectionKey } from "./command.ts";
import { SshLaunchError } from "./errors.ts";
import {
  PROVIDER_RECIPE_CATALOG,
  providerArchiveRecipe,
  NODE_PROVIDER_RUNTIME,
  NODE_PROVIDER_ENGINE_RANGE,
} from "@t3tools/shared/providerInstallRecipes";
import { satisfiesSemverRange } from "@t3tools/shared/semver";

// This fallback also serves old archives. New archives carry measured ABI floors.
export const runtimeRequirements = (
  platform: "linux" | "windows",
  version: string,
): SshRuntimeRequirements => ({
  schemaVersion: 1,
  runtimeVersion: version,
  platform,
  architecture: "x64",
  nodeVersion: "26.8.2",
  minimumGlibc: "2.28",
  minimumGlibcxx: "3.4.25",
  minimumKernel: "4.18",
  libraries:
    platform === "linux"
      ? ["libatomic.so.1", "libstdc++.so.6", "libgcc_s.so.1"]
      : ["VCRUNTIME140.dll", "MSVCP140.dll"],
});

export const linuxInspectionScript = `set -eu
export LC_ALL=C
machine=$(cat /etc/machine-id 2>/dev/null || true)
if [ -z "$machine" ]; then machine=$(cat /proc/sys/kernel/hostname 2>/dev/null || hostname); fi
printf 'identity=%s:%s:%s\\n' "$machine" "$(id -u)" "$HOME"
printf 'architecture=%s\\nkernel=%s\\n' "$(uname -m)" "$(uname -r)"
printf 'glibc=%s\\n' "$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')"
if [ -r /etc/os-release ]; then . /etc/os-release; fi
printf 'distribution=%s\\nfamily=%s\\n' "\${ID:-unknown}" "\${ID_LIKE:-}"
manager=none
case "\${ID:-} \${ID_LIKE:-}" in *debian*|*ubuntu*) if command -v apt-get >/dev/null; then manager=apt; fi ;; *fedora*|*rhel*|*centos*|*rocky*|*almalinux*) if command -v dnf >/dev/null; then manager=dnf; elif command -v yum >/dev/null; then manager=yum; fi ;; esac
printf 'manager=%s\\n' "$manager"
elevation=unavailable
if [ "$(id -u)" = 0 ]; then elevation=root; elif command -v sudo >/dev/null; then elevation=sudo; fi
printf 'elevation=%s\\n' "$elevation"
cache=$( (ldconfig -p 2>/dev/null || /sbin/ldconfig -p 2>/dev/null || true))
for lib in libatomic.so.1 libstdc++.so.6 libgcc_s.so.1; do
 file=$(printf '%s\\n' "$cache" | awk -v name="$lib" '$1 == name && /x86-64/ {print $NF; exit}')
 if [ -z "$file" ]; then for base in /lib/x86_64-linux-gnu /usr/lib/x86_64-linux-gnu /lib64 /usr/lib64; do if [ -r "$base/$lib" ]; then file="$base/$lib"; break; fi; done; fi
 printf '%s=%s\\n' "$lib" "$file"
 if [ "$lib" = libstdc++.so.6 ] && [ -n "$file" ]; then printf 'glibcxx=%s\\n' "$(grep -aoE 'GLIBCXX_[0-9]+\\.[0-9]+\\.[0-9]+' "$file" | sed 's/GLIBCXX_//' | sort -Vu | tail -1)"; fi
done
for tool in tar gzip sha256sum shasum git sudo node npm codex claude agent grok opencode antigravity pi muse; do
 printf 'tool.%s=%s\\n' "$tool" "$(command -v "$tool" 2>/dev/null || true)"
done
printf 'nodeVersion=%s\\n' "$(node --version 2>/dev/null || true)"
`;

export const windowsInspectionScript = `$ErrorActionPreference='Stop'
$env:Path+=';'+[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')
$principal=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$id=(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid
Write-Output ('identity='+$id+':'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value+':'+$HOME)
Write-Output ('architecture='+$env:PROCESSOR_ARCHITECTURE)
Write-Output ('kernel='+[Environment]::OSVersion.Version.ToString())
Write-Output ('powershell='+$PSVersionTable.PSVersion.ToString())
Write-Output 'distribution=windows'
Write-Output 'manager=windows'
if($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){Write-Output 'elevation=administrator'}else{Write-Output 'elevation=unavailable'}
foreach($lib in @('VCRUNTIME140.dll','MSVCP140.dll')){Write-Output ($lib+'='+[string](Test-Path -LiteralPath (Join-Path $env:WINDIR ('System32/'+$lib))))}
foreach($tool in @('git','node','npm','codex','claude','agent','grok','opencode','antigravity','pi','muse','winget.exe')){ $c=Get-Command $tool -ErrorAction SilentlyContinue; Write-Output ('tool.'+$tool+'='+$(if($c){$c.Source}else{''})) }
try { $nodeVersion=(& node --version 2>$null); Write-Output ('nodeVersion='+$nodeVersion) } catch { Write-Output 'nodeVersion=' }
$git=Get-Command git -ErrorAction SilentlyContinue
$bash=$env:CLAUDE_CODE_GIT_BASH_PATH
if(!$bash -and $git){$bash=Join-Path (Split-Path (Split-Path $git.Source -Parent) -Parent) 'bin/bash.exe'}
Write-Output ('gitbash='+[string][bool]($bash -and (Test-Path -LiteralPath $bash)))
Write-Output ('expand='+[string][bool](Get-Command Expand-Archive -ErrorAction SilentlyContinue))
Write-Output ('checksum='+[string][bool](Get-Command Get-FileHash -ErrorAction SilentlyContinue))
`;

export function parseInspection(output: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/u)) {
    const at = line.indexOf("=");
    if (at > 0 && line.length <= 4096) values.set(line.slice(0, at), line.slice(at + 1));
  }
  return values;
}

export function buildProviderChoices(
  platform: "linux" | "windows",
  values: ReadonlyMap<string, string>,
): readonly SshProviderChoice[] {
  return PROVIDER_RECIPE_CATALOG.map((entry) => {
    const installed = Boolean(values.get(`tool.${entry.command}`));
    const recipe = providerArchiveRecipe(entry.driver, platform);
    const missingShell =
      platform === "windows" &&
      entry.driver === "claudeAgent" &&
      Boolean(values.get("tool.git")) &&
      values.get("gitbash") !== "True";
    const available =
      installed ||
      (!missingShell &&
        (entry.driver === "codex" || entry.driver === "antigravity" || recipe !== undefined));
    const node = NODE_PROVIDER_RUNTIME[platform];
    return {
      driver: entry.driver,
      label: entry.label,
      version: entry.version,
      source: recipe?.url ?? entry.source,
      command: installed
        ? "Reuse existing installation; no replacement"
        : recipe
          ? `Download ${recipe.url}; verify ${recipe.integrity}; tar -xf <verified archive> -C <private staging>; ${recipe.executable} --version; activate in the T3 user tools directory.`
          : `Existing T3 managed installer: ${entry.driver} ${entry.version ?? ""}; verify vendor archive and executable before activation (user scope).`,
      available,
      installed,
      reason: installed
        ? "Existing/custom installations are preserved."
        : missingShell
          ? "The installed Git lacks Git Bash. Install Git for Windows/Bash or configure CLAUDE_CODE_GIT_BASH_PATH before selecting Claude. T3 will preserve the existing Git installation."
          : available
            ? "Installs after the T3 server connects. Sign in separately in provider settings."
            : "No pinned, verified automatic installation recipe is available. Install using the vendor instructions, then refresh providers.",
      dependencies:
        entry.driver === "antigravity"
          ? [
              satisfiesSemverRange(values.get("nodeVersion") ?? "", NODE_PROVIDER_ENGINE_RANGE)
                ? `Reuse compatible Node ${values.get("nodeVersion")}; no Node/npm installation.`
                : `Compatible Node (${NODE_PROVIDER_ENGINE_RANGE}) missing. Install private Node ${node.version}: ${node.url}; ${node.integrity}; existing Node is preserved; npm is not installed.`,
            ]
          : entry.dependency && platform === "windows"
            ? [entry.dependency]
            : [],
    };
  });
}
const atLeast = (actual: string, required: string) => {
  const a = actual.split(/[.-]/u).map(Number),
    b = required.split(".").map(Number);
  for (let i = 0; i < b.length; i++) {
    if (!Number.isFinite(a[i])) return false;
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return true;
};

export function buildSetupReview(input: {
  target: DesktopSshEnvironmentTarget;
  requirements: SshRuntimeRequirements;
  values: ReadonlyMap<string, string>;
  reviewId: string;
  providers: readonly SshProviderChoice[];
}): SshSetupReview {
  const { target, requirements: req, values: v } = input;
  const linux = req.platform === "linux";
  const manager = v.get("manager");
  const packageManager =
    manager === "apt" || manager === "dnf" || manager === "yum" || manager === "windows"
      ? manager
      : "none";
  const elevationValue = v.get("elevation");
  const elevation =
    elevationValue === "root" || elevationValue === "sudo" || elevationValue === "administrator"
      ? elevationValue
      : "unavailable";
  const blockers: string[] = [];
  const architecture = v.get("architecture") ?? "unknown";
  if (!(linux ? architecture === "x86_64" : architecture === "AMD64"))
    blockers.push("Only native Linux x64 and Windows x64 are supported.");
  if (!v.get("identity"))
    blockers.push(
      "Could not attest this remote machine and user. Inspect SSH access before continuing.",
    );
  if (linux) {
    if (!atLeast(v.get("glibc") ?? "", req.minimumGlibc))
      blockers.push(
        `This runtime requires glibc ${req.minimumGlibc} or newer. Use a supported OS; T3 will not replace glibc.`,
      );
    if (!atLeast(v.get("kernel") ?? "", req.minimumKernel))
      blockers.push(
        `This runtime requires Linux ${req.minimumKernel} or newer. Update the OS separately.`,
      );
  } else if (
    !atLeast(v.get("powershell") ?? "", "5.1") ||
    !atLeast(v.get("kernel") ?? "", "10.0.17763")
  )
    blockers.push(
      "Windows 10/Server 2019 or newer and PowerShell 5.1 are required. Update Windows separately.",
    );
  const items: SshSetupReview["items"][number][] = [];
  const add = (
    id: string,
    label: string,
    installed: boolean,
    apt: string[],
    rpm: string[],
    guidance: string,
  ) =>
    items.push({
      id,
      label,
      installed,
      required: true,
      version: null,
      packages:
        packageManager === "apt"
          ? apt
          : packageManager === "dnf" || packageManager === "yum"
            ? rpm
            : [],
      guidance,
    });
  if (linux) {
    for (const lib of req.libraries) {
      const packages =
        lib === "libatomic.so.1"
          ? ["libatomic1", "libatomic"]
          : lib === "libstdc++.so.6"
            ? ["libstdc++6", "libstdc++"]
            : ["libgcc-s1", "libgcc"];
      const installed =
        Boolean(v.get(lib)) &&
        (lib !== "libstdc++.so.6" || atLeast(v.get("glibcxx") ?? "", req.minimumGlibcxx));
      add(
        lib,
        lib === "libstdc++.so.6" ? `${lib} (GLIBCXX ${req.minimumGlibcxx}+)` : lib,
        installed,
        [packages[0]!],
        [packages[1]!],
        `Install ${packages[0]} (Debian/Ubuntu) or ${packages[1]} (Fedora/RHEL) from your OS repositories.`,
      );
    }
    add(
      "tar",
      "tar and gzip extraction",
      Boolean(v.get("tool.tar") && v.get("tool.gzip")),
      ["tar", "gzip"],
      ["tar", "gzip"],
      "Install tar and gzip.",
    );
    add(
      "checksum",
      "SHA-256 verification",
      Boolean(v.get("tool.sha256sum") || v.get("tool.shasum")),
      ["coreutils"],
      ["coreutils"],
      "Install coreutils to provide sha256sum.",
    );
  } else {
    add(
      "extraction",
      "PowerShell archive and checksum tools",
      v.get("expand") === "True" && v.get("checksum") === "True",
      [],
      [],
      "Repair PowerShell 5.1 with Microsoft.PowerShell.Archive and Microsoft.PowerShell.Utility.",
    );
    for (const lib of req.libraries)
      add(
        lib,
        lib,
        v.get(lib) === "True",
        [],
        [],
        "Install the Microsoft Visual C++ 2015–2022 x64 Redistributable in an elevated SSH session.",
      );
  }
  add(
    "git",
    "Git",
    Boolean(v.get("tool.git")),
    ["git"],
    ["git"],
    linux
      ? "Install Git through your distribution package manager."
      : "Install Git for Windows, then reconnect so the SSH PATH includes it.",
  );
  const missing = items.filter((item) => !item.installed);
  const packages = [...new Set(missing.flatMap((item) => item.packages))];
  const commands: string[] = [];
  if (packages.length) {
    const prefix = elevation === "root" ? "" : "sudo ";
    if (packageManager === "apt")
      commands.push(
        `${prefix}apt-get update`,
        `${prefix}apt-get install --no-install-recommends -y ${packages.join(" ")}`,
      );
    else commands.push(`${prefix}${packageManager} install -y ${packages.join(" ")}`);
    if (elevation === "unavailable")
      blockers.push(
        "System packages are missing. Reconnect as root or install sudo and grant package installation access separately.",
      );
  }
  if (!linux) {
    if (missing.some((i) => i.id.endsWith(".dll"))) {
      commands.push(
        `Download Microsoft Visual C++ ${WINDOWS_INSTALLERS.vcredist.version}: ${WINDOWS_INSTALLERS.vcredist.url}\nSHA-256 ${WINDOWS_INSTALLERS.vcredist.sha256}\nVC_redist.x64.exe /install /quiet /norestart (elevated SSH session)`,
      );
      if (elevation !== "administrator")
        blockers.push(
          "Microsoft Visual C++ system components are missing. Reconnect through an elevated SSH session or ask the administrator to install the x64 Redistributable.",
        );
    }
    if (missing.some((i) => i.id === "git"))
      commands.push(
        `Download Git ${WINDOWS_INSTALLERS.git.version}: ${WINDOWS_INSTALLERS.git.url}\nSHA-256 ${WINDOWS_INSTALLERS.git.sha256}\nGit.exe /CURRENTUSER /SP- /VERYSILENT /SUPPRESSMSGBOXES /NORESTART (user scope)`,
      );
  }
  for (const item of missing)
    if (!item.packages.length && (linux || item.id === "extraction"))
      blockers.push(`${item.label}: ${item.guidance}`);
  return {
    reviewId: input.reviewId,
    destination: target.hostname,
    source: targetConnectionKey(target),
    remoteIdentity: v.get("identity") ?? "",
    platform: req.platform,
    architecture,
    distribution: v.get("distribution") ?? "unknown",
    packageManager,
    elevation,
    requirements: req,
    items,
    commands,
    blockers,
    providers: input.providers,
  };
}

// Pinned from Microsoft winget-pkgs manifests. No moving installer endpoints.
export const WINDOWS_INSTALLERS = {
  git: {
    version: "2.55.0.5",
    url: "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.5/Git-2.55.0.5-64-bit.exe",
    sha256: "d065a4e23c3d9a6b5073d609b5be0830227ec3ca053c083ba385061ddfaf94c6",
    args: "/CURRENTUSER /SP- /VERYSILENT /SUPPRESSMSGBOXES /NORESTART",
  },
  vcredist: {
    version: "14.51.36247.0",
    url: "https://download.visualstudio.microsoft.com/download/pr/ebdab8e5-1d7b-4d9f-a11b-cbb1720c3b12/843068991DAAA1F73AD9F6239BCE4D0F6A07A51F18C37EA2A867E9BECA71295C/VC_redist.x64.exe",
    sha256: "843068991daaa1f73ad9f6239bce4d0f6a07a51f18c37ea2a867e9beca71295c",
    args: "/install /quiet /norestart",
  },
} as const;

export function windowsPrerequisiteInstallScript(review: SshSetupReview) {
  const selected = [
    ...(review.items.some((i) => i.id.endsWith(".dll") && !i.installed)
      ? [WINDOWS_INSTALLERS.vcredist]
      : []),
    ...(review.items.some((i) => i.id === "git" && !i.installed) ? [WINDOWS_INSTALLERS.git] : []),
  ];
  return `$ErrorActionPreference='Stop'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
$work=Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
[IO.Directory]::CreateDirectory($work)|Out-Null
$child=$null
try {
${selected
  .map(
    (r, index) => `$file=Join-Path $work 'installer-${index}.exe'
Invoke-WebRequest -UseBasicParsing -Uri '${r.url}' -OutFile $file
if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne '${r.sha256}'){throw 'Installer integrity verification failed'}
$signature=Get-AuthenticodeSignature -LiteralPath $file
if($signature.Status -ne 'Valid'){throw 'Installer signature verification failed'}
$child=Start-Process -FilePath $file -ArgumentList '${r.args}' -PassThru
$child.WaitForExit()
if($child.ExitCode -eq 3010 -or $child.ExitCode -eq 1641){Write-Output 'T3_SETUP_RESTART_REQUIRED'; throw 'A restart is required to complete installation. T3 will not restart this machine. Restart separately, then review setup again.'}
if($child.ExitCode -ne 0){throw 'The approved Windows installer failed. Review Windows installer state before retrying.'}
$child=$null`,
  )
  .join("\n")}
} finally {if($child -and !$child.HasExited){Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue}; Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue}
`;
}

// Commands are built solely from the allow-listed package names in buildSetupReview.
export function linuxPackageInstallScript(review: SshSetupReview) {
  const packages = [
    ...new Set(review.items.filter((i) => !i.installed).flatMap((i) => i.packages)),
  ];
  if (!packages.length || !packages.every((name) => /^[a-z0-9+.-]+$/u.test(name)))
    return "exit 1\n";
  const command =
    review.packageManager === "apt"
      ? `export DEBIAN_FRONTEND=noninteractive\napt-get update\napt-get install --no-install-recommends -y ${packages.join(" ")}`
      : `${review.packageManager} install -y ${packages.join(" ")}`;
  return `set -eu
child=''
group=no
cleanup() { if [ -n "$child" ]; then if [ "$group" = yes ]; then kill -TERM "-$child" 2>/dev/null || true; else kill -TERM "$child" 2>/dev/null || true; fi; wait "$child" 2>/dev/null || true; fi; }
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
${command.startsWith("export DEBIAN") ? "export DEBIAN_FRONTEND=noninteractive\n" : ""}if command -v setsid >/dev/null; then
  setsid sh -c '${command.replaceAll("'", "'\\''")}' &
  child=$!; group=yes
else
  sh -c '${command.replaceAll("'", "'\\''")}' &
  child=$!
fi
wait "$child"
child=''
`;
}

export const inspectAndPrepare = Effect.fn("ssh.prerequisites.prepare")(function* (input: {
  target: DesktopSshEnvironmentTarget;
  auth: SshAuthOptions;
  requirements: SshRuntimeRequirements;
  inspect: () => ReturnType<typeof runSshCommand>;
  supportsReview: boolean;
  reviewRequested: boolean;
  providers?: readonly SshProviderChoice[];
  windowsCommand: readonly string[];
  progress: (stage: string) => Effect.Effect<void>;
}) {
  const crypto = yield* Crypto.Crypto;
  const prompt = yield* SshPasswordPrompt;
  yield* input.progress("Inspecting remote prerequisites…");
  const values = parseInspection((yield* input.inspect()).stdout);
  const providers = input.providers ?? buildProviderChoices(input.requirements.platform, values);
  const review = buildSetupReview({
    ...input,
    values,
    reviewId: yield* crypto.randomUUIDv4.pipe(Effect.orDie),
    providers,
  });
  const missing = review.items.some((item) => !item.installed);
  if (!missing && !input.reviewRequested && !review.blockers.length) return [] as readonly string[];
  if (!input.supportsReview || !prompt.reviewSetup)
    return yield* new SshLaunchError({
      message: `Remote prerequisite review is required. Update the desktop client and add this environment again. ${review.blockers.join(" ")} ${review.commands.join("; ")}`,
      stdout: "",
    });
  yield* input.progress("Waiting for prerequisite review…");
  const approval = yield* prompt.reviewSetup(review);
  const decoded = yield* Schema.decodeUnknownEffect(SshSetupApproval)(approval).pipe(
    Effect.mapError(() => new SshLaunchError({ message: "Invalid setup approval.", stdout: "" })),
  );
  if (!decoded.approved || decoded.reviewId !== review.reviewId)
    return yield* new SshLaunchError({
      message: "Remote setup cancelled. No prerequisite changes were approved.",
      stdout: "",
    });
  if (review.blockers.length)
    return yield* new SshLaunchError({ message: review.blockers.join(" "), stdout: "" });
  const selected = new Set(decoded.providers);
  if ([...selected].some((id) => !review.providers.some((p) => p.driver === id && p.available)))
    return yield* new SshLaunchError({
      message: "The provider selection is not available for this platform.",
      stdout: "",
    });
  // Reinspect on the same authenticated SSH source before using this in-memory approval.
  const current = parseInspection((yield* input.inspect()).stdout);
  if (
    current.get("identity") !== review.remoteIdentity ||
    current.get("architecture") !== values.get("architecture") ||
    current.get("manager") !== values.get("manager") ||
    current.get("elevation") !== values.get("elevation")
  )
    return yield* new SshLaunchError({
      message: "The SSH destination changed after review. Start a new review.",
      stdout: "",
    });
  if (missing) {
    yield* input.progress("Installing approved system prerequisites…");
    let password: string | null = null;
    if (review.elevation === "sudo")
      password = yield* prompt.request({
        purpose: "elevation",
        destination: review.destination,
        username: input.target.username,
        prompt:
          "Enter the remote sudo password for the approved system packages. This is separate from SSH authentication.",
        attempt: 1,
      });
    if (review.elevation === "sudo" && password === null)
      return yield* new SshLaunchError({ message: "Package installation cancelled.", stdout: "" });
    if (password?.includes("\n") || password?.includes("\r"))
      return yield* new SshLaunchError({
        message: "Sudo passwords cannot contain line breaks.",
        stdout: "",
      });
    const script = linuxPackageInstallScript(review);
    const command =
      review.platform === "windows"
        ? {
            remoteCommandArgs: input.windowsCommand,
            stdin: windowsPrerequisiteInstallScript(review),
          }
        : review.elevation === "root"
          ? { remoteCommandArgs: ["sh", "-s"], stdin: script }
          : {
              remoteCommandArgs: [
                "sudo",
                "-k",
                "-S",
                "-p",
                "''",
                "sh",
                "-c",
                `'${script.replaceAll("'", "'\\''")}'`,
              ],
              stdin: `${password}\n`,
            };
    yield* runSshCommand(input.target, {
      ...input.auth,
      ...command,
      sensitiveInput: password !== null,
      timeoutMs: 1_200_000,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new SshLaunchError({
            message:
              cause._tag === "SshCommandError" &&
              cause.stdout?.includes("T3_SETUP_RESTART_REQUIRED")
                ? "Windows requires a restart to complete the approved prerequisite installation. T3 has not restarted the machine. Restart separately, then review setup again."
                : "Approved prerequisite installation failed or elevation was rejected. Review the remote installer state, then start a new review. Completed installations are retained.",
            stdout: "",
            cause,
          }),
      ),
    );
    password = null;
    yield* input.progress("Rechecking installed requirements…");
    const after = buildSetupReview({
      ...input,
      values: parseInspection((yield* input.inspect()).stdout),
      reviewId: review.reviewId,
      providers: review.providers,
    });
    if (
      after.remoteIdentity !== review.remoteIdentity ||
      after.blockers.length ||
      after.items.some((i) => !i.installed)
    )
      return yield* new SshLaunchError({
        message:
          "Requirements are still missing after installation. Review this host again; T3 has not activated the runtime.",
        stdout: "",
      });
  }
  return [...selected];
});
