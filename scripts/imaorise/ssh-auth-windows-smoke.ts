// @effect-diagnostics nodeBuiltinImport:off multipleEffectProvide:off - Hosted fixture composes the SSH layer with its platform dependencies.
import { windowsServerJobScript } from "../../apps/server/src/cli/sshWindowsJob.ts";
import { windowsSupervisorLaunchScript } from "../../apps/server/src/cli/sshWindowsLaunch.ts";
import { verifyPackagedSshConnection } from "./ssh-packaged-connection.ts";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as SshAuth from "../../packages/ssh/src/auth.ts";
import * as SshTunnel from "../../packages/ssh/src/tunnel.ts";
import { runSshCommand } from "../../packages/ssh/src/command.ts";
import {
  powershellArgs,
  powershellFileArgs,
  runtimeStorageScript,
  uploadRuntimeArchive,
  windowsInstallScript,
} from "../../packages/ssh/src/bundledRuntime.ts";
import { runtimeRequirements } from "../../packages/ssh/src/prerequisites.ts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Layer from "effect/Layer";
import type { DesktopSshEnvironmentTarget } from "../../packages/contracts/src/ipc.ts";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.RUNNER_OS !== "Windows")
  throw new Error("Hosted Windows fixture only.");
// Secrets are generated for this disposable runner and supplied over stdin.
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
  root: string;
  port: number;
  username: string;
  password: string;
  passphrase: string;
  identity: string;
  differentHostKey: string;
};
const home = NodePath.join(input.root, "manual SSH client");
await NodeFSP.mkdir(home, { recursive: true });
const program = Effect.gen(function* () {
  const requests: SshAuth.SshPasswordRequest[] = [];
  let cancel = false;
  const service = yield* SshTunnel.SshEnvironmentManager;
  const target: DesktopSshEnvironmentTarget = {
    alias: "must-not-use-an-alias",
    hostname: "127.0.0.1",
    username: input.username,
    port: input.port,
    manual: {
      profileId: "password-fixture",
      name: "Disposable Windows password fixture",
      authentication: { type: "password" },
    },
  };
  const prompt = SshAuth.SshPasswordPrompt.of({
    isAvailable: true,
    request: (request) =>
      Effect.logInfo(`SSH fixture challenge: ${request.challenge}`).pipe(
        Effect.andThen(
          Effect.sync(() => {
            requests.push(request);
            if (cancel) return null;
            if (request.challenge === "host-key") {
              NodeAssert.match(request.prompt, /SHA256:/);
              return "yes";
            }
            return request.challenge === "key-passphrase" ? input.passphrase : input.password;
          }),
        ),
      ),
  });
  const authenticate = (target: DesktopSshEnvironmentTarget, secret?: string) =>
    service
      .ensureEnvironment(target, {
        testOnly: true,
        ...(secret === undefined ? {} : { authSecret: secret }),
      })
      // A new Windows account may need its profile created on first logon.
      // Let the production command's 60s deadline report transport failures.
      .pipe(Effect.provideService(SshAuth.SshPasswordPrompt, prompt), Effect.timeout("75 seconds"));
  yield* Effect.logInfo("SSH fixture: unfamiliar host and password");
  const first = yield* authenticate(target);
  NodeAssert.equal(first.httpBaseUrl, "");
  NodeAssert.ok(requests.some((request) => request.challenge === "host-key"));
  NodeAssert.ok(requests.some((request) => request.challenge === "password"));
  yield* Effect.logInfo("SSH fixture: destination capacity and binary upload");
  yield* runSshCommand(target, {
    interactiveAuth: true,
    authSecret: input.password,
    remoteCommandArgs: powershellFileArgs(),
    stdin: runtimeStorageScript("windows", 4 * 1024 * 1024, runtimeRequirements("windows", "test")),
  });
  const payload = new Uint8Array(4 * 1024 * 1024).fill(37);
  const digest = NodeCrypto.createHash("sha256").update(payload).digest("hex");
  const archive = NodePath.join(input.root, "source's runtime [archive].zip");
  yield* Effect.promise(() => NodeFSP.writeFile(archive, payload));
  yield* uploadRuntimeArchive(
    target,
    { interactiveAuth: true, authSecret: input.password },
    "windows",
    archive,
    digest,
    "-fixture",
  );
  const upload = yield* runSshCommand(target, {
    interactiveAuth: true,
    authSecret: input.password,
    remoteCommandArgs: powershellArgs(
      `$p=Join-Path $HOME '.t3-imaorise/runtime/upload-${digest}-fixture.zip'; try { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() } finally { Remove-Item -LiteralPath $p -Force }`,
    ),
  });
  NodeAssert.ok(upload.stdout.includes(digest));
  yield* Effect.logInfo("SSH fixture: noninteractive archive extraction and progress suppression");
  const payloadDirectory = NodePath.join(input.root, "archive payload", "runtime");
  const installArchive = NodePath.join(input.root, "install runtime.zip");
  yield* Effect.promise(async () => {
    await NodeFSP.mkdir(payloadDirectory, { recursive: true });
    await NodeFSP.copyFile(process.execPath, NodePath.join(payloadDirectory, "t3.exe"));
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const [command, ...args] = powershellArgs(
      `$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath ${quote(payloadDirectory)} -DestinationPath ${quote(installArchive)} -CompressionLevel NoCompression`,
    );
    await new Promise<void>((resolve, reject) => {
      NodeChildProcess.execFile(command!, args, { timeout: 60_000, windowsHide: true }, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  });
  const installHash = yield* Effect.promise(async () =>
    NodeCrypto.createHash("sha256")
      .update(await NodeFSP.readFile(installArchive))
      .digest("hex"),
  );
  yield* uploadRuntimeArchive(
    target,
    { interactiveAuth: true, authSecret: input.password },
    "windows",
    installArchive,
    installHash,
    "-extract",
  );
  const extracted = yield* runSshCommand(target, {
    interactiveAuth: true,
    authSecret: input.password,
    remoteCommandArgs: powershellFileArgs(),
    // Node stands in for the packaged executable; exercise the complete remote
    // checksum/extraction/activation path through the real SSH default shell.
    stdin: windowsInstallScript(installHash, "-extract").replaceAll(
      "__ssh-helper verify-runtime",
      "--version",
    ),
    timeoutMs: 90_000,
  });
  NodeAssert.doesNotMatch(extracted.stderr, /CLIXML|ReadConsoleOutput/);
  const verified = yield* runSshCommand(target, {
    interactiveAuth: true,
    authSecret: input.password,
    remoteCommandArgs: powershellFileArgs(),
    stdin: `$ErrorActionPreference='Stop'\nWrite-Progress -Activity 'Noninteractive SSH fixture' -PercentComplete 50\nif($ProgressPreference -ne 'SilentlyContinue'){throw 'Child progress preference was lost'}\n$p=Join-Path $HOME '.t3-imaorise/runtime/sha256-${installHash}'\ntry { & (Join-Path $p 't3.exe') --version; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE} } finally { Remove-Item -LiteralPath $p -Recurse -Force }\n`,
  });
  NodeAssert.ok(verified.stdout.includes(process.version));
  const realError = yield* Effect.result(
    runSshCommand(target, {
      interactiveAuth: true,
      authSecret: input.password,
      remoteCommandArgs: powershellFileArgs(),
      stdin:
        "$ErrorActionPreference='Stop'\nthrow 'Disposable extraction failure must remain visible'\n",
    }),
  );
  NodeAssert.equal(realError._tag, "Failure");
  if (realError._tag === "Failure")
    NodeAssert.match(realError.failure.message, /Disposable extraction failure/);
  const closed = yield* Effect.result(
    runSshCommand(target, {
      interactiveAuth: true,
      authSecret: input.password,
      remoteCommandArgs: powershellArgs(
        "[Console]::Error.WriteLine('No space left on device'); exit 74",
      ),
      stdinBytes: new Uint8Array(32 * 1024 * 1024),
    }),
  );
  NodeAssert.equal(closed._tag, "Failure");
  if (closed._tag === "Failure") NodeAssert.match(closed.failure.message, /ran out of storage/);
  const retry = {
    ...target,
    manual: { ...target.manual!, profileId: "incorrect-password-fixture" },
  };
  yield* authenticate(retry, "incorrect-disposable-fixture-password");
  yield* Effect.logInfo("SSH fixture: encrypted key");
  const key: DesktopSshEnvironmentTarget = {
    ...target,
    manual: {
      profileId: "encrypted-key-fixture",
      name: "Encrypted key",
      authentication: { type: "key", identityFile: input.identity },
    },
  };
  yield* authenticate(key);
  NodeAssert.ok(requests.some((request) => request.challenge === "key-passphrase"));
  cancel = true;
  yield* Effect.logInfo("SSH fixture: cancellation");
  const cancellation = yield* Effect.result(
    authenticate({
      ...target,
      hostname: "localhost",
      manual: { ...target.manual!, profileId: "cancel-fixture" },
    }),
  );
  NodeAssert.equal(cancellation._tag, "Failure");
  cancel = false;
  // Named events prove that the child survives a completed SSH command without
  // requiring the standard account to read the runner's Node installation.
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const suffix = (yield* (yield* Crypto.Crypto).randomUUIDv4.pipe(Effect.orDie)).replaceAll(
    "-",
    "",
  );
  const readyName = `Local\\T3Ready${suffix}`;
  const stopName = `Local\\T3Stop${suffix}`;
  const childScript = `$stop=[Threading.EventWaitHandle]::new($false,[Threading.EventResetMode]::ManualReset,${quote(stopName)}); try { $ready=[Threading.EventWaitHandle]::OpenExisting(${quote(readyName)}); [void]$ready.Set(); $ready.Dispose(); [void]$stop.WaitOne(60000) } finally { $stop.Dispose() }`;
  const powershell = NodePath.join(
    process.env.SystemRoot!,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const commandLine = `"${powershell}" -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(childScript, "utf16le").toString("base64")}`;
  const detached = (script: string) =>
    runSshCommand(target, {
      interactiveAuth: true,
      authSecret: input.password,
      remoteCommandArgs: powershellFileArgs(),
      stdin: script,
    });
  try {
    yield* detached(
      `$ready=[Threading.EventWaitHandle]::new($false,[Threading.EventResetMode]::ManualReset,${quote(readyName)})\ntry {\n${windowsSupervisorLaunchScript(powershell, commandLine, process.env.SystemRoot!)}\nif(!$ready.WaitOne(10000)){throw 'Detached child did not signal readiness'}\n} finally { $ready.Dispose() }\n`,
    );
    yield* detached(
      `$stop=[Threading.EventWaitHandle]::OpenExisting(${quote(stopName)}); try { if($stop.SafeWaitHandle.IsInvalid){throw 'Detached child was unavailable after SSH exit'} } finally { $stop.Dispose() }\n`,
    );
    yield* detached(
      `$stop=[Threading.EventWaitHandle]::OpenExisting(${quote(stopName)}); try { [void]$stop.Set() } finally { $stop.Dispose() }\n`,
    );
    yield* Effect.logInfo("Passed nonadministrator process survival after SSH command exit.");
  } finally {
    yield* detached(
      `$stop=[Threading.EventWaitHandle]::OpenExisting(${quote(stopName)}); try { [void]$stop.Set() } finally { $stop.Dispose() }\n`,
    ).pipe(Effect.ignore);
  }
  for (const mode of ["stop", "eof"] as const) {
    const rootLive = `Local\\T3Root${suffix}${mode}`;
    const descendantLive = `Local\\T3Descendant${suffix}${mode}`;
    const jobReady = `Local\\T3JobReady${suffix}${mode}`;
    const descendant = `$live=[Threading.EventWaitHandle]::new($false,[Threading.EventResetMode]::ManualReset,${quote(descendantLive)}); try { $ready=[Threading.EventWaitHandle]::OpenExisting(${quote(jobReady)}); [void]$ready.Set(); $ready.Dispose(); [void]$live.WaitOne(60000) } finally { $live.Dispose() }`;
    const root = `$live=[Threading.EventWaitHandle]::new($false,[Threading.EventResetMode]::ManualReset,${quote(rootLive)}); try { $info=[Diagnostics.ProcessStartInfo]::new(${quote(powershell)}); $info.UseShellExecute=$false; $info.Arguments='-NoProfile -NonInteractive -EncodedCommand ${Buffer.from(descendant, "utf16le").toString("base64")}'; $child=[Diagnostics.Process]::Start($info); [void]$live.WaitOne(60000) } finally { $live.Dispose() }`;
    const serverCommand = `"${powershell}" -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(root, "utf16le").toString("base64")}`;
    const jobScript = windowsServerJobScript(powershell, serverCommand, process.env.SystemRoot!);
    yield* detached(`$ready=[Threading.EventWaitHandle]::new($false,[Threading.EventResetMode]::ManualReset,${quote(jobReady)})
$file=Join-Path ([IO.Path]::GetTempPath()) '${suffix}-${mode}.ps1'
$helper=$null
function Read-FixtureStream($task) {
  if($task.Wait(2000)){return $task.GetAwaiter().GetResult()}
  return 'Owned fixture stream remained open after helper exit.'
}
try {
  [IO.File]::WriteAllText($file,${quote(jobScript)},[Text.UTF8Encoding]::new($true))
  $info=[Diagnostics.ProcessStartInfo]::new(${quote(powershell)})
  $info.UseShellExecute=$false
  $info.RedirectStandardInput=$true
  $info.RedirectStandardOutput=$true
  $info.RedirectStandardError=$true
  $info.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$file+'"'
  $helper=[Diagnostics.Process]::Start($info)
  $output=$helper.StandardOutput.ReadToEndAsync()
  $errors=$helper.StandardError.ReadToEndAsync()
  $helper.StandardInput.AutoFlush=$true
  if(!$ready.WaitOne(15000)){throw 'Owned job descendant did not become ready'}
  ${mode === "stop" ? "$helper.StandardInput.WriteLine('stop')" : "$helper.StandardInput.Close()"}
  if(!$helper.WaitForExit(12000)){throw 'Owned job helper did not finish'}
  if($helper.ExitCode -ne 0){throw ('Owned job helper failed: '+(Read-FixtureStream $errors))}
  [void](Read-FixtureStream $output)
  foreach($name in @(${quote(rootLive)},${quote(descendantLive)})) {
    $remaining=$null
    try { $remaining=[Threading.EventWaitHandle]::OpenExisting($name) } catch [Threading.WaitHandleCannotBeOpenedException] {}
    if($remaining){$remaining.Dispose(); throw 'Owned server or descendant survived job shutdown'}
  }
} finally {
  if($helper){$helper.StandardInput.Close(); if($helper.WaitForExit(12000)){[Console]::Error.Write((Read-FixtureStream $errors))}; $helper.Dispose()}
  $ready.Dispose()
  Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
}
`);
    yield* Effect.logInfo(`Passed standard-user owned server/descendant job cleanup: ${mode}.`);
  }
  if (process.env.T3_SSH_FIXTURE_ARCHIVE && process.env.T3_SSH_FIXTURE_VERSION) {
    yield* verifyPackagedSshConnection({
      target,
      archive: process.env.T3_SSH_FIXTURE_ARCHIVE,
      version: process.env.T3_SSH_FIXTURE_VERSION,
      authSecret: input.password,
    }).pipe(Effect.provideService(SshAuth.SshPasswordPrompt, prompt));
  }
  const trust = NodePath.join(home, ".t3-imaorise", "ssh", "known_hosts");
  yield* Effect.promise(() =>
    NodeFSP.writeFile(trust, `[127.0.0.1]:${input.port} ${input.differentHostKey}\n`),
  );
  const previousPrompts = requests.length;
  const changed = yield* Effect.result(
    authenticate({ ...target, manual: { ...target.manual!, profileId: "changed-host-fixture" } }),
  );
  NodeAssert.equal(changed._tag, "Failure");
  NodeAssert.equal(requests.length, previousPrompts);
  NodeAssert.ok(
    (yield* Effect.promise(() => NodeFSP.readFile(trust, "utf8"))).includes(input.differentHostKey),
  );
  yield* Effect.logInfo(
    "Passed native Windows host trust, password retry, encrypted key, cancellation, and changed-host rejection.",
  );
}).pipe(
  Effect.scoped,
  Effect.provide(SshTunnel.SshEnvironmentManager.layer()),
  Effect.provide(Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerUndici, NetService.layer)),
  Effect.provideService(HostProcess.HomeDirectory, home),
);
await Effect.runPromise(program);
