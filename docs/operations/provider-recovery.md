# Provider loss and supervised personal builds

A disconnected Codex provider interrupts unfinished work and offers explicit continuation. Completed commands and plans stay in history. An interrupted command card does not prove an external process stopped: inspect the build progress before repeating a build.

Provider event logs under the personal profile's `userdata/logs/provider/` record `runtime_termination` with the session ID, PID, exit code when available, and a bounded stderr category tail. Arbitrary stderr is omitted because it can contain credentials. An absent signal or unknown exit code remains unknown. A memory diagnostic or systemd process-group peak is not proof of an OOM kill.

For local builds, replace an ad hoc shell sequence with:

```sh
node scripts/imaorise/supervised-build.mjs /absolute/path/build-config.json
# Explicit continuation, validating previously recorded artifact checksums:
node scripts/imaorise/supervised-build.mjs /absolute/path/build-config.json --resume
```

The configuration contains a full `revision`, an absolute `output` directory, and `steps` in Android, Linux, Windows order (omit unaffected surfaces). Each step contains `name`, a clean pinned checkout in `cwd`, `command`, an `args` array, and absolute `artifacts` paths. Put no credentials in this file; existing signing configuration stays in the environment/private signing directory. Commands must use the existing build/signature/package/smoke verification scripts before exiting successfully.

`build-progress.json` is replaced atomically after each state change. It records source, supervisor/child PID, timestamps, step exit code/signal and SHA-256 values for artifacts from successful steps. A failed step stops the sequence. Existing files alone cannot establish completion. Resume refuses changed source, dirty checkouts, missing artifacts or checksum mismatches. An abruptly killed supervisor can leave a running record; a subsequent invocation refuses a live recorded PID and only resumes a dead supervisor explicitly.

Windows packaging can use `scripts/imaorise/windows-build.ps1` with `-Repository`, `-Revision`, `-Version`, `-WslRuntime` and `-Output`. It clones an isolated checkout and checks out the exact revision, avoiding fast-forward merges into developer checkouts. Configure the existing Windows Node/Vite+/Rust tool paths before invocation. Use the matching verified Linux runtime archive.

Installed Windows/WSL interruption recovery and Android appearance remain device acceptance checks. Test with a disposable chat/provider; never terminate the live server to exercise this path.
