import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unregisteredRepoFor } from "./sourceRepo";

describe("unregisteredRepoFor", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "skillmanager-repo-")));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds the nearest git repo above a nested item", () => {
    const repo = join(root, "Repos", "skills");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "productivity", "minutes"), { recursive: true });
    expect(unregisteredRepoFor(join(repo, "productivity", "minutes", "SKILL.md"), [])).toBe(repo);
  });

  it("ignores a repo that's already a workspace, a plugin cache, and folders outside any repo", () => {
    const repo = join(root, "skills");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const item = join(repo, "a", "SKILL.md");
    expect(unregisteredRepoFor(item, [{ id: "p", name: "skills", path: repo }])).toBeNull();
    expect(unregisteredRepoFor(item, [], [repo])).toBeNull();
    expect(unregisteredRepoFor(join(root, "store", "a", "SKILL.md"), [])).toBeNull();
  });
});
