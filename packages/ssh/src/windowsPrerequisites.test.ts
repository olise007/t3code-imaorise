// @effect-diagnostics nodeBuiltinImport:off - PowerShell is exercised only against disposable installer doubles.
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";
import { powershellArgs } from "./bundledRuntime.ts";
import {
  buildSetupReview,
  parseInspection,
  runtimeRequirements,
  windowsPrerequisiteInstallScript,
  WINDOWS_INSTALLERS,
} from "./prerequisites.ts";

it.effect(
  "handles successful, failed, unsigned, and restart-required Windows installers without restarting",
  () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "win32") return;
      const report = buildSetupReview({
        target: { alias: "fixture", hostname: "fixture", username: null, port: 22 },
        requirements: runtimeRequirements("windows", "fixture"),
        reviewId: "fixture",
        providers: [],
        values: parseInspection(
          "identity=fixture:user:home\narchitecture=AMD64\nkernel=10.0.26100\npowershell=5.1\ndistribution=windows\nmanager=windows\nelevation=administrator\nexpand=True\nchecksum=True\nVCRUNTIME140.dll=True\nMSVCP140.dll=True\n",
        ),
      });
      expect(report.blockers).toEqual([]);
      for (const { code, signed } of [
        { code: 0, signed: true },
        { code: 1, signed: true },
        { code: 3010, signed: true },
        { code: 1641, signed: true },
        { code: 0, signed: false },
      ]) {
        const fixture = `$ErrorActionPreference='Stop'
function Invoke-WebRequest {param([switch]$UseBasicParsing,$Uri,$OutFile) [IO.File]::WriteAllText($OutFile,'fixture')}
function Get-FileHash {param($LiteralPath,$Algorithm) return @{Hash='${WINDOWS_INSTALLERS.git.sha256}'}}
function Get-AuthenticodeSignature {param($LiteralPath) return @{Status='${signed ? "Valid" : "NotSigned"}'}}
function Start-Process {param($FilePath,$ArgumentList,[switch]$PassThru) $p=[pscustomobject]@{ExitCode=${code};HasExited=$true;Id=0}; $p|Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {}; return $p}
function Restart-Computer {throw 'UNEXPECTED RESTART'}
${windowsPrerequisiteInstallScript(report)}`;
        const [command, ...args] = powershellArgs(fixture);
        const result = NodeChildProcess.spawnSync(command!, args, {
          encoding: "utf8",
          timeout: 15000,
        });
        expect(result.status === 0).toBe(code === 0 && signed);
        if (code === 3010 || code === 1641)
          expect(result.stdout).toContain("T3_SETUP_RESTART_REQUIRED");
        expect(result.stderr).not.toContain("UNEXPECTED RESTART");
      }
    }),
  90000,
);
