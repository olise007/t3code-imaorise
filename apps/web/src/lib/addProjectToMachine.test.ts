import { describe, expect, it, vi } from "vite-plus/test";

import * as runtime from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  addProjectToMachine,
  cloneUrlForProtocol,
  cloneUrlProtocol,
  isDefaultCopiedFile,
} from "./addProjectToMachine";

describe("cloneUrlForProtocol", () => {
  it("switches between scp-style SSH and HTTPS", () => {
    expect(cloneUrlForProtocol("git@github.com:pingdotgg/t3code.git", "https")).toBe(
      "https://github.com/pingdotgg/t3code.git",
    );
    expect(cloneUrlForProtocol("https://github.com/pingdotgg/t3code.git", "ssh")).toBe(
      "git@github.com:pingdotgg/t3code.git",
    );
    expect(cloneUrlForProtocol("ssh://git@gitlab.com/group/sub/repo.git", "https")).toBe(
      "https://gitlab.com/group/sub/repo.git",
    );
  });

  it("keeps the URL as is for its own protocol and drops HTTPS credentials on switch", () => {
    expect(cloneUrlForProtocol("https://token@github.com/a/b.git", "https")).toBe(
      "https://token@github.com/a/b.git",
    );
    expect(cloneUrlForProtocol("https://token@github.com/a/b.git", "ssh")).toBe(
      "git@github.com:a/b.git",
    );
  });

  it("refuses rewrites that would guess wrong", () => {
    expect(cloneUrlForProtocol("ssh://git@host.example:2222/a/b.git", "https")).toBeNull();
    expect(cloneUrlForProtocol("https://host.example:8443/a/b.git", "ssh")).toBeNull();
    expect(cloneUrlForProtocol("https://host.example:8443/a/b.git", "https")).toBe(
      "https://host.example:8443/a/b.git",
    );
    expect(cloneUrlForProtocol("/srv/git/repo.git", "https")).toBeNull();
    expect(cloneUrlProtocol("file:///srv/git/repo.git")).toBeNull();
  });
});

describe("isDefaultCopiedFile", () => {
  it("selects env files anywhere in the tree", () => {
    expect(
      [".env", "apps/web/.env.local", ".envrc", ".dev.vars", "dist.log", ".environment"].filter(
        isDefaultCopiedFile,
      ),
    ).toEqual([".env", "apps/web/.env.local", ".envrc", ".dev.vars"]);
  });
});

it("cancelling while source files are being read never starts a clone", async () => {
  let complete!: (value: {
    _tag: "Success";
    value: { contents: string; truncated: boolean };
  }) => void;
  const pending = new Promise<{ _tag: "Success"; value: { contents: string; truncated: boolean } }>(
    (resolve) => {
      complete = resolve;
    },
  );
  const read = vi
    .spyOn(runtime, "executeAtomQuery")
    .mockImplementation(() => pending as ReturnType<typeof runtime.executeAtomQuery>);
  const command = vi.spyOn(runtime, "runAtomCommand");
  const controller = new AbortController();
  try {
    const operation = addProjectToMachine({
      source: { environmentId: EnvironmentId.make("source"), cwd: "/repo" },
      subdirectory: "",
      target: { environmentId: EnvironmentId.make("target"), label: "Target" },
      projectId: ProjectId.make("copy"),
      title: "Project",
      remoteUrl: "git@example:repo",
      destinationPath: "C:\\Projects\\repo",
      files: [".env"],
      signal: controller.signal,
    });
    controller.abort();
    complete({ _tag: "Success", value: { contents: "secret", truncated: false } });
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(command).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
    command.mockRestore();
  }
});
