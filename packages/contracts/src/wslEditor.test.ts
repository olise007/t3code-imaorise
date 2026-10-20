import { describe, expect, it } from "vite-plus/test";
import { buildWslEditorUrl } from "./editor.ts";

describe("WSL editor routes", () => {
  const input = {
    backendId: "wsl:default",
    distro: "Ubuntu-24.04",
    editor: "vscode" as const,
    path: "/home/me/project Ω/a #?.ts",
  };
  it.each(["vscode", "vscode-insiders", "cursor"] as const)(
    "opens %s in the exact distribution with an encoded Linux path",
    (editor) => {
      expect(buildWslEditorUrl({ ...input, editor, line: 7, column: 3 })).toBe(
        `${editor}://vscode-remote/wsl+Ubuntu-24.04/home/me/project%20%CE%A9/a%20%23%3F.ts:7:3`,
      );
    },
  );
  it("does not infer WSL support from SSH support", () => {
    expect(buildWslEditorUrl({ ...input, editor: "webstorm" })).toBeUndefined();
    expect(buildWslEditorUrl({ ...input, editor: "zed" })).toBeUndefined();
  });
  it.each(["C:\\work", "relative", "/a\u0000b"])(
    "rejects non-Linux or control-character paths %j",
    (path) => {
      expect(buildWslEditorUrl({ ...input, path })).toBeUndefined();
    },
  );
  it("rejects malformed distro and position metadata", () => {
    expect(buildWslEditorUrl({ ...input, distro: "Ubuntu/other" })).toBeUndefined();
    expect(buildWslEditorUrl({ ...input, line: 0 })).toBeUndefined();
  });
});
