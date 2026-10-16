// Versioned vendor artifacts. Native packages bypass moving install scripts and npm hooks.
export interface ProviderArchiveRecipe {
  readonly driver: string;
  readonly version: string;
  readonly url: string;
  readonly integrity: string;
  readonly format: "tar.gz" | "zip";
  readonly executable: string;
  readonly brotli?: boolean;
}
const npm = (
  driver: string,
  version: string,
  name: string,
  integrity: string,
  executable: string,
  brotli = false,
): ProviderArchiveRecipe => ({
  driver,
  version,
  url: `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz`,
  integrity,
  format: "tar.gz",
  executable: `package/${executable}`,
  ...(brotli ? { brotli: true } : {}),
});

export const PROVIDER_RECIPE_REVISION = 1;
export const PROVIDER_RECIPE_CATALOG = [
  {
    driver: "codex",
    label: "Codex",
    command: "codex",
    version: "0.156.1",
    source: "github.com/openai/codex",
    dependency: "",
  },
  {
    driver: "claude",
    label: "Claude Code",
    command: "claude",
    version: "2.1.301",
    source: "registry.npmjs.org/@anthropic-ai/claude-code",
    dependency: "Git Bash on Windows (provided by Git for Windows)",
  },
  {
    driver: "cursor",
    label: "Cursor",
    command: "agent",
    version: null,
    source: "cursor.com/docs/cli/installation",
    dependency: "",
  },
  {
    driver: "grok",
    label: "Grok",
    command: "grok",
    version: "1.0.60",
    source: "registry.npmjs.org/@xai-official/grok",
    dependency: "",
  },
  {
    driver: "opencode",
    label: "OpenCode",
    command: "opencode",
    version: "2.0.30",
    source: "registry.npmjs.org/@opencode/cli",
    dependency: "",
  },
  {
    driver: "antigravity",
    label: "Antigravity",
    command: "antigravity",
    version: "1.3.0",
    source: "dl.google.com/agy-extensions",
    dependency: "User-scoped Node 26.8.2 if Node is missing; npm is not required",
  },
  {
    driver: "pi",
    label: "Pi",
    command: "pi",
    version: "1.3.0",
    source: "github.com/earendil-works/pi",
    dependency: "",
  },
  {
    driver: "muse",
    label: "Muse Code",
    command: "muse",
    version: null,
    source: "api.meta.ai/muse-code",
    dependency: "",
  },
  {
    driver: "acpRegistry",
    label: "ACP Registry",
    command: "",
    version: null,
    source: "agentclientprotocol.com",
    dependency: "Choose a registry agent and its own setup instructions",
  },
] as const;

const native: Readonly<Record<string, readonly ProviderArchiveRecipe[]>> = {
  linux: [
    npm(
      "claude",
      "2.1.301",
      "@anthropic-ai/claude-code-linux-x64",
      "sha512-JNe0VzIuXdaBrtlh+fY2SX5AQLDf8BDfIKrylOWK528AZ/aAq2bJt4SBkPikZ0CvecUbL0YN22Xe7eltAWCJGg==",
      "claude",
    ),
    npm(
      "grok",
      "1.0.60",
      "@xai-official/grok-linux-x64",
      "sha512-7PVvLs9dtokrC+fIkWQ7FQSBRkJfNuAvky3e5GfmjqsElezN9eG+MUBxBuCYrWzbmiBsRbc8nqTsRr9KwHoK0w==",
      "bin/grok.br",
      true,
    ),
    npm(
      "opencode",
      "2.0.30",
      "@opencode/cli-linux-x64-baseline",
      "sha512-TLogU0tVEAyoRlXuqQSuvoeB6dVMy7u0SbM2GV8B0jfu4ErQubTxuZjn5zViX3VUWMoRwt7XzsifO0sysSnBxA==",
      "bin/opencode",
    ),
    {
      driver: "pi",
      version: "1.3.0",
      url: "https://github.com/earendil-works/pi/releases/download/v1.3.0/pi-linux-x64.tar.gz",
      integrity: "sha256:24f5be328b66d4da36876296989501974f43ab8434fbb57c35c523a3ea505ded",
      format: "tar.gz",
      executable: "pi/pi",
    },
  ],
  windows: [
    npm(
      "claude",
      "2.1.301",
      "@anthropic-ai/claude-code-win32-x64",
      "sha512-YXl7/bzqywOZlqMW+18zi52DbZJJD8K5exBI6p2tLs5ZVEUhsd+fPnI+FOTehpRRHQ4imtIRas5zkcb3ninNtw==",
      "claude.exe",
    ),
    npm(
      "grok",
      "1.0.60",
      "@xai-official/grok-win32-x64",
      "sha512-7kVo/cZygRwthz72styGkH/02T/kuAKtmL1KE69kevMCGIKVZDamF0pdzH4WfupLJc4ASHle0g0Mn04a7HVjrA==",
      "bin/grok.exe.br",
      true,
    ),
    npm(
      "opencode",
      "2.0.30",
      "@opencode/cli-windows-x64-baseline",
      "sha512-JMmSTcFdClJvSLB/IlSPG4hn0sB92LGw3VjuH/iVhRBO4D9+su87f51dbndE3yBF1QH5HMVwFe80hP3Q/0M/fQ==",
      "bin/opencode.exe",
    ),
    {
      driver: "pi",
      version: "1.3.0",
      url: "https://github.com/earendil-works/pi/releases/download/v1.3.0/pi-windows-x64.zip",
      integrity: "sha256:daf0ef45fd08f13dbb64c62d559e332c2d3d3087f8ae022ec5a1b9b655b59894",
      format: "zip",
      executable: "pi/pi.exe",
    },
  ],
};
export const providerArchiveRecipe = (driver: string, platform: "linux" | "windows") =>
  native[platform]?.find((r) => r.driver === driver);
export const NODE_PROVIDER_RUNTIME = {
  linux: {
    driver: "node",
    version: "26.8.2",
    url: "https://nodejs.org/dist/v26.8.2/node-v26.8.2-linux-x64.tar.gz",
    integrity: "sha256:badb3fe6a61b85e1352ca6564dc56b8b7bd5ecd5c474c52acc21dd0cdd586f35",
    format: "tar.gz",
    executable: "node-v26.8.2-linux-x64/bin/node",
  },
  windows: {
    driver: "node",
    version: "26.8.2",
    url: "https://nodejs.org/dist/v26.8.2/node-v26.8.2-win-x64.zip",
    integrity: "sha256:cf02f5d0c06c794b84f277177d5cf3743d0924ca49f6641cd435dd7cb6ee9085",
    format: "zip",
    executable: "node-v26.8.2-win-x64/node.exe",
  },
} as const satisfies Readonly<Record<string, ProviderArchiveRecipe>>;
