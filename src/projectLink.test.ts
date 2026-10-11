import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addModToProject, addToProject, canLinkModToProjects, modProjectLink, modSourceProject, removeFromProject, removeModFromProject } from "./projectLink";
import { ItemMetadata, ModEntry, ProjectWorkspace, ToolConfig } from "./types";

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

describe("addToProject into the global folder", () => {
  it("symlinks a project's own skill into the tool's global folder", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "skillmanager-test-")));
    try {
      const projectSkill = join(root, "project", ".claude", "skills", "repo-skill");
      mkdirSync(projectSkill, { recursive: true });
      writeFileSync(join(projectSkill, "SKILL.md"), "---\nname: repo-skill\n---\n");
      const tool: ToolConfig = { id: "claude-code", name: "Claude Code", icon: "asterisk", paths: { skill: join(root, "global-skills") } };
      addToProject({ ...makeItem(join(projectSkill, "SKILL.md")), type: "skill", projectId: "p" }, tool, null);
      expect(readlinkSync(join(root, "global-skills", "repo-skill"))).toBe(projectSkill);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("mod project links", () => {
  let root: string;
  let project: ProjectWorkspace;
  let tool: ToolConfig;
  let mod: ModEntry;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "skillmanager-test-")));
    project = { id: "proj-1", name: "Test project", path: join(root, "project") };
    mkdirSync(project.path, { recursive: true });
    // A repo checkout reached through a symlinked folder, like ~/mods -> ~/Documents/Repos/mods.
    const repoMod = join(root, "Repos", "mods", "pane");
    mkdirSync(repoMod, { recursive: true });
    symlinkSync(join(root, "Repos", "mods"), join(root, "mods"));
    tool = { id: "claude-code", name: "Claude Code", icon: "asterisk", paths: { skill: join(root, "skills") }, projectPaths: { skill: ".claude/skills" } };
    mod = { id: join(root, "mods", "pane"), name: "pane", path: join(root, "mods", "pane"), realPath: repoMod, toolId: "claude-code", origin: "plugin-dir", enabled: true };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("links a mod into the project's skills folder through the path it was found at, and unlinks it", () => {
    addModToProject(mod, tool, project);
    const link = join(project.path, ".claude", "skills", "pane");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(mod.path);
    expect(modProjectLink(mod, tool, project)).toBe(link);

    removeModFromProject(mod, tool, project);
    expect(existsSync(link)).toBe(false);
    expect(existsSync(mod.realPath)).toBe(true);
    expect(modProjectLink(mod, tool, project)).toBeNull();
  });

  it("finds a link under another name and refuses to replace a real folder", () => {
    const skills = join(project.path, ".claude", "skills");
    mkdirSync(join(skills, "pane"), { recursive: true });
    expect(() => addModToProject(mod, tool, project)).toThrow(/already exists/);
    symlinkSync(mod.realPath, join(skills, "renamed"));
    expect(modProjectLink(mod, tool, project)).toBe(join(skills, "renamed"));
  });

  it("links a mod kept in a project into the global skills folder, and knows where it's kept", () => {
    const kept = join(project.path, ".claude", "skills", "kept");
    mkdirSync(kept, { recursive: true });
    const projectMod: ModEntry = { ...mod, id: kept, name: "kept", path: kept, realPath: kept, origin: "skill", projectId: project.id };
    addModToProject(projectMod, tool, null);
    const link = join(root, "skills", "kept");
    expect(readlinkSync(link)).toBe(kept);
    expect(modProjectLink(projectMod, tool, null)).toBe(link);
    expect(modSourceProject(projectMod, tool, [project])).toMatchObject({ project: { id: project.id }, loadsThere: true });
    expect(modSourceProject(mod, tool, [project])).toBeNull();
    removeModFromProject(projectMod, tool, null);
    expect(existsSync(link)).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });

  it("only offers linking for folders the person keeps", () => {
    expect(canLinkModToProjects(mod, tool)).toBe(true);
    expect(canLinkModToProjects({ ...mod, origin: "installed" }, tool)).toBe(false);
    expect(canLinkModToProjects({ ...mod, origin: "dev" }, tool)).toBe(false);
    expect(canLinkModToProjects(mod, { ...tool, projectPaths: {} })).toBe(true);
    expect(canLinkModToProjects(mod, { ...tool, paths: {}, projectPaths: {} })).toBe(false);
  });
});
