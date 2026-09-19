import { describe, expect, it } from "vitest";
import { linkableUnit } from "./fsUnit";

describe("linkableUnit", () => {
  it("treats a SKILL.md path as its containing folder", () => {
    const unit = linkableUnit("/home/user/.claude/skills/pdf-editing/SKILL.md");
    expect(unit).toEqual({
      path: "/home/user/.claude/skills/pdf-editing",
      isDirectory: true,
      name: "pdf-editing",
    });
  });

  it("treats a flat agent/command/rule file as itself", () => {
    const unit = linkableUnit("/home/user/.claude/agents/backend.md");
    expect(unit).toEqual({
      path: "/home/user/.claude/agents/backend.md",
      isDirectory: false,
      name: "backend.md",
    });
  });

  it("is case-sensitive on the SKILL.md filename", () => {
    // Only the exact "SKILL.md" spelling is a manifest — "skill.md" is just a flat file, matching
    // how scanEntries (scanners.ts) only ever produces a directory-unit sourcePath for that exact
    // filename.
    const unit = linkableUnit("/some/dir/skill.md");
    expect(unit.isDirectory).toBe(false);
    expect(unit.path).toBe("/some/dir/skill.md");
  });

  it("derives the folder name correctly for a nested skill", () => {
    const unit = linkableUnit("/a/b/c/my-skill/SKILL.md");
    expect(unit.name).toBe("my-skill");
    expect(unit.path).toBe("/a/b/c/my-skill");
  });
});
