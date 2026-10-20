import { describe, expect, it } from "vite-plus/test";
import { combineEditorDestinations, resolveEditorDestination } from "./wslEditorDestinations";

describe("combined editor destinations", () => {
  const options = combineEditorDestinations(
    ["cursor", "vscode", "file-manager"],
    ["vscode", "vscode", "webstorm", "trae", "cursor"],
  );
  it("retains installations on both hosts and unsupported detected editors", () => {
    expect(
      options.filter((entry) => entry.editor === "vscode").map((entry) => entry.source),
    ).toEqual(["windows", "wsl"]);
    expect(options.find((entry) => entry.editor === "webstorm")).toMatchObject({
      enabled: false,
      reason: expect.any(String),
    });
    expect(options.find((entry) => entry.editor === "trae")).toMatchObject({ enabled: false });
    expect(options.some((entry) => entry.editor === "file-manager")).toBe(false);
  });
  it("migrates an editor-only preference to its WSL installation", () => {
    expect(resolveEditorDestination(options, null, "vscode")).toMatchObject({
      editor: "vscode",
      source: "wsl",
    });
  });
  it("remembers distinct installations and falls back when one disappears", () => {
    expect(
      resolveEditorDestination(options, { editor: "vscode", source: "windows" }, "cursor"),
    ).toMatchObject({ editor: "vscode", source: "windows" });
    expect(
      resolveEditorDestination(options, { editor: "zed", source: "windows" }, "vscode"),
    ).toMatchObject({ editor: "cursor", source: "wsl" });
  });
  it("handles Windows-only, WSL-only, empty and unsupported-only detections", () => {
    expect(
      resolveEditorDestination(combineEditorDestinations([], ["vscode"]), null, null)?.source,
    ).toBe("windows");
    expect(
      resolveEditorDestination(combineEditorDestinations(["trae"], []), null, null)?.source,
    ).toBe("wsl");
    expect(resolveEditorDestination([], null, null)).toBeNull();
    expect(
      resolveEditorDestination(combineEditorDestinations([], ["webstorm"]), null, null),
    ).toBeNull();
  });
});
