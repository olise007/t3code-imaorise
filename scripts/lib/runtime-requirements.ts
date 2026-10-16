// @effect-diagnostics nodeBuiltinImport:off - Build-time ELF inspection is a native tooling boundary.
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const maximum = (versions: readonly string[], fallback: string) =>
  [...versions, fallback]
    .sort((a, b) => {
      const left = a.split(".").map(Number),
        right = b.split(".").map(Number);
      for (let i = 0; i < Math.max(left.length, right.length); i++)
        if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) - (right[i] ?? 0);
      return 0;
    })
    .at(-1)!;

/** Measure every bundled ELF component rather than assuming Node's ABI floor covers addons. */
export async function writeRuntimeRequirements(
  directory: string,
  platform: "linux" | "windows",
  version: string,
) {
  const glibc: string[] = [],
    glibcxx: string[] = [];
  if (platform === "linux") {
    for (const entry of await NodeFS.readdir(directory, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = NodePath.join(entry.parentPath, entry.name);
      const handle = await NodeFS.open(file, "r");
      const magic = Buffer.alloc(4);
      try {
        await handle.read(magic, 0, 4, 0);
      } finally {
        await handle.close();
      }
      if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) continue;
      const { stdout } = await execFile("readelf", ["--version-info", file], {
        maxBuffer: 8 * 1024 * 1024,
      });
      glibc.push(...[...stdout.matchAll(/Name: GLIBC_([\d.]+)/gu)].map((m) => m[1]!));
      glibcxx.push(...[...stdout.matchAll(/Name: GLIBCXX_([\d.]+)/gu)].map((m) => m[1]!));
    }
  }
  const metadata = {
    schemaVersion: 1,
    runtimeVersion: version,
    platform,
    architecture: "x64",
    nodeVersion: "26.8.2",
    minimumGlibc: maximum(glibc, "2.28"),
    minimumGlibcxx: maximum(glibcxx, "3.4.25"),
    minimumKernel: "4.18",
    libraries:
      platform === "linux"
        ? ["libatomic.so.1", "libstdc++.so.6", "libgcc_s.so.1"]
        : ["VCRUNTIME140.dll", "MSVCP140.dll"],
  };
  await NodeFS.writeFile(
    NodePath.join(directory, "runtime-requirements.json"),
    JSON.stringify(metadata, null, 2) + "\n",
  );
}
