import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanAllPlugins } from "./scanners";
import { ToolConfig } from "./types";

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
