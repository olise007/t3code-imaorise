#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
operation=${1:?operation required}
shift
clean() {
  [[ -z $(git status --porcelain) ]] || { echo 'WSL checkout is dirty; commit or stash deliberately.' >&2; exit 1; }
  [[ $(git branch --show-current) == imaorise ]] || { echo 'WSL must be on imaorise.' >&2; exit 1; }
  [[ ! -f $(git rev-parse --git-path MERGE_HEAD) ]] || { echo 'Resolve the existing merge first.' >&2; exit 1; }
}
case "$operation" in
  check) clean; git rev-parse HEAD ;;
  update)
    clean
    git fetch upstream main
    git branch -f main upstream/main
    git merge --no-edit upstream/main
    ;;
  bundle) clean; git bundle create "$1" --all ;;
  build)
    clean
    output=${1:?output directory required}
    expected=${2:?expected revision required}
    [[ $(git rev-parse HEAD) == "$expected" ]] || { echo 'WSL revision changed.' >&2; exit 1; }
    mkdir -p "$output"
    source "$HOME/.config/vite-plus/env"
    export PATH="$HOME/.cargo/bin:$PATH"
    bash scripts/imaorise/checks.sh
    # Use only documented public Connect values, independently of a user's .env.
    export T3CODE_CLERK_PUBLISHABLE_KEY=pk_live_Y2xlcmsudDMuY29kZXMk
    export T3CODE_CLERK_JWT_TEMPLATE=t3-relay
    export T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=hzxSgY2cH10sDU2r
    export T3CODE_RELAY_URL=https://relay.t3.codes
    vp run --filter @t3tools/web build
    node apps/server/scripts/cli.ts build
    vp env exec --node 26.8.2 node apps/server/scripts/cli.ts build-exe --verbose
    cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml
    mkdir -p apps/server/dist/resource-monitor/linux-x64
    cp native/resource-monitor/target/release/t3-resource-monitor apps/server/dist/resource-monitor/linux-x64/
    version=$(node -p 'JSON.parse(require("fs").readFileSync("apps/server/package.json")).version')
    node scripts/build-cli-archive.ts --platform linux --arch x64 --version "$version" --output-dir "$output"
    archive="$output/t3-$version-linux-x64.tar.gz"
    node scripts/smoke-cli-archive.ts --archive "$archive" --expect-version "$version"
    [[ -z $(git status --porcelain) ]] || { echo 'Build modified tracked source.' >&2; exit 1; }
    python3 - "$output/linux-manifest.json" "$expected" "$version" <<'PY'
import json, subprocess, sys
def run(*args): return subprocess.check_output(args, text=True).strip()
json.dump({"revision": sys.argv[2], "version": sys.argv[3],
 "upstream": run("git", "rev-parse", "upstream/main"),
 "tools": {"node": run("node", "--version"), "seaNode": "26.8.2", "vp": run("vp", "--version"), "rust": run("rustc", "--version")},
 "checks": "focused tests, scoped lint/typechecks, Linux archive smoke passed",
 "interactiveAcceptance": "pending; not approved for installation"}, open(sys.argv[1], "w"), indent=2)
PY
    ;;
  *) echo "Unknown operation: $operation" >&2; exit 1 ;;
esac
