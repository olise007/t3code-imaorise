import type { DesktopSshDiscoveryReport, DesktopSshExecutionSource } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { discoverSshHosts } from "@t3tools/ssh/config";
import { SshHostDiscoveryError } from "@t3tools/ssh/errors";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

// Run in the owning distro: absolute Include paths and ~ refer to its filesystem.
// Never evaluate configuration as shell code. OpenSSH resolves each selected alias.
export const WSL_DISCOVER_SCRIPT = String.raw`set -eu
cd "$HOME/.ssh" 2>/dev/null || exit 0
visited="$(mktemp)"
trap 'rm -f "$visited"' EXIT
scan() {
  [ -r "$1" ] || return 0
  canonical=$(readlink -f -- "$1")
  grep -Fxq -- "$canonical" "$visited" && return 0
  printf '%s\n' "$canonical" >> "$visited"
  awk '{sub(/#.*/, ""); key=tolower($1); if(key=="host" || key=="include") {for(i=2;i<=NF;i++) print key "\t" $i}}' "$1" |
  while IFS="$(printf '\t')" read -r key value; do
    case "$key" in
      host) case "$value" in *'*'*|*'?'*|*'!'*) ;; *) printf 'ssh-config\t%s\n' "$value" ;; esac ;;
      include)
        case "$value" in '~/'*) value="$HOME/$(printf '%s' "$value" | cut -c 3-)" ;; esac
        for included in $value; do scan "$included"; done ;;
    esac
  done
}
scan config
if [ -r known_hosts ]; then
  awk '!/^#/ && $1 !~ /^\|/ {n=split($1,a,",");for(i=1;i<=n;i++) if(a[i] !~ /^@/) print "known-hosts\t" a[i]}' known_hosts
fi
`;

const runWsl = Effect.fn("desktop.ssh.discovery.wsl")(function* (
  args: ReadonlyArray<string>,
  script?: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make("wsl.exe", args, {
          stdin: {
            stream:
              script === undefined ? Stream.empty : Stream.make(new TextEncoder().encode(script)),
            endOnDone: true,
          },
        }),
      );
      const [chunks, code] = yield* Effect.all([Stream.runCollect(child.stdout), child.exitCode], {
        concurrency: "unbounded",
      });
      if (Number(code) !== 0)
        return yield* Effect.fail(
          new SshHostDiscoveryError({
            message: "WSL SSH discovery failed. Check the distro and its OpenSSH installation.",
            cause: null,
          }),
        );
      const bytes = Buffer.concat(Array.from(chunks, (chunk) => Buffer.from(chunk)));
      return bytes.toString(bytes.includes(0) ? "utf16le" : "utf8").replace(/^\uFEFF/, "");
    }),
  ).pipe(Effect.timeout("15 seconds"));
});

export const discoverConnections = Effect.fn("desktop.ssh.discovery")(function* (
  loadDistro?: string,
) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const hosts: DesktopSshDiscoveryReport["hosts"][number][] = [];
  const sources: DesktopSshDiscoveryReport["sources"][number][] = [];
  const local = yield* Effect.result(discoverSshHosts({ homeDir: environment.homeDirectory }));
  sources.push({
    executionSource: { type: "local" },
    label: environment.platform === "win32" ? "Windows" : "This machine",
    running: true,
    ...(local._tag === "Failure" ? { error: "Could not read local SSH configuration." } : {}),
  });
  if (local._tag === "Success") hosts.push(...local.success);
  if (environment.platform !== "win32") return { hosts, sources };
  const listed = yield* Effect.result(runWsl(["--list", "--quiet"]));
  if (listed._tag === "Failure") {
    sources[0] = {
      ...sources[0]!,
      error: "Could not list WSL distros. Windows SSH is still available.",
    };
    return { hosts, sources };
  }
  const names = listed.success
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
  const runningResult = yield* Effect.result(runWsl(["--list", "--running", "--quiet"]));
  const running = new Set(
    runningResult._tag === "Success"
      ? runningResult.success.split(/\r?\n/).map((name) => name.trim())
      : [],
  );
  for (const distro of names) {
    const executionSource: DesktopSshExecutionSource = { type: "wsl", distro };
    if (!running.has(distro) && distro !== loadDistro) {
      sources.push({ executionSource, label: `WSL · ${distro}`, running: false });
      continue;
    }
    const result = yield* Effect.result(
      runWsl(["--distribution", distro, "--exec", "sh", "-l", "-s"], WSL_DISCOVER_SCRIPT),
    );
    sources.push({
      executionSource,
      label: `WSL · ${distro}`,
      running: result._tag === "Success",
      ...(result._tag === "Failure"
        ? { error: "Could not read this distro's SSH configuration. Load hosts to retry." }
        : {}),
    });
    if (result._tag === "Failure") continue;
    const seen = new Set<string>();
    for (const line of result.success.split(/\r?\n/)) {
      const [source, raw] = line.split("\t");
      if (!raw || (source !== "ssh-config" && source !== "known-hosts")) continue;
      const alias = raw.replace(/^\[([^\]]+)\]:\d+$/, "$1");
      if (seen.has(alias)) continue;
      seen.add(alias);
      hosts.push({ alias, hostname: alias, username: null, port: null, source, executionSource });
    }
  }
  return { hosts, sources };
});
