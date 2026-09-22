import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { expandHome } from "./scanners";
import { McpServerConfig, McpServerEntry, ProjectWorkspace, ToolConfig } from "./types";

/** Same existsSync-guard/try-catch shape as scanners.ts's readInstalledPlugins — a config file
 *  that doesn't exist or fails to parse just yields no servers, not an error. `key` is the
 *  top-level property holding the server map — "mcpServers" for Claude Code, "servers" for VS
 *  Code's .vscode/mcp.json (see ToolConfig.mcpConfigKey). */
export function readMcpServersFromFile(path: string, key = "mcpServers"): Record<string, McpServerConfig> {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, Record<string, McpServerConfig> | undefined>;
    return raw[key] ?? {};
  } catch {
    return {};
  }
}

/** Minimal TOML reader, scoped to exactly the shape Codex CLI's config.toml uses for MCP servers
 *  (confirmed on-disk): `[<tablePrefix>.NAME]` tables with string, string-array, and inline-table
 *  values. Not a general TOML parser — multi-line values, nested tables, and anything else
 *  outside that narrow shape are simply not handled, since this only ever reads one tool's one
 *  config file for one purpose. */
export function readMcpServersFromToml(path: string, tablePrefix = "mcp_servers"): Record<string, McpServerConfig> {
  if (!existsSync(path)) return {};
  try {
    const prefix = `[${tablePrefix}.`;
    const servers: Record<string, McpServerConfig> = {};
    let current: McpServerConfig | null = null;

    for (const rawLine of readFileSync(path, "utf-8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;

      if (line.startsWith("[")) {
        if (line.startsWith(prefix) && line.endsWith("]")) {
          const name = line.slice(prefix.length, -1).replace(/^["']|["']$/g, "");
          current = {};
          servers[name] = current;
        } else {
          current = null; // a different table entirely — stop collecting into the last server
        }
        continue;
      }

      if (!current) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const rawValue = line.slice(eq + 1).trim();
      if (key === "command") current.command = parseTomlString(rawValue);
      else if (key === "url") current.url = parseTomlString(rawValue);
      else if (key === "type" && (rawValue === '"http"' || rawValue === '"sse"')) current.type = rawValue.slice(1, -1) as "http" | "sse";
      else if (key === "args") current.args = parseTomlStringArray(rawValue);
      else if (key === "env") current.env = parseTomlInlineTable(rawValue);
    }
    return servers;
  } catch {
    return {};
  }
}

function parseTomlString(raw: string): string {
  const match = /^"((?:[^"\\]|\\.)*)"$/.exec(raw);
  return match ? match[1].replace(/\\"/g, '"') : raw;
}

/** Splits on `,` like String.split, but ignores one inside a quoted string (tracking `\"`
 *  escapes) so a value such as `"--flag=a,b"` survives intact instead of being torn in two. */
function splitTopLevelCommas(raw: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"' && raw[i - 1] !== "\\") inString = !inString;
    if (ch === "," && !inString) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function parseTomlStringArray(raw: string): string[] {
  const match = /^\[(.*)\]$/.exec(raw);
  if (!match) return [];
  return splitTopLevelCommas(match[1])
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseTomlString);
}

function parseTomlInlineTable(raw: string): Record<string, string> {
  const match = /^\{(.*)\}$/.exec(raw);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const pair of splitTopLevelCommas(match[1])) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    if (key) result[key] = parseTomlString(pair.slice(eq + 1).trim());
  }
  return result;
}

function readMcpServers(path: string, tool: ToolConfig): Record<string, McpServerConfig> {
  return tool.mcpConfigFormat === "toml"
    ? readMcpServersFromToml(path, tool.mcpConfigKey ?? "mcp_servers")
    : readMcpServersFromFile(path, tool.mcpConfigKey ?? "mcpServers");
}

/** Read-only discovery of MCP servers from every tool that declares a config path (Claude Code,
 *  VS Code, Codex — see DEFAULT_TOOLS). A server defined in both a tool's global and a project's
 *  config shows up as two separate entries rather than being merged, since surfacing that kind of
 *  duplication across configs is the point of this feature, not something to hide. */
export function scanMcpServers(tools: ToolConfig[], projects: ProjectWorkspace[]): McpServerEntry[] {
  const entries: McpServerEntry[] = [];

  for (const tool of tools) {
    if (tool.mcpConfigPath) {
      const globalPath = expandHome(tool.mcpConfigPath);
      for (const [name, config] of Object.entries(readMcpServers(globalPath, tool))) {
        entries.push({
          entryId: `${tool.id}:global:${globalPath}:${name}`,
          tool: tool.id,
          name,
          scope: "global",
          config,
          sourcePath: globalPath,
        });
      }
    }

    if (tool.projectMcpConfigPath) {
      for (const project of projects) {
        const projectPath = join(expandHome(project.path), tool.projectMcpConfigPath);
        for (const [name, config] of Object.entries(readMcpServers(projectPath, tool))) {
          entries.push({
            entryId: `${tool.id}:project:${project.id}:${projectPath}:${name}`,
            tool: tool.id,
            name,
            scope: { projectId: project.id, projectName: project.name },
            config,
            sourcePath: projectPath,
          });
        }
      }
    }
  }

  return entries;
}
