# T3 Code Imaorise

This personal build tracks `pingdotgg/t3code` on `main`, with changes on `imaorise`.
The fork is https://github.com/olise007/t3code-imaorise. Nothing in the update command
installs an app, stops running apps, publishes a release, or schedules an update.

## Setup

Keep separate native checkouts and dependencies:

- WSL: `/home/imaorise/webdevfiles/Projects/t3code-imaorise`
- Windows: `%USERPROFILE%\source\t3code-imaorise`
- `origin`: `https://github.com/olise007/t3code-imaorise.git`
- `upstream`: `https://github.com/pingdotgg/t3code.git`

Use Node 24.21.0, the locked pnpm version, Vite+, Rust and Python 3.
Windows tools live under `%LOCALAPPDATA%\T3CodeImaorise\tools`; the update script
prepends their paths only inside its process. Hermes keeps its own Node.
The Linux single executable uses an isolated Node 26.8.2 through
`vp env exec --node 26.8.2`; it does not replace shared Node 24.
Install Visual Studio 2022 C++ Build Tools, a Windows SDK and Spectre libraries.
See [native build prerequisites](development.md#windows-installer-prerequisites).
WSL uses `build-essential`, `pkg-config`, `libsecret-1-dev` and Rust.
Authenticate GitHub CLI with `gh auth login`; use your normal account.

The build uses the public production Connect values documented in `.env.example`.
No Clerk secret, relay deployment credential, or signing credential is required
to compile. Connect authentication remains subject to the hosted instance's
origin and redirect allowlists; see [Connect setup](connect-setup.md#desktop-oauth-redirects).
The personal origins are `t3code-imaorise://app` and
`t3code-imaorise-dev://app`. If these are rejected by production Clerk, its
administrator must allow them, or upstream must provide a supported independent
desktop authentication path. Do not register the official protocol to bypass this.

On 2026-10-10, a public `GET https://clerk.t3.codes/v1/environment` with
`Origin: t3code-imaorise://app` returned HTTP 400, `origin_invalid`, while
the same request with `Origin: t3code://app` returned HTTP 200. This confirms
the current production origin restriction. Desktop Connect sign-in remains
blocked. The user selected Tailscale as the remote-access alternative; phone
pairing over Tailscale is the readiness gate.

## Manual builds and updates

From Windows PowerShell:

```powershell
cd "$env:USERPROFILE\source\t3code-imaorise"
.\update-imaorise.ps1
```

Default distro: `Ubuntu-26.04`. Override it with `-Distribution <name>`.
Use `-NoMerge` to rebuild the current personal revision without merging upstream.
Both checkouts must be clean and on `imaorise`. The command fetches upstream,
records the previous revision, advances local `main`, and merges into `imaorise`.
It transfers a Git bundle to Windows and permits only a fast-forward there.
No Git push is performed by the update command.

It installs frozen dependencies, runs focused browser/isolation/update tests,
scoped lint and package typechecks, builds and smoke-tests the Linux x64 archive,
then builds an unsigned native Windows x64 NSIS installer embedding that archive.
Both outputs use the same committed revision. The desktop packaging process
also runs its upstream native dependency and payload checks.

Artifacts are retained in dated folders below
`%USERPROFILE%\Documents\T3CodeImaoriseBuilds`, with `build.log`,
`linux/linux-manifest.json`, `manifest.json`, `source.bundle` and `SHA256SUMS`.
Failed commands stop the build and leave a failed manifest and log. A successful
build is labelled **awaiting interactive acceptance**, never automatically ready.
Review these before installing. Keep prior installers and manifests.

## Isolation and acceptance

The product name is **T3 Code Imaorise**, application ID `com.imaorise.t3code`,
protocol `t3code-imaorise`, Electron profile `t3code-imaorise` and T3 home
`~/.t3-imaorise` on each platform. WSL runtime archives stage under
`~/.t3-imaorise/wsl-runtime`; compilation caches also have personal names.
The desktop starts scanning at port 4773, independently of the official 3773.
Do not override `T3CODE_HOME` to the official directory or force an occupied port.
Official legacy profiles are not migration sources for this build.
Automatic desktop updates, CLI updates, managed service-runtime downloads and
managed SSH archive downloads are disabled. Remote SSH hosts need a separately
prepared personal source runtime; standard upstream archives are refused.

Validate fresh personal data using the unpacked app before installing. Preserve
the official installation, `%APPDATA%\t3code*`, `~/.t3`, networking and services.
Record pass/fail evidence for every item:

- Browser: typed URLs, address updates, redirects, links, back/forward, reload,
  thread switching and detached windows. Confirm the page visible to the user
  matches the agent's snapshot and URL. Test server and desktop-owned tabs.
- Agents and terminals: create a project/thread, run an agent turn and a terminal
  command; retain the result and verify reconnect behavior.
- Tailscale: publish a separate personal endpoint, pair a phone and use its
  browser, agent and terminal. Do not replace an existing official Serve route.
  A compile or a public API response is not evidence of successful phone pairing.
  Connect sign-in is currently blocked by the hosted origin allowlist.
- Coexistence: run official and personal apps together and inspect distinct
  profile/data/cache paths, listening ports and protocol registrations.

Install only after reviewing the unsigned installer and this evidence. Close
only the personal test app for installation. Do not delete Chromium: it is used
by the server stream and is unrelated to installer identity.

## Conflicts and rollback

An upstream merge conflict is retained for review. In WSL, inspect `git status`,
resolve each conflict, run the focused checks, then `git add` and `git commit`.
To abandon that merge use `git merge --abort`; this restores the personal branch
before the attempted merge. Never reset away personal commits to make a build pass.
After resolving, run the Windows command with `-NoMerge`.

A divergent Windows checkout stops at `merge --ff-only`. Preserve its commits
and reconcile them deliberately in WSL before rebuilding; do not force-reset it.
The recorded revision and `source.bundle` retain the exact source for each build.

For an application rollback, close the personal app and use a retained personal
installer. Back up its personal data first: an older binary may not understand a
newer schema. Restore only a matching personal backup if necessary. Never restore
personal data over the official installation. For source investigation create a
separate branch at the recorded revision; do not rewrite `imaorise` history.

## Retiring the browser workaround

The workaround is confined to `rendersServerTabNatively` in
`apps/web/src/browser/previewRuntime.ts`: server-owned tabs stream rather than
creating an independent Electron webview when WSL lacks the desktop channel.
Desktop-owned tabs retain their normal lifecycle. No toolbar rewrite or
compiled-archive patch is part of this fork.

When upstream resolves server ownership and late attachment, compare its change
with the personal regression tests. Restore upstream routing in a separate
commit, update those tests to cover the upstream behavior, and rerun the full
browser acceptance list in WSL-only mode, including visible/agent agreement.
Remove the workaround only after this passes. Keep branding and isolation commits.

To remove the personal app, uninstall **T3 Code Imaorise** only. Back up and then
optionally remove its profile, `.t3-imaorise` homes, tool/checkouts and build folder.
Do not remove the official protocols, profiles, installations or provider credentials.
