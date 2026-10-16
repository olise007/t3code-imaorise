import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, vi, beforeEach } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { SshPasswordPrompt } from "./auth.ts";
import { runSshCommand } from "./command.ts";
import { SshCommandError } from "./errors.ts";
import {
  buildSetupReview,
  inspectAndPrepare,
  linuxPackageInstallScript,
  parseInspection,
  runtimeRequirements,
  windowsPrerequisiteInstallScript,
} from "./prerequisites.ts";
import type {
  DesktopSshEnvironmentTarget,
  SshSetupApproval,
  SshSetupReview,
} from "@t3tools/contracts";

vi.mock("./command.ts", async (original) => ({
  ...(await original<typeof import("./command.ts")>()),
  runSshCommand: vi.fn(),
}));
const target: DesktopSshEnvironmentTarget = {
  alias: "example",
  hostname: "example",
  username: "user",
  port: 22,
  executionSource: { type: "wsl", distro: "Ubuntu" },
};
const linux = {
  identity: "machine:user:/home/user",
  architecture: "x86_64",
  kernel: "6.1",
  glibc: "2.36",
  glibcxx: "3.4.30",
  distribution: "debian",
  manager: "apt",
  elevation: "root",
  "libatomic.so.1": "/lib/libatomic.so.1",
  "libstdc++.so.6": "/lib/libstdc++.so.6",
  "libgcc_s.so.1": "/lib/libgcc_s.so.1",
  "tool.tar": "/bin/tar",
  "tool.gzip": "/bin/gzip",
  "tool.sha256sum": "/bin/sha256sum",
  "tool.git": "/bin/git",
};
const output = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
const review = (patch: Record<string, string> = {}) =>
  buildSetupReview({
    target,
    requirements: runtimeRequirements("linux", "test"),
    reviewId: "review",
    values: parseInspection(output({ ...linux, ...patch })),
    providers: [],
  });
beforeEach(() => vi.mocked(runSshCommand).mockReset());

describe("SSH prerequisite inspection and review", () => {
  it("detects libatomic and proposes the distribution's package without replacing glibc", () => {
    const report = review({ "libatomic.so.1": "" });
    expect(report.items.filter((i) => !i.installed).map((i) => i.id)).toEqual(["libatomic.so.1"]);
    expect(report.commands).toEqual([
      "apt-get update",
      "apt-get install --no-install-recommends -y libatomic1",
    ]);
    expect(report.blockers).toEqual([]);
    expect(linuxPackageInstallScript(report)).not.toContain("glibc");
  });
  it.each(["dnf", "yum"])("selects %s package names", (manager) => {
    expect(review({ manager, distribution: "fedora", "libatomic.so.1": "" }).commands).toEqual([
      `${manager} install -y libatomic`,
    ]);
  });
  it("reports unsupported systems, old ABI baselines, and missing privileges", () => {
    expect(review({ architecture: "aarch64" }).blockers.join(" ")).toContain("x64");
    expect(review({ glibc: "2.17" }).blockers.join(" ")).toContain("will not replace glibc");
    expect(review({ kernel: "3.10" }).blockers.join(" ")).toContain("Update the OS separately");
    expect(review({ manager: "none", "libatomic.so.1": "" }).blockers.join(" ")).toContain(
      "Install libatomic1",
    );
    expect(review({ elevation: "unavailable", "libatomic.so.1": "" }).blockers.join(" ")).toContain(
      "Reconnect as root",
    );
  });
  it("checks native-addon C++ requirements and extraction/checksum/Git tools", () => {
    expect(
      review({ glibcxx: "3.4.20", "tool.tar": "", "tool.sha256sum": "", "tool.git": "" })
        .items.filter((i) => !i.installed)
        .map((i) => i.id),
    ).toEqual(["libstdc++.so.6", "tar", "checksum", "git"]);
  });
  it("requires elevation for Windows system components while offering user-scoped Git", () => {
    const report = buildSetupReview({
      target,
      requirements: runtimeRequirements("windows", "test"),
      reviewId: "r",
      values: parseInspection(
        output({
          identity: "machine:sid:home",
          architecture: "AMD64",
          kernel: "10.0.26100",
          powershell: "5.1",
          distribution: "windows",
          manager: "windows",
          elevation: "unavailable",
          expand: "True",
          checksum: "True",
        }),
      ),
      providers: [],
    });
    expect(report.blockers.join(" ")).toContain("elevated SSH session");
    expect(report.commands.join(" ")).toContain("/CURRENTUSER");
    const script = windowsPrerequisiteInstallScript(report);
    expect(script).toContain("Get-FileHash");
    expect(script).toContain("Get-AuthenticodeSignature");
    expect(script).toContain("3010");
    expect(script).not.toContain("Restart-Computer");
  });

  const exercise = (
    approve: (r: SshSetupReview) => SshSetupApproval,
    options: { legacy?: boolean; changed?: boolean; failInstall?: boolean; sudo?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      let installed = false;
      let inspections = 0;
      const prompts: string[] = [];
      vi.mocked(runSshCommand).mockImplementation(() => {
        if (options.failInstall)
          return Effect.fail(
            new SshCommandError({
              message: "fixture rejection",
              command: [],
              exitCode: 1,
              stderr: "",
            }),
          );
        installed = true;
        return Effect.succeed({ stdout: "", stderr: "" });
      });
      const result = yield* Effect.result(
        inspectAndPrepare({
          target,
          auth: {},
          requirements: runtimeRequirements("linux", "test"),
          supportsReview: !options.legacy,
          reviewRequested: true,
          progress: () => Effect.void,
          windowsCommand: [],
          inspect: () =>
            Effect.sync(() => {
              inspections++;
              return {
                stdout: output({
                  ...linux,
                  elevation: options.sudo ? "sudo" : "root",
                  "libatomic.so.1": installed ? "/lib/libatomic.so.1" : "",
                  ...(options.changed && inspections > 1 ? { identity: "different-host" } : {}),
                }),
                stderr: "",
              };
            }),
        }).pipe(
          Effect.provideService(SshPasswordPrompt, {
            isAvailable: true,
            request: (r) => {
              prompts.push(r.purpose ?? "ssh");
              return Effect.succeed("sudo-fixture-only");
            },
            reviewSetup: (r) => Effect.succeed(approve(r)),
          }),
        ),
      );
      return { result, inspections, installed, prompts };
    }).pipe(Effect.provide(NodeServices.layer));
  const approve = (r: SshSetupReview): SshSetupApproval => ({
    reviewId: r.reviewId,
    approved: true,
    providers: [],
  });
  it.effect("installs only after approval and rechecks before returning", () =>
    Effect.gen(function* () {
      const actual = yield* exercise(approve);
      expect(actual.result._tag).toBe("Success");
      expect(actual.inspections).toBe(3);
      expect(actual.installed).toBe(true);
    }),
  );
  it.effect(
    "never installs after rejection, stale approval, legacy client, or destination change",
    () =>
      Effect.gen(function* () {
        for (const [approval, options] of [
          [(r: SshSetupReview) => ({ ...approve(r), approved: false }), {}],
          [(r: SshSetupReview) => ({ ...approve(r), reviewId: "stale" }), {}],
          [approve, { legacy: true }],
          [approve, { changed: true }],
        ] as const) {
          const actual = yield* exercise(approval, options);
          expect(actual.result._tag).toBe("Failure");
          expect(actual.installed).toBe(false);
        }
        expect(runSshCommand).not.toHaveBeenCalled();
      }),
  );
  it.effect("keeps sudo credentials separate and sanitizes installer failures", () =>
    Effect.gen(function* () {
      const actual = yield* exercise(approve, { sudo: true, failInstall: true });
      expect(actual.result._tag).toBe("Failure");
      expect(actual.prompts).toEqual(["elevation"]);
      const call = vi.mocked(runSshCommand).mock.calls[0]!;
      expect(call[0].executionSource).toEqual({ type: "wsl", distro: "Ubuntu" });
      expect(call[1]!.remoteCommandArgs?.join(" ")).not.toContain("sudo-fixture-only");
      expect(call[1]!.stdin).toBe("sudo-fixture-only\n");
    }),
  );
});
