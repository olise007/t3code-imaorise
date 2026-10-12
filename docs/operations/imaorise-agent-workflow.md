# Personal fork: agent code changes and builds

This workflow applies to `olise007/t3code-imaorise`. It takes precedence over
generic local validation advice in this repository. Use WSL for source work;
use standard GitHub-hosted runners for validation and release builds. Previous
local builds and server typechecks caused memory pressure and crashes. Do not
repeat them merely because a generic agent workflow recommends local tests.

## Where work runs

| Work | Default location |
| --- | --- |
| Inspect source/logs, edit code, review diffs, format changed files | WSL checkout |
| Focused tests and scoped lint/typechecks | GitHub Actions |
| Full server/package checks or large test collections | GitHub Actions, with explicit workflow memory/time limits |
| Linux runtime and Android compilation/signing | Standard hosted Linux runner |
| Native Windows packaging, embedding the matching Linux runtime | Standard hosted Windows runner |
| Artifact download, streaming checksum verification, delivery | Local WSL, into `C:\VM_Share` |
| Installed desktop, Android and pairing acceptance | Suitable devices, separately recorded |

Small local checks are an exception, not a prerequisite. Run a tiny focused
regression or isolated packaged-runtime smoke locally only when the user has
authorized local validation or the session has established that exact check is
safe. State its scope first. Do not expand it into package-wide tests or checks.
Use a hard process/cgroup memory limit and a deadline for an explicitly approved
local typecheck; a Node heap limit alone does not bound native checker memory.
If memory rises or a check fails from resource pressure, stop and move it to CI;
do not retry with more RAM or parallel local checks.

The beta.52 repair used nine small runtime tests locally, then broader hosted
checks and the real packaged-runtime smoke. That history is evidence for that
specific check, not permission for another agent to run broad local validation.

## Change and validation sequence

1. Read `AGENTS.md`, this document and current `git status`. Identify the live
   runtime, canonical checkout, active branch and existing unrelated edits.
   Inspect current logs before reusing an earlier diagnosis.
2. Work in a clean isolated WSL checkout when the developer checkout is dirty.
   Pin the starting revision; preserve personal commits and unrelated work.
   Never reset, stash or commit another agent's edits to obtain a clean build.
3. Make the smallest source fix and meaningful regression tests. Review the
   scoped diff; format only changed files and run `git diff --check`. Do not
   start local Gradle/R8, NSIS, Linux executable builds, repo-wide tests or
   package typechecks by default.
4. Ensure a hosted workflow covers the changed behavior. Add a focused hosted
   check when coverage is missing; do not claim an existing workflow validates
   files it never checks. Keep tests scoped, with bounded memory and execution.
5. Commit the scoped change and push to the personal `imaorise` branch when
   authorized. Inspect the remote URL first: an isolated checkout may have a
   local checkout as `origin`. Do not push into a dirty developer checkout.
6. Dispatch the relevant validation or release workflow and retain the run ID
   and source SHA. Inspect every required job's conclusion. A queued run, green
   unrelated check, skipped job or successful packaging is not validation of
   the changed behavior. On failure, read its logs, fix the cause, and record the
   new revision/run rather than silently treating the old run as successful.

The existing provider-recovery workflow is scoped to provider/build-supervision
work, not a universal validation workflow:

```bash
gh workflow run personal-provider-recovery-validation.yml \
  --repo olise007/t3code-imaorise --ref imaorise
```

See its actual checks in
[personal-provider-recovery-validation.yml](../../.github/workflows/personal-provider-recovery-validation.yml).
For other changes, use the matching CI checks or add scoped coverage to the
appropriate trusted workflow. Do not dispatch signing/release builds just to
validate documentation changes.

## Hosted releases

The release workflow is
[personal-release.yml](../../.github/workflows/personal-release.yml). Its Linux
job runs focused regression checks, builds the desktop payload and Linux runtime,
and smoke-tests the real packaged launcher with a disposable profile. Windows
then packages the installer with that same runtime. Android runs only when the
reserved target includes Android. All artifacts use one clean recorded source.

Use `auto`, `android`, `desktop` or `all`. `auto` compares against each surface's
last complete published revision; an earlier draft does not advance that
baseline. Use an explicit target when a reviewed desktop-only follow-up should
retain the already verified Android APK. Documentation-only changes need no
application build. Never rebuild an unaffected surface simply to obtain one
release number across both apps.

For an authorized desktop-only draft build:

```bash
gh workflow run personal-release.yml \
  --repo olise007/t3code-imaorise --ref imaorise \
  -f channel=beta -f target=desktop -f publish=false
gh run list --repo olise007/t3code-imaorise \
  --workflow personal-release.yml --limit 5
gh run view <run-id> --repo olise007/t3code-imaorise --json headSha,status,conclusion,jobs
```

Verify the selected run's SHA. Do not reserve versions or Android version codes
manually; use the workflow reservation. Reruns reuse their reservation. Keep
signing material in trusted Actions secrets; never expose it to PR jobs or logs.
Preserve the Android package/signing identity and updater repository identity.

Hosted execution requires the user's verified zero-spend setting and
`PERSONAL_ZERO_SPEND_VERIFIED=true`. Use included standard runners, no paid larger
runners. Preserve the workflow's short artifact retention and cleanup. Keep
`publish=false` and automatic beta publication gated until the required native
acceptance passes; pushing a commit does not update installed apps.

## Delivery and acceptance

After every required job succeeds, download the complete draft assets:

```bash
gh release download <tag> --repo olise007/t3code-imaorise \
  --dir /path/to/isolated-artifact-cache
```

Verify `BUILD-MANIFEST.json` source revision, version, targets and asset sizes;
verify every SHA-256 in the manifest and `SHA256SUMS`. For desktop, also verify
the updater YAML's installer SHA-512 and matching runtime. For Android, verify
the actual APK signature, certificate continuity, package, architecture and
version code against its manifest. Stream large files rather than loading whole
artifacts into memory.

Copy verified files atomically into `C:\VM_Share\T3-Code-Imaorise-<version>`
(`/mnt/c/VM_Share/...`), then verify the destination checksums. Include build/run
evidence, operator instructions and explicit unverified acceptance gates. Mark
superseded installers clearly without altering their original assets. A failed
or partial draft must not be presented as an installable release.

Do not edit live databases, clear runtime ownership metadata, stop live apps or
change WSL networking/RAM/security policies as part of validation. Disposable
process tests use explicit temporary profiles and stop only captured or attested
owned processes. Obtain permission before interactive/native checks or closing
the live app. A successful hosted build or local Linux smoke does not prove
Windows close/reopen, tray behavior, WSL agent survival, Android installation or
phone pairing. Keep these as manual gates until actually verified.

Report the source SHA, passed checks, run link, delivered paths and outstanding
gates. Publish only when authorized and the applicable acceptance requirements
are met; preserve per-surface updater discovery for partial releases.
