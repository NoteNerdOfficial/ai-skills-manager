import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, type Stats } from "fs";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "path";
import { slug } from "./format";
import { DISABLED_DIRNAME } from "./itemToggle";
import { BrokenSymlink, DiscoveredItem, ItemType, PluginSource, ProjectWorkspace, RulePathEntry, ToolConfig } from "./types";

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

/** Keeps an item's identity stable across the enable/disable move while still distinguishing
 *  two same-named entries found in different directories. */
function stableEntryPath(sourcePath: string): string {
  return sourcePath
    .split(sep)
    .filter((segment) => segment !== DISABLED_DIRNAME)
    .join(sep);
}

export function makeEntryId(
  toolId: string,
  type: ItemType,
  projectId: string | null,
  pluginId: string | null,
  name: string,
  identityPath?: string
): string {
  return slug(`${toolId}-${type}-${projectId ?? "global"}-${pluginId ?? "none"}-${name}-${identityPath ?? name}`);
}

const MAX_SCAN_DEPTH = 4;
const SKIP_DIRNAMES = new Set([DISABLED_DIRNAME, "node_modules", ".git"]);

/** A flat .md file whose basename is an index/readme convention rather than an actual
 *  skill/agent/command a user wrote — e.g. a loose ~/.claude/skills/skills_index.md previously
 *  got listed as a skill of its own. Case-insensitive, matching how these filesystems actually
 *  behave. Deliberately narrow (exact "readme"/"index", or an "*_index"/"*-index" suffix) so a
 *  legitimately named item never disappears because it happens to contain "index" somewhere. */
function isIndexLikeFileName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  const base = lower.replace(/\.md$/, "");
  return base === "readme" || base === "index" || base.endsWith("_index") || base.endsWith("-index");
}

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
    if (SKIP_DIRNAMES.has(entry)) continue; // .skillmanager-disabled is scanned separately below
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
          entryId: makeEntryId(tool.id, type, projectId, pluginId, entry, stableEntryPath(manifest)),
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
        items.push(...scanCategoryFolder(entryPath, tool, type, projectId, pluginId, enabled, depth + 1));
      }
      continue;
    }

    if (entry.endsWith(".md")) {
      // An index/readme-style file documents its containing folder rather than being an item
      // itself — skip it for skill/agent/command. Rules are exempt: Claude Code (and others)
      // load every .md under a rules directory, so a genuinely-named "README.md" rule file is
      // meant to be read as a rule, not filtered out (see the DEFAULT_TOOLS ruleAdditionalPaths
      // comment for the source on that).
      if (type !== "rule" && isIndexLikeFileName(entry)) continue;
      // Strip a known compound suffix whole (foo.instructions.md -> foo), not just the
      // trailing .md, so a Copilot instructions/prompt file doesn't display with it dangling.
      const baseName = entry.replace(/\.(?:instructions|prompt)\.md$|\.md$/, "");
      const meta = readSourceMeta(entryPath);
      items.push({
        entryId: makeEntryId(tool.id, type, projectId, pluginId, baseName, stableEntryPath(entryPath)),
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

/** itemToggle.ts disables an item into a ".skillmanager-disabled" sibling in ITS OWN parent
 *  folder — which, for an item nested inside a category folder (e.g. skills/engineering/tdd),
 *  is the category folder, not the top-level configured tool path. So the enabled/disabled pair
 *  has to be checked at every folder level scanEntries recurses into, not just the top: otherwise
 *  a disabled item nested inside a category folder is invisible to both the enabled walk (which
 *  skips ".skillmanager-disabled" by name) and a single top-level-only disabled scan. A folder
 *  we're already scanning as "disabled" needs no further pairing — nothing is disabled-within-disabled. */
function scanCategoryFolder(
  dir: string,
  tool: ToolConfig,
  type: ItemType,
  projectId: string | null,
  pluginId: string | null,
  enabled: boolean,
  depth: number
): DiscoveredItem[] {
  const items = scanEntries(dir, tool, type, projectId, pluginId, enabled, depth);
  if (!enabled) return items;
  return [...items, ...scanEntries(join(dir, DISABLED_DIRNAME), tool, type, projectId, pluginId, false, depth)];
}

function scanDirectory(
  dir: string,
  tool: ToolConfig,
  type: ItemType,
  projectId: string | null,
  pluginId: string | null
): DiscoveredItem[] {
  return scanCategoryFolder(dir, tool, type, projectId, pluginId, true, 0);
}

/** For a tool whose configured path is one instructions file (ToolConfig.singleFileRule) rather
 *  than a directory — e.g. Claude Code's CLAUDE.md — the whole file is the item, so this reads
 *  it directly instead of readdir-ing it. Mirrors scanDirectory's enabled/disabled pair: the
 *  disabled copy sits at <parent>/.skillmanager-disabled/<filename>, exactly where itemToggle.ts's
 *  generic move-to-sibling-folder logic already puts it for a lone file. */
function scanSingleFile(
  filePath: string,
  tool: ToolConfig,
  type: ItemType,
  projectId: string | null,
  pluginId: string | null
): DiscoveredItem[] {
  const fileName = basename(filePath);
  const disabledPath = join(dirname(filePath), DISABLED_DIRNAME, fileName);

  const items: DiscoveredItem[] = [];
  for (const [path, enabled] of [
    [filePath, true],
    [disabledPath, false],
  ] as const) {
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    const meta = readSourceMeta(path);
    items.push({
      entryId: makeEntryId(tool.id, type, projectId, pluginId, fileName, stableEntryPath(path)),
      sourcePath: path,
      realPath: resolveRealPath(path),
      tool: tool.id,
      type,
      projectId,
      pluginId,
      name: meta.name || fileName.replace(/\.md$/, ""),
      description: meta.description,
      enabled,
    });
  }
  return items;
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
  // A single-file rule (CLAUDE.md) is the user's own project memory, not a manifest an
  // installed GitHub skill would replace — and resolveToolDir would point the install flow's
  // mkdir/copy straight at the file's own path. Left off the candidate list entirely.
  return CANDIDATE_TYPE_ORDER.filter((type) => known.has(type) && !(type === "rule" && tool.singleFileRule));
}

/** Reads one ruleAdditionalPaths/ruleAdditionalProjectPaths entry, using its own stored
 *  singleFile flag rather than the tool-wide singleFileRule — see RulePathEntry. */
function scanRuleEntry(
  entry: RulePathEntry,
  resolvedPath: string,
  tool: ToolConfig,
  projectId: string | null
): DiscoveredItem[] {
  return entry.singleFile
    ? scanSingleFile(resolvedPath, tool, "rule", projectId, null)
    : scanDirectory(resolvedPath, tool, "rule", projectId, null);
}

export function scanTool(tool: ToolConfig): DiscoveredItem[] {
  const items: DiscoveredItem[] = [];
  for (const type of Object.keys(tool.paths) as ItemType[]) {
    const dir = resolveToolDir(tool, type, null);
    if (!dir) continue;
    items.push(
      ...(tool.singleFileRule && type === "rule"
        ? scanSingleFile(dir, tool, type, null, null)
        : scanDirectory(dir, tool, type, null, null))
    );
  }
  for (const entry of tool.ruleAdditionalPaths ?? []) {
    if (!entry.path.trim()) continue;
    items.push(...scanRuleEntry(entry, expandHome(entry.path), tool, null));
  }
  return items;
}

export function scanAllTools(tools: ToolConfig[]): DiscoveredItem[] {
  return tools.flatMap(scanTool);
}

function collectBrokenSymlinks(
  root: string,
  tool: ToolConfig,
  type: ItemType,
  projectId: string | null,
  output: BrokenSymlink[],
  seen: Set<string>
): void {
  let stat;
  try {
    stat = lstatSync(root);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    try {
      statSync(root);
    } catch {
      if (!seen.has(root)) {
        seen.add(root);
        const target = readlinkSync(root);
        output.push({
          path: root,
          target,
          targetPath: isAbsolute(target) ? target : resolve(dirname(root), target),
          tool: tool.id,
          type,
          projectId,
        });
      }
    }
    return;
  }
  if (!stat.isDirectory() || basename(root) === DISABLED_DIRNAME) return;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) collectBrokenSymlinks(join(root, entry), tool, type, projectId, output, seen);
}

function collectBrokenForGlobalTool(tool: ToolConfig, roots: BrokenSymlink[], seen: Set<string>): void {
  for (const type of Object.keys(tool.paths) as ItemType[]) {
    const dir = resolveToolDir(tool, type, null);
    if (dir) collectBrokenSymlinks(dir, tool, type, null, roots, seen);
  }
  for (const entry of tool.ruleAdditionalPaths ?? []) {
    if (entry.path.trim()) collectBrokenSymlinks(expandHome(entry.path), tool, "rule", null, roots, seen);
  }
}

/** Finds dangling links separately from the normal scanner, which intentionally skips anything
 *  whose target cannot be read. */
export function scanBrokenSymlinks(tools: ToolConfig[], projects: ProjectWorkspace[]): BrokenSymlink[] {
  const output: BrokenSymlink[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    collectBrokenForGlobalTool(tool, output, seen);
    for (const project of projects) {
      for (const type of new Set<ItemType>([
        ...(Object.keys(tool.paths) as ItemType[]),
        ...(Object.keys(tool.projectPaths ?? {}) as ItemType[]),
      ])) {
        const dir = resolveToolDir(tool, type, project);
        if (dir) collectBrokenSymlinks(dir, tool, type, project.id, output, seen);
      }
      for (const entry of tool.ruleAdditionalProjectPaths ?? []) {
        if (entry.path.trim()) collectBrokenSymlinks(join(expandHome(project.path), entry.path), tool, "rule", project.id, output, seen);
      }
    }
  }
  return output;
}

/** Project-scoped tools usually mirror the global layout rooted at the project folder instead
 *  of the home directory (e.g. <project>/.claude/skills, <project>/.agents/skills) — confirmed
 *  against an actual vault where project folders keep their own .agents/skills that other tools
 *  symlink into. A tool whose project-scoped layout genuinely differs (GitHub Copilot uses
 *  .github/ project-side vs .copilot/ globally) declares projectPaths to override this. */
export function scanProject(tools: ToolConfig[], project: ProjectWorkspace): DiscoveredItem[] {
  const items: DiscoveredItem[] = [];
  for (const tool of tools) {
    // Union, not either/or — a tool with a projectPaths override for just one type (e.g. Claude
    // Code's "rule") still falls back to the global paths' other types via resolveToolDir.
    const types = new Set<ItemType>([
      ...(Object.keys(tool.paths) as ItemType[]),
      ...(Object.keys(tool.projectPaths ?? {}) as ItemType[]),
    ]);
    for (const type of types) {
      const dir = resolveToolDir(tool, type, project);
      if (!dir) continue;
      items.push(
        ...(tool.singleFileRule && type === "rule"
          ? scanSingleFile(dir, tool, type, project.id, null)
          : scanDirectory(dir, tool, type, project.id, null))
      );
    }
    for (const entry of tool.ruleAdditionalProjectPaths ?? []) {
      if (!entry.path.trim()) continue;
      items.push(...scanRuleEntry(entry, join(expandHome(project.path), entry.path), tool, project.id));
    }
  }
  return items;
}

export function scanAllProjects(tools: ToolConfig[], projects: ProjectWorkspace[]): DiscoveredItem[] {
  return projects.flatMap((project) => scanProject(tools, project));
}

/** Reads the tool's own "is this installed plugin actually loaded" map (e.g. Claude Code's
 *  ~/.claude/settings.json "enabledPlugins"), if the tool has one configured at all. Missing
 *  file or missing key both read as "not explicitly disabled" (see readPluginEnabled). */
function readPluginEnabledMap(settingsPath: string | undefined): Record<string, boolean> {
  if (!settingsPath || !existsSync(settingsPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as { enabledPlugins?: Record<string, boolean> };
    return raw.enabledPlugins ?? {};
  } catch {
    return {};
  }
}

/** Best-effort: most installed plugins don't declare this at all (observed empty across several
 *  real installs here), so a miss is the common case, not an error — an install-from-URL escape
 *  hatch (see LibraryView's explainPluginToggle) is a bonus when it's there, never assumed. Only
 *  a github.com URL is any use to us, since InstallFromGitHubModal only understands that host. */
function readPluginManifest(installPath: string): { name?: string; repository?: string } {
  for (const folder of [".claude-plugin", ".codex-plugin"]) {
    const manifestPath = join(installPath, folder, "plugin.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const raw = JSON.parse(readFileSync(manifestPath, "utf-8")) as { name?: unknown; repository?: unknown };
      return {
        name: typeof raw.name === "string" ? raw.name : undefined,
        repository: typeof raw.repository === "string" ? raw.repository : undefined,
      };
    } catch {
      return {};
    }
  }
  return {};
}

function readPluginRepoUrl(installPath: string): string | undefined {
  const repo = readPluginManifest(installPath).repository;
  return repo && /^https?:\/\/(www\.)?github\.com\//.test(repo) ? repo : undefined;
}

function readInstalledPlugins(registryPath: string, toolId: string, pluginsSettingsPath: string | undefined): PluginSource[] {
  if (!existsSync(registryPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(registryPath, "utf-8")) as {
      plugins?: Record<string, { installPath?: string }[]>;
    };
    const enabledMap = readPluginEnabledMap(pluginsSettingsPath ? expandHome(pluginsSettingsPath) : undefined);
    const plugins: PluginSource[] = [];
    for (const [key, installs] of Object.entries(raw.plugins ?? {})) {
      const installPath = installs?.[0]?.installPath;
      if (installPath) {
        plugins.push({
          id: key,
          name: key.split("@")[0],
          group: key.split("@")[1],
          path: installPath,
          toolId,
          enabled: enabledMap[key] ?? true,
          repoUrl: readPluginRepoUrl(installPath),
        });
      }
    }
    return plugins;
  } catch {
    return [];
  }
}

/** Codex keeps installed bundles in a versioned cache rather than a registry JSON. Only
 * directories with a .codex-plugin marker count; this avoids treating marketplace source trees
 * or arbitrary folders in the cache as installed plugins. */
function readCachedPlugins(cachePaths: string[], toolId: string): PluginSource[] {
  const plugins: PluginSource[] = [];
  const seen = new Set<string>();
  const seenPluginIds = new Set<string>();
  for (const cachePath of cachePaths) {
    if (!existsSync(cachePath)) continue;
    let marketplaces: string[];
    try {
      marketplaces = readdirSync(cachePath);
    } catch {
      continue;
    }
    for (const marketplace of marketplaces) {
      const marketplacePath = join(cachePath, marketplace);
      let pluginNames: string[];
      try {
        pluginNames = readdirSync(marketplacePath);
      } catch {
        continue;
      }
      for (const pluginName of pluginNames) {
        const pluginPath = join(marketplacePath, pluginName);
        let versions: string[];
        try {
          versions = readdirSync(pluginPath);
        } catch {
          continue;
        }
        for (const version of versions) {
          const installPath = join(pluginPath, version);
          if (!existsSync(join(installPath, ".codex-plugin"))) continue;
          const pluginId = `codex:${marketplace}:${pluginName}`;
          // A cache can retain more than one version/hash during an update. The sidebar models
          // the logical installed plugin, so expose one entry and scan the first valid bundle.
          if (seenPluginIds.has(pluginId)) continue;
          const realInstallPath = resolveRealPath(installPath);
          if (seen.has(realInstallPath)) continue;
          seen.add(realInstallPath);
          seenPluginIds.add(pluginId);
          const manifest = readPluginManifest(installPath);
          plugins.push({
            id: pluginId,
            name: manifest.name || pluginName,
            group: marketplace,
            path: installPath,
            toolId,
            enabled: true,
            repoUrl: readPluginRepoUrl(installPath),
          });
        }
      }
    }
  }
  return plugins;
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
    const discovered = tool.pluginsRegistry
      ? readInstalledPlugins(expandHome(tool.pluginsRegistry), tool.id, tool.pluginsSettingsPath)
      : readCachedPlugins((tool.pluginsPaths ?? []).map(expandHome), tool.id);
    plugins.push(...discovered);
    for (const plugin of discovered) {
      for (const [type, rawPath] of Object.entries(tool.paths) as [ItemType, string][]) {
        const pluginPath = tool.pluginPaths?.[type] ?? toPluginRelative(rawPath);
        const found = scanDirectory(join(plugin.path, pluginPath), tool, type, null, plugin.id);
        // A whole disabled plugin means the tool loads none of its skills, regardless of which
        // folder a given one physically sits in — reflect that on every item rather than only the
        // ones already sitting in a .skillmanager-disabled folder from back when per-item toggling
        // was still allowed for plugins.
        items.push(...(plugin.enabled ? found : found.map((item) => ({ ...item, enabled: false }))));
      }
    }
  }
  return { items, plugins };
}
