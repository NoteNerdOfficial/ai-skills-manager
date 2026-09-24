import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanAllPlugins, scanAllTools, scanBrokenSymlinks, scanProject, scanTool } from "./scanners";
import { ProjectWorkspace, ToolConfig } from "./types";

function makeTool(pluginsRegistry: string, pluginsSettingsPath: string): ToolConfig {
  return {
    id: "claude-code",
    name: "Claude Code",
    icon: "asterisk",
    paths: { skill: "skills" },
    pluginsRegistry,
    pluginsSettingsPath,
  };
}

describe("scanAllPlugins", () => {
  let root: string;
  let registryPath: string;
  let settingsPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skillmanager-plugin-scan-"));
    registryPath = join(root, "installed_plugins.json");
    settingsPath = join(root, "settings.json");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function installPlugin(key: string, repository?: string) {
    const installPath = join(root, "cache", key);
    mkdirSync(join(installPath, "skills", "my-skill"), { recursive: true });
    writeFileSync(join(installPath, "skills", "my-skill", "SKILL.md"), "---\nname: my-skill\n---\n");
    mkdirSync(join(installPath, ".claude-plugin"), { recursive: true });
    writeFileSync(join(installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name: key.split("@")[0], repository }));
    writeFileSync(
      registryPath,
      JSON.stringify({ plugins: { [key]: [{ installPath }] } })
    );
    return installPath;
  }

  it("reads a plugin's own github repository URL from its manifest", () => {
    installPlugin("foo@bar", "https://github.com/someone/foo");
    const { plugins } = scanAllPlugins([makeTool(registryPath, settingsPath)]);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].repoUrl).toBe("https://github.com/someone/foo");
  });

  it("leaves repoUrl unset for a non-github or missing repository field", () => {
    installPlugin("foo@bar", "https://gitlab.com/someone/foo");
    const { plugins } = scanAllPlugins([makeTool(registryPath, settingsPath)]);
    expect(plugins[0].repoUrl).toBeUndefined();
  });

  it("defaults a plugin absent from enabledPlugins to enabled", () => {
    installPlugin("foo@bar");
    writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: {} }));
    const { plugins } = scanAllPlugins([makeTool(registryPath, settingsPath)]);
    expect(plugins[0].enabled).toBe(true);
  });

  it("reads an explicit false from enabledPlugins", () => {
    installPlugin("foo@bar");
    writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: { "foo@bar": false } }));
    const { plugins } = scanAllPlugins([makeTool(registryPath, settingsPath)]);
    expect(plugins[0].enabled).toBe(false);
  });

  it("forces every item's enabled to false when its plugin is disabled, regardless of its own folder", () => {
    installPlugin("foo@bar");
    writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: { "foo@bar": false } }));
    const { items } = scanAllPlugins([makeTool(registryPath, settingsPath)]);
    expect(items).toHaveLength(1);
    expect(items[0].enabled).toBe(false);
  });

  it("discovers Codex plugins from versioned cache folders and scans their commands folder", () => {
    const cache = join(root, "codex-cache", "openai-curated", "demo", "1.2.3");
    mkdirSync(join(cache, ".codex-plugin"), { recursive: true });
    writeFileSync(join(cache, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "Demo", repository: "https://github.com/acme/demo" }));
    mkdirSync(join(cache, "commands"), { recursive: true });
    writeFileSync(join(cache, "commands", "ship.md"), "---\nname: ship\ndescription: Ship it\n---\n");

    const tool: ToolConfig = {
      id: "codex",
      name: "Codex",
      icon: "code-2",
      paths: { skill: "~/.codex/skills", command: "~/.codex/prompts", agent: "~/.codex/agents" },
      pluginsPaths: [join(root, "codex-cache")],
      pluginPaths: { command: "commands" },
    };
    const result = scanAllPlugins([tool]);
    expect(result.plugins).toEqual([
      expect.objectContaining({ id: "codex:openai-curated:demo", name: "Demo", enabled: true, repoUrl: "https://github.com/acme/demo" }),
    ]);
    expect(result.items).toEqual([
      expect.objectContaining({ name: "ship", type: "command", pluginId: "codex:openai-curated:demo", description: "Ship it" }),
    ]);
  });
});

describe("broken symlink scanning", () => {
  it("reports a dangling link without treating it as a normal item", () => {
    const root = mkdtempSync(join(tmpdir(), "skillmanager-broken-link-"));
    try {
      const skills = join(root, "skills");
      mkdirSync(skills);
      symlinkSync(join(root, "missing-skill"), join(skills, "missing-skill"), "dir");
      const tool: ToolConfig = { id: "test", name: "Test", icon: "box", paths: { skill: skills } };

      expect(scanAllTools([tool])).toEqual([]);
      expect(scanBrokenSymlinks([tool], [])).toEqual([
        expect.objectContaining({ path: join(skills, "missing-skill"), target: join(root, "missing-skill"), tool: "test", type: "skill" }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps two discovered paths to one real file as separate entries", () => {
    const root = mkdtempSync(join(tmpdir(), "skillmanager-shared-link-"));
    try {
      const target = join(root, "shared.md");
      const first = join(root, "one");
      const second = join(root, "two");
      writeFileSync(target, "---\nname: shared\n---\ncontent");
      mkdirSync(first);
      mkdirSync(second);
      symlinkSync(target, join(first, "shared.md"));
      symlinkSync(target, join(second, "shared.md"));
      const tool: ToolConfig = { id: "test", name: "Test", icon: "box", paths: { agent: first, command: second } };
      const items = scanAllTools([tool]);
      expect(items).toHaveLength(2);
      expect(new Set(items.map((item) => item.entryId)).size).toBe(2);
      expect(new Set(items.map((item) => item.realPath)).size).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ruleAdditionalPaths / ruleAdditionalProjectPaths", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skillmanager-rule-extra-paths-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("scans a tool's extra global rules directory recursively, ignoring a non-.md sibling", () => {
    const rulesDir = join(root, "rules");
    mkdirSync(join(rulesDir, "sub"), { recursive: true });
    writeFileSync(join(rulesDir, "a.md"), "---\nname: a\n---\n");
    writeFileSync(join(rulesDir, "sub", "b.md"), "---\nname: b\n---\n");
    writeFileSync(join(rulesDir, "c.md.bak-2026"), "stale backup, not a rule");

    const tool: ToolConfig = {
      id: "test",
      name: "Test",
      icon: "box",
      paths: {},
      ruleAdditionalPaths: [{ path: rulesDir, singleFile: false }],
    };

    const items = scanTool(tool);
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.name))).toEqual(new Set(["a", "b"]));
    expect(items.every((item) => item.type === "rule")).toBe(true);
  });

  it("scans a tool's extra project-scoped rules directory the same way", () => {
    const projectRoot = join(root, "myproject");
    const rulesDir = join(projectRoot, ".claude", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "a.md"), "content");

    const tool: ToolConfig = {
      id: "claude-code",
      name: "Claude Code",
      icon: "asterisk",
      paths: {},
      ruleAdditionalProjectPaths: [{ path: ".claude/rules", singleFile: false }],
    };
    const project: ProjectWorkspace = { id: "p1", name: "myproject", path: projectRoot };

    const items = scanProject([tool], project);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(expect.objectContaining({ name: "a", type: "rule", projectId: "p1" }));
  });

  it("Claude Code's DEFAULT_TOOLS entry scans ~/.claude/rules and <project>/.claude/rules by default", async () => {
    // Regression guard for the actual fix: without a ruleAdditionalPaths default on the built-in
    // Claude Code tool entry, a rules/ folder next to CLAUDE.md was never scanned at all.
    const { DEFAULT_TOOLS } = await import("./types");
    const claudeCode = DEFAULT_TOOLS.find((tool) => tool.id === "claude-code");
    expect(claudeCode?.ruleAdditionalPaths).toEqual([{ path: "~/.claude/rules", singleFile: false }]);
    expect(claudeCode?.ruleAdditionalProjectPaths).toEqual([{ path: ".claude/rules", singleFile: false }]);
  });
});
