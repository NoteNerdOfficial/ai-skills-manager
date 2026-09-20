import { existsSync, readdirSync, readFileSync, realpathSync, statSync, type Stats } from "fs";
import { homedir } from "os";
import { basename, join, sep } from "path";
import { slug } from "./format";
import { DISABLED_DIRNAME } from "./itemToggle";
import { DiscoveredItem, ItemType, PluginSource, ProjectWorkspace, ToolConfig } from "./types";

export function expandHome(rawPath: string): string {
  return rawPath.startsWith("~") ? join(homedir(), rawPath.slice(1)) : rawPath;
}

/** ~/.claude/skills -> .claude/skills — the same relative layout a tool uses inside a project
 *  folder. Exported so the settings UI can show it as a placeholder for the auto-derived
 *  default when a tool has no explicit projectPaths override for a given type. */
export function toProjectRelative(rawPath: string): string {
  return rawPath.replace(/^~\/?/, "");
}

/** ~/.claude/skills -> skills — a plugin package keeps skills/commands/agents at its own root,
 *  not nested under a tool-specific dotfolder the way a project folder is. */
function toPluginRelative(rawPath: string): string {
  return basename(rawPath);
}

export interface FrontmatterField {
  key: string;
  value: string;
}

/** Parses a file's YAML frontmatter into an ordered list of every field it declares — not just
 *  name/description, but anything a skill/agent/command manifest carries (disable-model-invocation,
 *  argument-hint, allowed-tools, model, license, ...) — so the preview can show the whole block.
 *  Handles bare/quoted scalars and simple block sequences (a "- item" list folded into one
 *  comma-separated value), which covers every frontmatter shape these tools actually emit. */
export function parseFrontmatter(raw: string): FrontmatterField[] {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return [];

  const lines = match[1].split(/\r?\n/);
  const fields: FrontmatterField[] = [];
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;

    const key = kv[1];
    let value = kv[2].trim();
    if (value === "" || value === "|" || value === ">") {
      // Value lives on following indented lines, either a block sequence or a folded/literal
      // scalar — either way, join them into one readable line for display.
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s/.test(lines[j]) && lines[j].trim() !== "") {
        items.push(lines[j].trim().replace(/^-\s*/, ""));
        j++;
      }
      value = items.join(", ");
      i = j - 1;
    }
    fields.push({ key, value: value.replace(/^["']|["']$/g, "") });
  }
  return fields;
}

/** Skill/agent files declare their own name and description in YAML frontmatter — the two
 *  fields the rest of the scanner needs for indexing; the detail preview reads the full set
 *  via parseFrontmatter directly. */
export function parseSourceMeta(raw: string): { name: string; description: string } {
  const fields = parseFrontmatter(raw);
  const find = (key: string) => fields.find((f) => f.key === key)?.value ?? "";
  return { name: find("name"), description: find("description") };
}

function readSourceMeta(filePath: string): { name: string; description: string } {
  try {
    return parseSourceMeta(readFileSync(filePath, "utf-8").slice(0, 4000));
  } catch {
    return { name: "", description: "" };
  }
}

function resolveRealPath(sourcePath: string): string {
  try {
    return realpathSync(sourcePath);
  } catch {
    return sourcePath;
  }
}

export function makeEntryId(
  toolId: string,
  type: ItemType,
  projectId: string | null,
  pluginId: string | null,
  name: string
): string {
  return slug(`${toolId}-${type}-${projectId ?? "global"}-${pluginId ?? "none"}-${name}`);
}

const MAX_SCAN_DEPTH = 4;
const SKIP_DIRNAMES = new Set([DISABLED_DIRNAME, "node_modules", ".git"]);

function scanEntries(
  dir: string,
  tool: ToolConfig,
  type: ItemType,
  projectId: string | null,
  pluginId: string | null,
  enabled: boolean,
  depth = 0
): DiscoveredItem[] {
  if (!existsSync(dir) || depth > MAX_SCAN_DEPTH) return [];

  let entries: string[];
  try {
    // A configured path can exist as a single file rather than a directory (e.g. Cline's legacy
    // single-file .clinerules) — readdirSync throws ENOTDIR on that instead of an empty list.
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const items: DiscoveredItem[] = [];
  for (const entry of entries) {
    if (SKIP_DIRNAMES.has(entry)) continue; // .skillspace-disabled is scanned separately below
    const entryPath = join(dir, entry);

    let stat: Stats;
    try {
      stat = statSync(entryPath);
    } catch {
      // A dangling symlink (or a permission error) shouldn't take down the whole scan.
      continue;
    }

    if (stat.isDirectory()) {
      // A skill/agent may live in its own folder alongside a SKILL.md manifest. If this folder
      // isn't one itself, it may be a category grouping skills a level deeper (some plugins
      // organize skills/engineering/tdd/SKILL.md this way) — recurse rather than give up.
      const manifest = join(entryPath, "SKILL.md");
      if (existsSync(manifest)) {
        const meta = readSourceMeta(manifest);
        items.push({
          entryId: makeEntryId(tool.id, type, projectId, pluginId, entry),
          sourcePath: manifest,
          realPath: resolveRealPath(manifest),
          tool: tool.id,
          type,
          projectId,
          pluginId,
          name: meta.name || entry,
          description: meta.description,
          enabled,
        });
      } else {
        items.push(...scanEntries(entryPath, tool, type, projectId, pluginId, enabled, depth + 1));
      }
      continue;
    }

    if (entry.endsWith(".md")) {
      // Strip a known compound suffix whole (foo.instructions.md -> foo), not just the
      // trailing .md, so a Copilot instructions/prompt file doesn't display with it dangling.
      const baseName = entry.replace(/\.(?:instructions|prompt)\.md$|\.md$/, "");
      const meta = readSourceMeta(entryPath);
      items.push({
        entryId: makeEntryId(tool.id, type, projectId, pluginId, baseName),
        sourcePath: entryPath,
        realPath: resolveRealPath(entryPath),
        tool: tool.id,
        type,
        projectId,
        pluginId,
        name: meta.name || baseName,
        description: meta.description,
        enabled,
      });
    }
  }
  return items;
}

function scanDirectory(
  dir: string,
  tool: ToolConfig,
  type: ItemType,
  projectId: string | null,
  pluginId: string | null
): DiscoveredItem[] {
  return [
    ...scanEntries(dir, tool, type, projectId, pluginId, true),
    ...scanEntries(join(dir, DISABLED_DIRNAME), tool, type, projectId, pluginId, false),
  ];
}

/** The directory a tool's items of a given type live in — global (project === null) or rooted at
 *  a project folder — or null if the tool has no configured path for that type in that scope.
 *  Shared by the scan loops below and by the GitHub-install flow, which needs the exact same
 *  resolution to know where to copy an installed skill to. */
export function resolveToolDir(tool: ToolConfig, type: ItemType, project: ProjectWorkspace | null): string | null {
  if (project === null) {
    const rawPath = tool.paths[type];
    return rawPath ? expandHome(rawPath) : null;
  }
  const relativePath = tool.projectPaths?.[type] ?? (tool.paths[type] ? toProjectRelative(tool.paths[type]) : undefined);
  return relativePath ? join(expandHome(project.path), relativePath) : null;
}

/** Whether sourcePath sits inside one of this tool's known "shipped in the box" subfolders (see
 *  ToolConfig.builtInDirnames) — a plain path-segment check, so it matches regardless of how
 *  deep the item is nested inside that folder. Used to tell a tool-provided default skill (e.g.
 *  Claude Code's synced/ cache) apart from something the user actually installed or wrote. */
export function isBuiltInPath(sourcePath: string, tool: ToolConfig | undefined): boolean {
  if (!tool?.builtInDirnames?.length) return false;
  const segments = sourcePath.split(sep);
  return tool.builtInDirnames.some((name) => segments.includes(name));
}

/** Every type a tool has a configured path for, global or project-scoped, in the fixed display
 *  order — the set of types an install flow can offer for this tool. Shared by
 *  InstallFromGitHubModal (both the "install from GitHub" and "add to another tool" cases). */
const CANDIDATE_TYPE_ORDER: ItemType[] = ["skill", "agent", "command", "rule"];
export function candidateTypesForTool(tool: ToolConfig): ItemType[] {
  const known = new Set([...Object.keys(tool.paths), ...Object.keys(tool.projectPaths ?? {})]);
  return CANDIDATE_TYPE_ORDER.filter((type) => known.has(type));
}

export function scanTool(tool: ToolConfig): DiscoveredItem[] {
  const items: DiscoveredItem[] = [];
  for (const type of Object.keys(tool.paths) as ItemType[]) {
    const dir = resolveToolDir(tool, type, null);
    if (dir) items.push(...scanDirectory(dir, tool, type, null, null));
  }
  return items;
}

export function scanAllTools(tools: ToolConfig[]): DiscoveredItem[] {
  return tools.flatMap(scanTool);
}

/** Project-scoped tools usually mirror the global layout rooted at the project folder instead
 *  of the home directory (e.g. <project>/.claude/skills, <project>/.agents/skills) — confirmed
 *  against an actual vault where project folders keep their own .agents/skills that other tools
 *  symlink into. A tool whose project-scoped layout genuinely differs (GitHub Copilot uses
 *  .github/ project-side vs .copilot/ globally) declares projectPaths to override this. */
export function scanProject(tools: ToolConfig[], project: ProjectWorkspace): DiscoveredItem[] {
  const items: DiscoveredItem[] = [];
  for (const tool of tools) {
    const types = tool.projectPaths ? (Object.keys(tool.projectPaths) as ItemType[]) : (Object.keys(tool.paths) as ItemType[]);
    for (const type of types) {
      const dir = resolveToolDir(tool, type, project);
      if (dir) items.push(...scanDirectory(dir, tool, type, project.id, null));
    }
  }
  return items;
}

export function scanAllProjects(tools: ToolConfig[], projects: ProjectWorkspace[]): DiscoveredItem[] {
  return projects.flatMap((project) => scanProject(tools, project));
}

function readInstalledPlugins(registryPath: string): PluginSource[] {
  if (!existsSync(registryPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(registryPath, "utf-8")) as {
      plugins?: Record<string, { installPath?: string }[]>;
    };
    const plugins: PluginSource[] = [];
    for (const [key, installs] of Object.entries(raw.plugins ?? {})) {
      const installPath = installs?.[0]?.installPath;
      if (installPath) {
        plugins.push({ id: key, name: key.split("@")[0], path: installPath });
      }
    }
    return plugins;
  } catch {
    return [];
  }
}

/** Installed tool plugins bundle their own skills/commands/agents at a versioned install path,
 *  entirely separate from that tool's global directories — confirmed against a real Claude Code
 *  plugin install, which is why they were invisible to scanTool. Returns the discovered items
 *  alongside the plugin list itself, so the sidebar can list every installed plugin (even one
 *  with no matching items) without re-reading the registry. */
export function scanAllPlugins(tools: ToolConfig[]): { items: DiscoveredItem[]; plugins: PluginSource[] } {
  const items: DiscoveredItem[] = [];
  const plugins: PluginSource[] = [];
  for (const tool of tools) {
    if (!tool.pluginsRegistry) continue;
    const discovered = readInstalledPlugins(expandHome(tool.pluginsRegistry));
    plugins.push(...discovered);
    for (const plugin of discovered) {
      for (const [type, rawPath] of Object.entries(tool.paths) as [ItemType, string][]) {
        items.push(...scanDirectory(join(plugin.path, toPluginRelative(rawPath)), tool, type, null, plugin.id));
      }
    }
  }
  return { items, plugins };
}
