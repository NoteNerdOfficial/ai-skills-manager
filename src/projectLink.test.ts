import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addToProject, removeFromProject } from "./projectLink";
import { ItemMetadata, ProjectWorkspace, ToolConfig } from "./types";

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

describe("addToProject / removeFromProject", () => {
  let root: string;
  let project: ProjectWorkspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skillmanager-test-"));
    project = { id: "proj-1", name: "Test project", path: join(root, "project") };
    mkdirSync(project.path, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("symlinks a global flat file into the project's tool folder without copying it", () => {
    const globalFile = join(root, "backend.md");
    writeFileSync(globalFile, "some content");

    const tool: ToolConfig = { id: "claude-code", name: "Claude Code", icon: "asterisk", paths: { agent: "~/.claude/agents" } };
    addToProject(makeItem(globalFile), tool, project);

    const linkPath = join(project.path, ".claude/agents/backend.md");
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(linkPath, "utf-8")).toBe("some content");

    // Editing through the link changes the same underlying file — never a separate copy.
    writeFileSync(globalFile, "updated content");
    expect(readFileSync(linkPath, "utf-8")).toBe("updated content");
  });

  it("symlinks a global skill folder as a directory link", () => {
    const skillDir = join(root, "pdf-editing");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), "manifest");

    const tool: ToolConfig = { id: "claude-code", name: "Claude Code", icon: "asterisk", paths: { skill: "~/.claude/skills" } };
    const item = makeItem(join(skillDir, "SKILL.md"));
    item.type = "skill";
    addToProject(item, tool, project);

    const linkPath = join(project.path, ".claude/skills/pdf-editing");
    const stat = lstatSync(linkPath);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(existsSync(join(linkPath, "SKILL.md"))).toBe(true);
  });

  it("is a no-op if the link already exists, rather than throwing or clobbering it", () => {
    const globalFile = join(root, "backend.md");
    writeFileSync(globalFile, "content");
    const tool: ToolConfig = { id: "claude-code", name: "Claude Code", icon: "asterisk", paths: { agent: "~/.claude/agents" } };

    addToProject(makeItem(globalFile), tool, project);
    expect(() => addToProject(makeItem(globalFile), tool, project)).not.toThrow();

    const linkPath = join(project.path, ".claude/agents/backend.md");
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
  });

  it("throws if the tool has no configured path for this item's type", () => {
    const globalFile = join(root, "some.md");
    writeFileSync(globalFile, "content");
    const tool: ToolConfig = { id: "gemini-cli", name: "Gemini CLI", icon: "terminal", paths: { command: "~/.gemini/commands" } };
    const item = makeItem(globalFile);
    item.type = "skill";

    expect(() => addToProject(item, tool, project)).toThrow(/no configured skill path/);
  });

  it("removes only the symlink, leaving the real file it points to untouched", () => {
    const globalFile = join(root, "backend.md");
    writeFileSync(globalFile, "content");
    const linkPath = join(project.path, "backend.md");
    symlinkSync(globalFile, linkPath, "file");

    removeFromProject(linkPath);

    expect(existsSync(linkPath)).toBe(false);
    expect(existsSync(globalFile)).toBe(true);
  });

  it("removes only the symlink to a directory, leaving the real directory and its contents untouched", () => {
    const globalSkillDir = join(root, "pdf-editing");
    mkdirSync(globalSkillDir);
    writeFileSync(join(globalSkillDir, "SKILL.md"), "manifest");
    const linkPath = join(project.path, "pdf-editing");
    symlinkSync(globalSkillDir, linkPath, "dir");

    removeFromProject(linkPath);

    expect(existsSync(linkPath)).toBe(false);
    expect(existsSync(globalSkillDir)).toBe(true);
    expect(existsSync(join(globalSkillDir, "SKILL.md"))).toBe(true);
  });

  it("refuses to remove a real file that isn't a symlink", () => {
    const realFile = join(project.path, "backend.md");
    writeFileSync(realFile, "real content, not a link");

    expect(() => removeFromProject(realFile)).toThrow(/isn't a symlink/);
    expect(existsSync(realFile)).toBe(true);
  });

  it("refuses to remove a real directory that isn't a symlink", () => {
    const realDir = join(project.path, "pdf-editing");
    mkdirSync(realDir);
    writeFileSync(join(realDir, "SKILL.md"), "real manifest, not a link");

    expect(() => removeFromProject(join(realDir, "SKILL.md"))).toThrow(/isn't a symlink/);
    expect(existsSync(realDir)).toBe(true);
  });
});
