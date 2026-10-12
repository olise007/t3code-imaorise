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
Android builds use OpenJDK 21 at `/usr/lib/jvm/java-21-openjdk-amd64` and an SDK
under `~/.local/share/t3code-imaorise/android-sdk`. Install Google's command-line
tools in `cmdline-tools/latest`, accept the SDK licenses, and install platform
tools. The APK command resolves SDK, Build Tools and NDK versions from the locked
React Native version and installs the required packages. Gradle, Zig and Ghostty
caches have personal paths.
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

The first native Windows packaging attempt on this machine was blocked by
Windows Code Integrity on 2026-10-10. Event 3077 reports that both the temporary
NSIS executable and `T3 Code Imaorise.exe` fail the signing-level requirements.
The unsigned workflow therefore cannot finish or launch here under the current
policy. Preserve the failed manifest and staged payload. A policy-approved
signing/build route must be arranged before native Windows rollout; this workflow
does not change security policy. Linux runtime and Android builds can run separately.

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
then builds a signed Android ARM64 APK and an unsigned native Windows x64 NSIS
installer embedding that archive. All outputs use the same committed revision.
Android runs before Windows packaging so its artifact is retained even if the
Windows signing policy blocks installer preparation.
The desktop packaging process
also runs its upstream native dependency and payload checks.

Artifacts are retained in dated folders below
`%USERPROFILE%\Documents\T3CodeImaoriseBuilds`, with `build.log`,
`linux/linux-manifest.json`, `manifest.json`, `source.bundle` and `SHA256SUMS`.
Failed commands stop the build and leave a failed manifest and log. A successful
build is labelled **awaiting interactive acceptance**, never automatically ready.
Review these before installing. Keep prior installers and manifests.

Android artifacts live in `android/`, including the APK, signature/package
inspection, Gradle log and revision manifest. The app is `com.imaorise.t3code`
with scheme `t3code-imaorise`, separate from the official Android app. Its
version code is reserved monotonically above 5215 before each release; reruns reuse the reservation. APK updates use
the same private local signing key in `~/.local/share/t3code-imaorise/signing`.
Back up that directory privately; losing the key prevents updating an installed
personal APK without uninstalling it. Never put the key or password in Git or
the build artifacts. Official Expo OTA updates are permanently disabled.
The APK defaults to direct pairing over Tailscale; Connect is disabled unless
`T3CODE_IMAORISE_MOBILE_CONNECT_ENABLED=1` is explicitly configured for a hosted
authentication setup that supports the personal app. The standard build keeps
it disabled. No Expo account, EAS cloud build or store publication is involved.

For an APK-only rebuild of an already committed revision in WSL:

```bash
T3CODE_IMAORISE_VERSION=2.0.1-beta.1 T3CODE_IMAORISE_ANDROID_VERSION_CODE=5216 \
  bash scripts/imaorise/android.sh /path/to/android-artifacts "$(git rev-parse HEAD)"
```

Install the APK on an ARM64 Android phone only after reviewing its evidence.
Use Add Environment with a fresh pairing URL for the personal server. Test
browser navigation, an agent turn, terminal output and reconnecting over
Tailscale. Keep the official app installed. Native automation requires enabling
T3's Device access; a compiled APK is not evidence of a working phone session.

## Personal releases and in-app updates

A fresh Windows installation starts its native local backend. WSL is optional;
WSL-only stays off until the user chooses it. Existing saved choices survive updates.
Install an updater-enabled personal bootstrap package once, then use Settings to
check, download and restart/install. Stable and Beta choices persist; switching
channels cannot install an older desktop version or Android version code.
Android checks on launch/resume at most once every six hours and only notifies.
Manual checks bypass that interval. Download and Install remain explicit actions.
Android may ask you to allow installation from T3 Code Imaorise before opening
its system installer. Cancellation keeps the verified download available to retry.

The `Personal Windows and Android release` workflow uses standard `ubuntu-latest`
and `windows-latest` runners, with no Actions caches. Intermediate artifacts last
one day and are removed after a complete draft upload or publication. Distributed
packages live in GitHub Releases. All jobs build the reservation's source revision;
only generated package version metadata is aligned during packaging. The Windows
installer embeds the Linux runtime built by the same run. Windows remains unsigned.

The release target defaults to `auto`, comparing each surface against its last
published revision in the selected channel. Mobile changes select Android;
desktop, server, and web changes select desktop; shared inputs select both.
Documentation changes select neither. Use `android`, `desktop`, or `all` to
override this decision. Android-only releases retain the APK, update manifest,
checksums, and build evidence; desktop releases require the Windows installer
and matching Linux runtime. Each updater skips releases without its assets.

Repository secrets are `IMAORISE_ANDROID_KEYSTORE_BASE64` and
`IMAORISE_ANDROID_KEYSTORE_PASSWORD`, copied from the existing private signing key.
The `personal-release` and `personal-stable` environments accept only `imaorise`.
Stable requires the owner's environment approval. Neither signing nor publication
runs on pull requests; inherited official publication workflows are guarded out
of this fork. Keep importing upstream `main` with the existing merge command.

Before hosted execution, open GitHub Settings → Billing → Budgets and alerts,
set the Actions budget to $0, and enable **Stop usage when budget limit is reached**.
Then record the verified setting with:

```bash
gh variable set PERSONAL_ZERO_SPEND_VERIFIED --repo olise007/t3code-imaorise --body true
```

For the bootstrap, manually dispatch the personal workflow on `imaorise`, choose
Beta and leave `publish` false. Review the draft's NSIS installer, updater YAML,
signed APK, channel manifest, Linux archive, `BUILD-MANIFEST.json` and `SHA256SUMS`.
Install the bootstrap manually on suitable Windows and ARM64 Android devices.
Test a subsequent N → N+1 update, preserving profiles, drafts and the official
installation. A successful build is not proof of installation or in-app updating.
Device access and Windows Application Control restrictions are unverified gates;
do not weaken device policies to make the unsigned installer run.

Only after release-pipeline and device acceptance pass, publish the reviewed beta
and set `PERSONAL_BETA_ACCEPTED=true` as a repository variable. Trusted `imaorise`
pushes then publish complete betas automatically. A Stable dispatch takes a tested
published beta tag in `tested_beta` and rebuilds its pinned source revision after
approval. Personal versions start at `2.0.1-beta.<sequence>` / `2.0.1`, advancing
the beta patch after Stable. Draft reservations hold Android version codes; never
replace them on reruns or overwrite a published release.

## Background work and tray

Settings → Connections contains **Keep agents running when T3 closes** for the
selected WSL distro, enabled by default. Start/Stop background server manages
only the personal owned runtime. Stop ends its agents and tools. Changing the
preference takes effect on the next actual exit; it does not restart current work.
Remote clients with Maintain environment permission can change this preference.

On Windows, Close to system tray defaults on; Minimize to system tray defaults
off. Tray click restores the window. **Exit** respects the WSL preference;
**Exit and stop servers** stops owned environments. Native Windows agents stop
when Electron exits. WSL work survives Desktop exit/restart while WSL is running,
but cannot survive PC shutdown, WSL shutdown, or server failure.

A live owned WSL runtime retains its version and port. Compatible Desktop updates
reconnect to it without starting duplicate work. An incompatible runtime requires
an explicit Stop and Start. Runtime metadata and the bootstrap credential stay
private in the personal profile; do not copy them into release evidence.

## Commit message review

In Commit changes, use **Generate commit message** to fill the editable field
from the selected files. Generation uses a temporary Git index and does not
commit, stage into the real index, create a branch, or push. Review or edit the
message, then choose Commit or Commit on new branch. Both require a message.
Typing your own message remains supported. A generation error preserves it;
changing files or editing while generation runs discards the obsolete result.

## Isolation and acceptance

The product name is **T3 Code Imaorise**, application ID `com.imaorise.t3code`,
protocol `t3code-imaorise`, Electron profile `t3code-imaorise` and T3 home
`~/.t3-imaorise` on each platform. WSL runtime archives stage under
`~/.t3-imaorise/wsl-runtime`; compilation caches also have personal names.
The desktop starts scanning at port 4773, independently of the official 3773.
Do not override `T3CODE_HOME` to the official directory or force an occupied port.
Official legacy profiles are not migration sources for this build.
Personal desktop updates target only `olise007/t3code-imaorise`. Managed CLI, service-runtime and SSH archive downloads remain disabled. Remote SSH hosts need a separately
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
