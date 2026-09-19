import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DISABLED_DIRNAME, deleteItem, toggleItemEnabled } from "./itemToggle";
import { ItemMetadata } from "./types";

function makeItem(sourcePath: string): ItemMetadata {
  return {
    entryId: "test-entry",
    sourcePath,
    realPath: sourcePath,
    tool: "claude-code",
    type: "agent",
    projectId: null,
    pluginId: null,
    name: "test",
    description: "",
    enabled: true,
    tags: [],
    favorite: false,
    collections: [],
  };
}

describe("toggleItemEnabled / deleteItem", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skillspace-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("disables a flat file by moving it into a sibling .skillspace-disabled folder", () => {
    const filePath = join(root, "backend.md");
    writeFileSync(filePath, "content");

    toggleItemEnabled(makeItem(filePath));

    expect(existsSync(filePath)).toBe(false);
    const disabledPath = join(root, DISABLED_DIRNAME, "backend.md");
    expect(existsSync(disabledPath)).toBe(true);
  });

  it("re-enables a disabled flat file by moving it back", () => {
    const filePath = join(root, "backend.md");
    writeFileSync(filePath, "content");
    const item = makeItem(filePath);

    toggleItemEnabled(item); // disable
    const disabledPath = join(root, DISABLED_DIRNAME, "backend.md");
    toggleItemEnabled(makeItem(disabledPath)); // re-enable

    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(disabledPath)).toBe(false);
  });

  it("disables a skill folder (SKILL.md's containing directory) as a unit", () => {
    const skillDir = join(root, "pdf-editing");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: pdf-editing\n---\n");
    writeFileSync(join(skillDir, "helper.py"), "print(1)");

    toggleItemEnabled(makeItem(join(skillDir, "SKILL.md")));

    expect(existsSync(skillDir)).toBe(false);
    const disabledDir = join(root, DISABLED_DIRNAME, "pdf-editing");
    expect(existsSync(join(disabledDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(disabledDir, "helper.py"))).toBe(true);
  });

  it("throws rather than clobbering an existing file when disabling twice", () => {
    const filePath = join(root, "backend.md");
    writeFileSync(filePath, "content");
    mkdirSync(join(root, DISABLED_DIRNAME));
    writeFileSync(join(root, DISABLED_DIRNAME, "backend.md"), "already disabled, different content");

    expect(() => toggleItemEnabled(makeItem(filePath))).toThrow(/already disabled/);
    // The pre-existing disabled copy must survive untouched.
    expect(existsSync(filePath)).toBe(true);
  });

  it("throws rather than clobbering an existing file when re-enabling onto a conflict", () => {
    const disabledDir = join(root, DISABLED_DIRNAME);
    mkdirSync(disabledDir);
    const disabledPath = join(disabledDir, "backend.md");
    writeFileSync(disabledPath, "disabled content");
    writeFileSync(join(root, "backend.md"), "already enabled, different content");

    expect(() => toggleItemEnabled(makeItem(disabledPath))).toThrow(/already exists/);
    expect(existsSync(disabledPath)).toBe(true);
  });

  it("re-targets a relative symlink to an absolute path when moving a flat file, so it never dangles", () => {
    // Mirrors a project-scoped instance: a symlink one level under the project's tool folder
    // pointing back at a global skill via a relative "../../" path. Moving it into a nested
    // .skillspace-disabled folder changes its depth, which would break a naive rename.
    const globalTarget = join(root, "global-target.md");
    writeFileSync(globalTarget, "content");

    const projectDir = join(root, "project", "agents");
    mkdirSync(projectDir, { recursive: true });
    const linkPath = join(projectDir, "backend.md");
    symlinkSync("../../global-target.md", linkPath, "file");
    expect(readlinkSync(linkPath)).toBe("../../global-target.md");

    toggleItemEnabled(makeItem(linkPath));

    const disabledLinkPath = join(projectDir, DISABLED_DIRNAME, "backend.md");
    expect(lstatSync(disabledLinkPath).isSymbolicLink()).toBe(true);
    // The relative form would now resolve to the wrong place (one directory deeper) — the
    // absolute rewrite is what keeps this pointing at the real file.
    expect(readlinkSync(disabledLinkPath)).toBe(globalTarget);
    expect(existsSync(disabledLinkPath)).toBe(true); // resolves and the target is readable
  });

  it("re-targets a symlinked skill directory the same way", () => {
    const globalSkillDir = join(root, "global-skills", "pdf-editing");
    mkdirSync(globalSkillDir, { recursive: true });
    writeFileSync(join(globalSkillDir, "SKILL.md"), "manifest");

    const projectDir = join(root, "project", "skills");
    mkdirSync(projectDir, { recursive: true });
    const linkPath = join(projectDir, "pdf-editing");
    symlinkSync("../../global-skills/pdf-editing", linkPath, "dir");

    toggleItemEnabled(makeItem(join(linkPath, "SKILL.md")));

    const disabledLinkPath = join(projectDir, DISABLED_DIRNAME, "pdf-editing");
    expect(lstatSync(disabledLinkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(disabledLinkPath)).toBe(globalSkillDir);
    expect(existsSync(join(disabledLinkPath, "SKILL.md"))).toBe(true);
  });

  it("deleteItem removes a flat file", () => {
    const filePath = join(root, "backend.md");
    writeFileSync(filePath, "content");
    deleteItem(makeItem(filePath));
    expect(existsSync(filePath)).toBe(false);
  });

  it("deleteItem removes a skill folder recursively", () => {
    const skillDir = join(root, "pdf-editing");
    mkdirSync(join(skillDir, "scripts"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "manifest");
    writeFileSync(join(skillDir, "scripts", "helper.py"), "print(1)");

    deleteItem(makeItem(join(skillDir, "SKILL.md")));

    expect(existsSync(skillDir)).toBe(false);
  });

  it("deleteItem on a project-linked symlink removes only the link, never the real target", () => {
    // This is the case that matters most: uninstalling a project-scoped instance of a shared
    // global skill must never reach through the symlink and delete the global copy other
    // projects still depend on.
    const globalSkillDir = join(root, "global-skills", "pdf-editing");
    mkdirSync(globalSkillDir, { recursive: true });
    writeFileSync(join(globalSkillDir, "SKILL.md"), "manifest");
    writeFileSync(join(globalSkillDir, "helper.py"), "print(1)");

    const projectDir = join(root, "project", "skills");
    mkdirSync(projectDir, { recursive: true });
    const linkPath = join(projectDir, "pdf-editing");
    symlinkSync(globalSkillDir, linkPath, "dir");

    deleteItem(makeItem(join(linkPath, "SKILL.md")));

    expect(existsSync(linkPath)).toBe(false); // the link is gone
    expect(existsSync(globalSkillDir)).toBe(true); // the real global skill is untouched
    expect(existsSync(join(globalSkillDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(globalSkillDir, "helper.py"))).toBe(true);
  });
});
