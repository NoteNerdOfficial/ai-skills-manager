import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMcpServersFromFile, readMcpServersFromToml, scanMcpServers } from "./mcpScanners";
import { ProjectWorkspace, ToolConfig } from "./types";

function makeTool(overrides: Partial<ToolConfig> = {}): ToolConfig {
  return { id: "claude-code", name: "Claude Code", icon: "asterisk", paths: {}, ...overrides };
}

describe("readMcpServersFromFile", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skillmanager-mcp-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns an empty object when the file doesn't exist", () => {
    expect(readMcpServersFromFile(join(root, "missing.json"))).toEqual({});
  });

  it("returns an empty object for malformed JSON instead of throwing", () => {
    const filePath = join(root, "broken.json");
    writeFileSync(filePath, "{not json");
    expect(readMcpServersFromFile(filePath)).toEqual({});
  });

  it("reads the mcpServers map out of a config file", () => {
    const filePath = join(root, ".mcp.json");
    writeFileSync(
      filePath,
      JSON.stringify({ mcpServers: { fetch: { command: "npx", args: ["-y", "mcp-fetch"] } } })
    );
    expect(readMcpServersFromFile(filePath)).toEqual({ fetch: { command: "npx", args: ["-y", "mcp-fetch"] } });
  });

  it("reads a non-default key, e.g. VS Code's .vscode/mcp.json 'servers'", () => {
    const filePath = join(root, "mcp.json");
    writeFileSync(filePath, JSON.stringify({ servers: { figma: { type: "http", url: "https://mcp.figma.com/mcp" } } }));
    expect(readMcpServersFromFile(filePath, "servers")).toEqual({ figma: { type: "http", url: "https://mcp.figma.com/mcp" } });
  });
});

describe("readMcpServersFromToml", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skillmanager-mcp-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns an empty object when the file doesn't exist", () => {
    expect(readMcpServersFromToml(join(root, "missing.toml"))).toEqual({});
  });

  it("parses a Codex-style config.toml with command/args/env and a second http server", () => {
    const filePath = join(root, "config.toml");
    writeFileSync(
      filePath,
      [
        'numStartups = 3',
        '',
        "[mcp_servers.pencil]",
        'command = "/Applications/Pencil.app/mcp-server"',
        "",
        "[mcp_servers.fetch]",
        'command = "npx"',
        'args = ["-y", "mcp-fetch"]',
        'env = { API_KEY = "abc123", REGION = "us" }',
        "",
        "[mcp_servers.figma]",
        'type = "http"',
        'url = "https://mcp.figma.com/mcp"',
        "",
        "[some_other_table]",
        'command = "should not be picked up"',
      ].join("\n")
    );

    expect(readMcpServersFromToml(filePath)).toEqual({
      pencil: { command: "/Applications/Pencil.app/mcp-server" },
      fetch: { command: "npx", args: ["-y", "mcp-fetch"], env: { API_KEY: "abc123", REGION: "us" } },
      figma: { type: "http", url: "https://mcp.figma.com/mcp" },
    });
  });

  it("returns an empty object for a file with no mcp_servers tables", () => {
    const filePath = join(root, "config.toml");
    writeFileSync(filePath, 'numStartups = 3\n[some_other_table]\nfoo = "bar"\n');
    expect(readMcpServersFromToml(filePath)).toEqual({});
  });
});

describe("scanMcpServers", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skillmanager-mcp-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("skips a tool with no mcpConfigPath/projectMcpConfigPath declared", () => {
    expect(scanMcpServers([makeTool()], [])).toEqual([]);
  });

  it("reads a global server as scope 'global'", () => {
    const globalPath = join(root, "claude.json");
    writeFileSync(globalPath, JSON.stringify({ mcpServers: { docs: { url: "https://example.com/mcp" } } }));

    const entries = scanMcpServers([makeTool({ mcpConfigPath: globalPath })], []);

    expect(entries).toEqual([
      {
        entryId: `claude-code:global:${globalPath}:docs`,
        tool: "claude-code",
        name: "docs",
        scope: "global",
        config: { url: "https://example.com/mcp" },
        sourcePath: globalPath,
      },
    ]);
  });

  it("reads a project-scoped server for each tracked project", () => {
    const projectDir = join(root, "my-project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, ".mcp.json"), JSON.stringify({ mcpServers: { fetch: { command: "npx" } } }));
    const project: ProjectWorkspace = { id: "proj-1", name: "My Project", path: projectDir };

    const entries = scanMcpServers([makeTool({ projectMcpConfigPath: ".mcp.json" })], [project]);

    expect(entries).toEqual([
      {
        entryId: `claude-code:project:proj-1:${join(projectDir, ".mcp.json")}:fetch`,
        tool: "claude-code",
        name: "fetch",
        scope: { projectId: "proj-1", projectName: "My Project" },
        config: { command: "npx" },
        sourcePath: join(projectDir, ".mcp.json"),
      },
    ]);
  });

  it("shows the same server name from two different config files as two separate entries", () => {
    const globalPath = join(root, "claude.json");
    writeFileSync(globalPath, JSON.stringify({ mcpServers: { fetch: { command: "global-fetch" } } }));
    const projectDir = join(root, "my-project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, ".mcp.json"), JSON.stringify({ mcpServers: { fetch: { command: "project-fetch" } } }));
    const project: ProjectWorkspace = { id: "proj-1", name: "My Project", path: projectDir };

    const entries = scanMcpServers(
      [makeTool({ mcpConfigPath: globalPath, projectMcpConfigPath: ".mcp.json" })],
      [project]
    );

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.config.command).sort()).toEqual(["global-fetch", "project-fetch"]);
  });

  it("honors mcpConfigKey for a tool whose config uses a different top-level key", () => {
    const projectDir = join(root, "my-project");
    mkdirSync(join(projectDir, ".vscode"), { recursive: true });
    writeFileSync(
      join(projectDir, ".vscode", "mcp.json"),
      JSON.stringify({ servers: { figma: { type: "http", url: "https://mcp.figma.com/mcp" } } })
    );
    const project: ProjectWorkspace = { id: "proj-1", name: "My Project", path: projectDir };

    const entries = scanMcpServers(
      [makeTool({ id: "copilot", name: "GitHub Copilot", projectMcpConfigPath: ".vscode/mcp.json", mcpConfigKey: "servers" })],
      [project]
    );

    expect(entries).toEqual([
      {
        entryId: `copilot:project:proj-1:${join(projectDir, ".vscode", "mcp.json")}:figma`,
        tool: "copilot",
        name: "figma",
        scope: { projectId: "proj-1", projectName: "My Project" },
        config: { type: "http", url: "https://mcp.figma.com/mcp" },
        sourcePath: join(projectDir, ".vscode", "mcp.json"),
      },
    ]);
  });

  it("reads a global TOML config for a tool with mcpConfigFormat 'toml'", () => {
    const globalPath = join(root, "config.toml");
    writeFileSync(globalPath, '[mcp_servers.pencil]\ncommand = "/Applications/Pencil.app/mcp-server"\n');

    const entries = scanMcpServers(
      [makeTool({ id: "codex", name: "Codex", mcpConfigPath: globalPath, mcpConfigFormat: "toml" })],
      []
    );

    expect(entries).toEqual([
      {
        entryId: `codex:global:${globalPath}:pencil`,
        tool: "codex",
        name: "pencil",
        scope: "global",
        config: { command: "/Applications/Pencil.app/mcp-server" },
        sourcePath: globalPath,
      },
    ]);
  });
});
