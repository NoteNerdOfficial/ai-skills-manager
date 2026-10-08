import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ Modal: class {}, Notice: class {}, Setting: class {} }));

import { parseGitHubUrl } from "./InstallFromGitHubModal";

describe("parseGitHubUrl", () => {
  it("splits a github.com tree URL", () => {
    expect(parseGitHubUrl("https://github.com/owner/repo/tree/main/skills/foo")).toEqual({
      repoUrl: "https://github.com/owner/repo.git",
      ref: "main",
      subpath: "skills/foo",
    });
  });

  it("ignores non-tree github.com paths past owner/repo", () => {
    expect(parseGitHubUrl("https://github.com/owner/repo/blob/main/README.md")).toEqual({
      repoUrl: "https://github.com/owner/repo.git",
      ref: "",
      subpath: "",
    });
  });

  it("splits a tree URL on a self-hosted GitHub", () => {
    expect(parseGitHubUrl("https://git.example.com/team/skills/tree/release")).toEqual({
      repoUrl: "https://git.example.com/team/skills.git",
      ref: "release",
      subpath: "",
    });
  });

  it("keeps nested groups and skips the /-/ segment", () => {
    expect(parseGitHubUrl("https://git.example.com/group/sub/repo/-/tree/v1/a/b")).toEqual({
      repoUrl: "https://git.example.com/group/sub/repo.git",
      ref: "v1",
      subpath: "a/b",
    });
  });

  it("normalizes a bare self-hosted repo URL", () => {
    expect(parseGitHubUrl("https://git.example.com/team/repo.git")?.repoUrl).toBe("https://git.example.com/team/repo.git");
  });

  it("returns null for non-http input", () => {
    expect(parseGitHubUrl("git@github.com:owner/repo.git")).toBeNull();
    expect(parseGitHubUrl("https://github.com/owner")).toBeNull();
  });
});
