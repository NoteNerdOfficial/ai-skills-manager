export type ItemType = "skill" | "agent" | "command" | "rule";

/** Referenced anywhere an icon *id* is required — the ribbon icon, the library view's tab icon,
 *  and the sidebar brand mark. This is a custom mark (not part of Obsidian's built-in Lucide
 *  set), so it's registered with `addIcon()` in `main.ts` before anything reads this id. */
export const PLUGIN_ICON_ID = "skillmanager-shapes";

/** Own copy of a vertical 3-dot "more" glyph, registered the same way as PLUGIN_ICON_ID above.
 *  Obsidian's built-in "more-vertical" Lucide icon is itself vertical, but any other installed
 *  plugin can call addIcon() to redefine that same global id with a different (e.g. horizontal)
 *  glyph — a real collision seen in testing. Using our own id sidesteps that entirely. */
export const MORE_ICON_ID = "skillmanager-more";

/** Same reasoning as MORE_ICON_ID, laid out horizontally — used by card footers (skill cards,
 *  Discover cards), where that orientation reads better than the sidebar's vertical one. */
export const MORE_HORIZONTAL_ICON_ID = "skillmanager-more-horizontal";

export type EnabledFilter = "all" | "enabled" | "disabled";
export type SortOrder = "name-asc" | "name-desc" | "modified-desc" | "modified-asc";

export const TYPE_LABELS: Record<ItemType, string> = {
  skill: "Skills",
  agent: "Agents",
  command: "Commands",
  rule: "Rules",
};

/** Singular form for labeling one item at a time — a card's type pill, its detail panel.
 *  TYPE_LABELS stays plural since it's a category label (sidebar counts, section titles). */
export const TYPE_LABEL_SINGULAR: Record<ItemType, string> = {
  skill: "Skill",
  agent: "Agent",
  command: "Command",
  rule: "Rule",
};

export interface ToolConfig {
  id: string;
  name: string;
  /** Lucide icon name — used unless svgIcon is set. */
  icon: string;
  /** Raw inline SVG for the tool's real logo, its fill set to currentColor so it inherits the
   *  same muted, theme-adaptive color every other sidebar icon already uses — no per-tool
   *  brand color, no separate light/dark variants to maintain. */
  svgIcon?: string;
  paths: Partial<Record<ItemType, string>>;
  /** Overrides the auto-derived project-local paths (normally just "~/" stripped from the
   *  global path) for a tool whose project-scoped layout uses different folder names entirely —
   *  e.g. GitHub Copilot's ~/.copilot/... globally vs .github/... inside a repo. */
  projectPaths?: Partial<Record<ItemType, string>>;
  /** Educated-guess global paths for a type this tool plausibly supports but whose on-disk
   *  location isn't confirmed by documentation — e.g. inferred by symmetry with a sibling type
   *  that IS confirmed for the same tool. Never scanned; shown only as placeholder text in
   *  Settings so a guess is visible without silently taking effect until someone verifies it and
   *  types it into `paths` themselves. */
  unconfirmedPaths?: Partial<Record<ItemType, string>>;
  /** Path to this tool's installed-plugins registry JSON, if it has one (e.g. Claude Code). */
  pluginsRegistry?: string;
  /** Path to the JSON file holding this tool's own per-plugin enable/disable state (e.g. Claude
   *  Code's ~/.claude/settings.json, under its "enabledPlugins" map), if it has one. Only a whole
   *  plugin can be toggled this way — there's no supported concept of disabling one skill inside
   *  a plugin, which is why an item with a pluginId can't be toggled individually (see
   *  itemToggle.ts's toggleItemEnabled) and is instead toggled as a unit from the sidebar's
   *  Plugins section (see itemToggle.ts's togglePluginEnabled). */
  pluginsSettingsPath?: string;
  /** Subfolder name(s), if any, where this tool stores its own shipped-in-the-box
   *  skills/agents/commands/rules — e.g. Claude Code's "synced/" cache, Codex's ".system/". An
   *  item found nested under one of these (at any depth within the tool's scanned path) is
   *  "Built-in" rather than "Local" (see scanners.ts's isBuiltInItem). Best-effort and observed
   *  empirically, not documented by the vendor — unlike `paths`, there's no confirmation
   *  mechanism for this, so it can silently stop matching if a tool renames its own convention. */
  builtInDirnames?: string[];
  /** Skips this tool during scan/rescan and hides its items from the library grid entirely —
   *  set from the "All tools" page (LibraryView.renderToolsPageContent), not Settings. Its
   *  shadow-note metadata (tags/favourites/collections) is deliberately preserved while
   *  disabled — see rescan.ts's performRescan, which still scans a disabled tool so its store
   *  entries survive a disable/re-enable round trip; only the returned item list is filtered. */
  disabled?: boolean;
  /** True for a tool the user added themselves via "Add tool" (the "All tools" page), as
   *  opposed to one of the built-in DEFAULT_TOOLS — controls whether it can be deleted outright
   *  (a custom tool can; a built-in one can only have its paths cleared) and counts toward the
   *  page's "Custom" stat. Also what main.ts's settings-load merge checks to know a saved tool
   *  entry isn't one of DEFAULT_TOOLS and should be kept rather than dropped. */
  custom?: boolean;
  /** True when this tool's "rule" path is a single instructions file (e.g. Claude Code's
   *  CLAUDE.md, one file loaded into every session) rather than a directory of many separate
   *  rule files (e.g. Cursor's ~/.cursor/rules). Changes how scanners.ts reads `paths.rule` —
   *  the whole file becomes one item instead of being read as a directory — and lets the
   *  library filter "instructions files" apart from per-rule directories within the Rules type. */
  singleFileRule?: boolean;
  /** Extra rule paths beyond paths.rule (and, for the project-scoped list,
   *  ruleAdditionalProjectPaths beyond projectPaths.rule) — for a tool that genuinely reads
   *  rules from more than one place at once, e.g. Cursor still honoring a legacy single
   *  ".cursorrules" file alongside its current ".cursor/rules/" directory. Shown as repeatable
   *  rows under the Rules field in the tool detail rail (LibraryView's renderRuleAdditionalPaths)
   *  instead of forcing everything through the one paths.rule slot. */
  ruleAdditionalPaths?: RulePathEntry[];
  ruleAdditionalProjectPaths?: RulePathEntry[];
  /** Path to this tool's global MCP server config JSON (a "mcpServers" map), if known — e.g.
   *  Claude Code's ~/.claude.json. Read-only: MCP servers are surfaced for visibility, never
   *  toggled from here. */
  mcpConfigPath?: string;
  /** Project-relative path to this tool's project-scoped MCP config JSON, e.g. Claude Code's
   *  .mcp.json at the project root. */
  projectMcpConfigPath?: string;
  /** The top-level JSON key holding the server map in mcpConfigPath/projectMcpConfigPath, for a
   *  tool that doesn't use Claude Code's "mcpServers" convention — e.g. VS Code's .vscode/mcp.json
   *  (confirmed on-disk) uses "servers" instead. Defaults to "mcpServers" when unset. Ignored for
   *  mcpConfigFormat "toml", where it names the table prefix instead (still "mcp_servers" by
   *  default there too). */
  mcpConfigKey?: string;
  /** File format of mcpConfigPath/projectMcpConfigPath — "json" (default) or "toml" for a tool
   *  like Codex CLI, whose ~/.codex/config.toml (confirmed on-disk) declares servers under
   *  [mcp_servers.NAME] tables rather than a JSON object. */
  mcpConfigFormat?: "json" | "toml";
}

/** One entry in ToolConfig.ruleAdditionalPaths / ruleAdditionalProjectPaths. */
export interface RulePathEntry {
  path: string;
  /** Same meaning as ToolConfig.singleFileRule, but per-entry since a tool can mix both shapes
   *  under one Rules field. Set once when the path is added (from whether it resolves to a file
   *  or a directory at that moment — see LibraryView's renderRuleAdditionalPaths) and from then
   *  on trusted as-is rather than re-detected from disk on every scan: a toggled-off single file
   *  doesn't exist at its own path any more (see itemToggle.ts's DISABLED_DIRNAME move), so live
   *  detection can't tell "temporarily disabled file" apart from "directory not created yet." */
  singleFile: boolean;
}

/** A folder on disk (a coding project, or the current vault) that may have its own
 *  project-local tool directories, e.g. <path>/.claude/skills alongside the global ones. */
export interface ProjectWorkspace {
  id: string;
  name: string;
  path: string;
}

/** An installed tool plugin (e.g. a Claude Code plugin) — auto-discovered from that tool's
 *  plugin registry, not user-registered like a ProjectWorkspace. Bundles its own skills/
 *  commands/agents together, so it's a source dimension, not an item type. */
export interface PluginSource {
  id: string;
  name: string;
  path: string;
  /** The ToolConfig this plugin was discovered under — needed to find its pluginsSettingsPath
   *  when toggling the whole plugin on/off. */
  toolId: string;
  /** Whether the tool currently loads this plugin at all, read from pluginsSettingsPath. True
   *  when that file (or its entry for this plugin) doesn't exist, matching how Claude Code treats
   *  an installed-but-unlisted plugin as enabled by default. */
  enabled: boolean;
  /** The plugin's source repo, read from its own .claude-plugin/plugin.json "repository" field —
   *  absent for most plugins in practice (only observed set on one of several installed here), so
   *  always optional. Lets a card belonging to this plugin offer "install a standalone copy" as
   *  an escape hatch from the whole-plugin-only toggle (see LibraryView's explainPluginToggle). */
  repoUrl?: string;
}

export interface DiscoveredItem {
  /** Stable identity derived from (tool, type, project, entry name) — NOT the current file path,
   *  since enabling/disabling an item physically moves it. This is what shadow notes are keyed by. */
  entryId: string;
  sourcePath: string;
  /** Symlink targets resolved — lets a project-local symlinked item be matched back to its global source. */
  realPath: string;
  tool: string;
  type: ItemType;
  /** null = found under a tool's global (home-directory) path; otherwise the ProjectWorkspace id. */
  projectId: string | null;
  /** null = not from an installed plugin; otherwise the PluginSource id. */
  pluginId: string | null;
  name: string;
  description: string;
  /** Whether the tool can currently see this item — derived from which folder it's physically in. */
  enabled: boolean;
}

export interface ItemMetadata {
  entryId: string;
  sourcePath: string;
  realPath: string;
  tool: string;
  type: ItemType;
  projectId: string | null;
  pluginId: string | null;
  name: string;
  description: string;
  enabled: boolean;
  tags: string[];
  favorite: boolean;
  collections: string[];
  /** Set once, at install time (see InstallFromGitHubModal), and updated after a successful
   *  update/restore (see LibraryView's startReview/applyReview) — never user-edited directly.
   *  Absent entirely for an item that was just found on disk rather than installed through
   *  Skillmanager. */
  sourceRepo?: string;
  /** Empty string means "track the repo's default branch via HEAD" rather than a pinned branch —
   *  see git.ts's remoteHeadCommit. */
  sourceRef?: string;
  /** Path within the repo that was installed — empty means the repo root itself is the skill. */
  sourceSubpath?: string;
  sourceCommit?: string;
}

/** One server's config, as read straight from a "mcpServers" JSON map — either a local process
 *  (command/args/env) or a remote endpoint (url/type). Shown as-is; never parsed further. */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: "http" | "sse";
}

/** An MCP server found in a tool's config file — a read-only visibility feature, deliberately
 *  not an ItemType/DiscoveredItem: it isn't scanned from a SKILL.md-style file, has no
 *  enable/disable action (toggling it from outside its owning tool would be too destructive to
 *  safely support), and carries no user-editable metadata, so it's never persisted to the
 *  shadow-note store — just recomputed fresh on every rescan. */
export interface McpServerEntry {
  /** Deterministic, not stored: `${tool}:global:${sourcePath}:${name}` or
   *  `${tool}:project:${projectId}:${sourcePath}:${name}`. */
  entryId: string;
  tool: string;
  name: string;
  scope: "global" | { projectId: string; projectName: string };
  config: McpServerConfig;
  /** The config file this entry was read from — shown for context, not clickable/editable. */
  sourcePath: string;
}

export interface Collection {
  id: string;
  name: string;
  itemIds: string[];
}

/** A skill, agent, command, or rule found while browsing a GitHub repo (see discover.ts / the
 *  "Discover" sidebar destination) but not yet installed into any tool folder — deliberately NOT
 *  an ItemMetadata: it has no entryId/sourcePath/tool, is never touched by rescan, and carries
 *  its own cached preview content instead of pointing at a real file on disk. Only becomes a real
 *  item once its card's install button is used, which hands its repoUrl/ref/subpath/type to
 *  InstallFromGitHubModal. */
export interface DiscoverEntry {
  /** Stable id derived from repoUrl + subpath + name — used to dedupe re-discovering the same
   *  item and to find/replace it in place on refresh. */
  id: string;
  /** Normalized "https://github.com/owner/repo.git", same form InstallFromGitHubModal stores. */
  repoUrl: string;
  /** Empty string means "track the repo's default branch," same convention as ItemMetadata.sourceRef. */
  ref: string;
  /** This item's own file or folder within the repo — a skill's own folder (containing its
   *  SKILL.md) for type "skill", or the .md file itself for agent/command/rule. */
  subpath: string;
  /** "skill" is only ever set from finding a SKILL.md — unambiguous. Agent/command/rule are
   *  inferred from the enclosing folder's name (agents/commands/rules), the same convention
   *  scanAllPlugins already trusts for a Claude Code plugin bundle's own skills/agents/commands
   *  folders — best-effort for an arbitrary repo, unlike the real scanner's configured paths. */
  type: ItemType;
  /** Commit the manifest text below was captured at — refreshed by the card's "Refresh" action. */
  commit: string;
  name: string;
  description: string;
  tags: string[];
  /** Raw cached SKILL.md content — this one file only. Companion files (references/, scripts/,
   *  …) are deliberately not fetched or cached; they're pulled fresh, once, at actual install
   *  time via the normal clone-and-copy path, same as any other GitHub install. */
  manifestText: string;
  starCount: number | null;
  starsFetchedAt: number | null;
  discoveredAt: number;
}

/** A repo the user has explicitly pointed Discover at — tracked separately from the
 *  DiscoverEntry items it produced, so "Refresh all" still knows to re-search it even after
 *  every item it originally found has been installed (which removes those items from
 *  discoverCatalog) or removed. Without this, a fully-installed source would silently vanish
 *  from "Refresh all" the moment its last catalog entry disappeared. */
export interface DiscoverSource {
  id: string;
  repoUrl: string;
  ref: string;
  /** The folder originally searched — "" means the whole repo. Refresh re-searches from here,
   *  not from the repo root, so a deliberately narrowed source stays narrow on every refresh. */
  subpath: string;
  addedAt: number;
}

export interface SkillManagerPluginSettings {
  storageFolder: string;
  tools: ToolConfig[];
  collections: Collection[];
  /** Skills found via the "Discover" sidebar destination but not yet installed — see
   *  DiscoverEntry. Grows only through explicit user action (adding a source, or a card's
   *  Refresh), never touched by rescan. */
  discoverCatalog: DiscoverEntry[];
  /** Repos explicitly added to Discover — see DiscoverSource. */
  discoverSources: DiscoverSource[];
  /** User-registered project folders, in addition to the current vault (which is always included). */
  projectWorkspaces: ProjectWorkspace[];
  /** Sidebar section keys in display order, everything after the fixed "Library" section. */
  sectionOrder: string[];
  /** When false (default), the sidebar's "Tools" and "Workspaces" lists only
   *  show rows with at least one discovered item — most vaults only use a handful of the
   *  configured tools, and listing every one of them regardless just pads the sidebar with rows
   *  that always read "0". */
  showEmptySidebarRows: boolean;
  /** Minutes between automatic background rescans; 0 disables it and leaves rescanning to the
   *  manual triggers (opening the library, the sidebar/settings "Scan tools" buttons). */
  autoRescanMinutes: number;
  /** Minutes between automatic background checks of every tracked sourceRepo item against its
   *  remote; 0 disables it and leaves checking to the manual "Check for updates" button. Only
   *  checks and flags stale items — it never applies updates on its own. */
  autoUpdateCheckMinutes: number;
  /** Sort order and enabled/disabled filter the library view opens with — otherwise every
   *  session starts back at name-asc/all even if you always switch to the same one. */
  defaultSortOrder: SortOrder;
  defaultEnabledFilter: EnabledFilter;
  /** entryId -> the timestamp it was disabled from the Dashboard's "Prune candidates" list.
   *  Keeps a "Restore" option available there for a day afterward; older entries are dropped
   *  (not the item itself — it stays disabled, this just stops reminding about it). */
  dashboardRecentlyDisabled: Record<string, number>;
  /** entryId (for a prune candidate) or a sorted "entryIdA::entryIdB" pair key (for an overlap) ->
   *  the timestamp it was dismissed as "not relevant" from the Dashboard. Unlike
   *  dashboardRecentlyDisabled, this never expires and never touches the item's enabled state —
   *  it only stops that specific recommendation from resurfacing. */
  dashboardDisregarded: Record<string, number>;
  /** True once the MCP servers page's "only scanning this vault" callout has been dismissed (or
   *  a workspace has been added — see LibraryView.renderWorkspaceScopeHint) — permanent, not
   *  per-session, so it doesn't reappear on every reload once acknowledged. The page falls back
   *  to the quieter header chip once this is true. */
  workspaceHintDismissed: boolean;
  /** App name to open an MCP server's config file with (see LibraryView.openMcpConfigFile),
   *  passed to macOS's `open -a`. Empty means fall back to the OS's own default-app association
   *  for that file, which for an extension like .json or .toml can land on an unexpected app
   *  (e.g. Xcode, if it's claimed that association) — set this to override it. macOS only. */
  mcpConfigEditorApp: string;
}

/** Canonical set of reorderable sidebar sections and their default order. "Library" isn't
 *  included — it's fixed at the top and never reorderable. */
export const DEFAULT_SECTION_ORDER = ["types", "plugins", "tools", "projects", "collections"];

export const DEFAULT_TOOLS: ToolConfig[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    icon: "asterisk",
    svgIcon:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd"><path clip-rule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"/></svg>',
    paths: {
      skill: "~/.claude/skills",
      command: "~/.claude/commands",
      agent: "~/.claude/agents",
      rule: "~/.claude/CLAUDE.md",
    },
    // Project-scoped CLAUDE.md lives at the project root, not under a mirrored .claude/ folder —
    // the auto-derived default (stripping "~/" from the global path) would land on
    // ".claude/CLAUDE.md", which is wrong, so this needs an explicit override.
    projectPaths: {
      rule: "CLAUDE.md",
    },
    singleFileRule: true,
    pluginsRegistry: "~/.claude/plugins/installed_plugins.json",
    pluginsSettingsPath: "~/.claude/settings.json",
    // ~/.claude/skills/synced/<workspace>_<user>/ is a vendor-managed cache of Claude Code's own
    // default skill catalog (confirmed on-disk: a manifest.json + .bucket-<id> marker sit
    // alongside the skill folders) — not something the user installed or wrote.
    builtInDirnames: ["synced"],
    // User-level MCP servers live under a top-level "mcpServers" key in ~/.claude.json;
    // project-level ones in a .mcp.json at the project root, same key shape.
    mcpConfigPath: "~/.claude.json",
    projectMcpConfigPath: ".mcp.json",
  },
  {
    id: "cursor",
    name: "Cursor",
    icon: "mouse-pointer-2",
    svgIcon:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 466.73 532.09" fill="currentColor"><path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z"/></svg>',
    paths: {
      skill: "~/.cursor/skills",
      agent: "~/.cursor/agents",
      rule: "~/.cursor/rules",
    },
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    icon: "terminal",
    // The source mark is a full-color gradient badge — flattened to a monochrome currentColor
    // glyph (just the ">_" prompt shape) to match every other tool's forced-monochrome
    // treatment here (see the svgIcon field comment above): no per-tool brand color.
    svgIcon:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="m76.93 62.08 102.2 49.64v38.76l-102.4 49.43v-28.46l82.28-40.62-82.06-39.3v-29.45z"/></svg>',
    // Only "command" is confirmed (Gemini CLI's custom TOML slash commands live in
    // ~/.gemini/commands) — double-check/adjust in Settings if it has grown a skills/agents
    // convention since.
    paths: {
      command: "~/.gemini/commands",
    },
    // Antigravity's docs describe ~/.gemini/config/skills as shared across Antigravity, the
    // Gemini CLI, and the IDE — plausible for the CLI too, but not confirmed from the CLI's own
    // docs, so surfaced as a placeholder rather than a live default.
    unconfirmedPaths: {
      skill: "~/.gemini/config/skills",
    },
  },
  {
    id: "antigravity",
    name: "Antigravity",
    icon: "orbit",
    // Derived from Google's brand mark: just the monochrome silhouette path it uses as a mask
    // for the full-color gradient blobs, forced to currentColor like every other tool here.
    svgIcon:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 15" fill="currentColor"><path d="M14.0777 13.984C14.945 14.6345 16.2458 14.2008 15.0533 13.0084C11.476 9.53949 12.2349 0 7.79033 0C3.34579 0 4.10461 9.53949 0.527295 13.0084C-0.773543 14.3092 0.635692 14.6345 1.50293 13.984C4.86344 11.7076 4.64663 7.69664 7.79033 7.69664C10.934 7.69664 10.7172 11.7076 14.0777 13.984Z"/></svg>',
    // Only "skill" is confirmed at the global/machine-wide scope (~/.gemini/config/skills,
    // shared across Antigravity, the Gemini CLI, and the IDE). Rules live in a single
    // ~/.gemini/GEMINI.md file rather than a directory skillmanager can scan, and there's no
    // documented global directory for Workflows (Antigravity's slash-command equivalent) or
    // named custom Agents — only the project-scoped locations below. Double-check/adjust in
    // Settings if that's grown global directories since.
    paths: {
      skill: "~/.gemini/config/skills",
    },
    // Guessed by symmetry with the confirmed skills path above — Workflows/Agents may well live
    // at sibling folders under ~/.gemini/config/ but that's not documented anywhere found.
    unconfirmedPaths: {
      agent: "~/.gemini/config/agents",
      command: "~/.gemini/config/workflows",
    },
    // All project-scoped under .agents/ — a different folder entirely from the global skill
    // path above, not just it relocated. (Antigravity still falls back to the legacy singular
    // .agent/ for skills/rules/workflows if .agents/ isn't found; only the current .agents/
    // form is set here.)
    //
    // "skill" deliberately omitted: Antigravity's project-scoped skills convention IS the
    // shared cross-tool standard (<project>/.agents/skills), the exact same path the
    // "global" (Shared) tool below already derives per-project automatically (it has no
    // projectPaths override, so scanProject strips "~/" off its global ~/.agents/skills path).
    // Declaring it again here would scan that same directory twice and list every skill in it
    // under two different tool tags.
    projectPaths: {
      agent: ".agents/agents",
      command: ".agents/workflows",
      rule: ".agents/rules",
    },
  },
  {
    id: "codex",
    name: "Codex",
    icon: "code-2",
    svgIcon:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd"><path clip-rule="evenodd" d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"/></svg>',
    paths: {
      skill: "~/.codex/skills",
      command: "~/.codex/prompts",
      agent: "~/.codex/agents",
    },
    // ~/.codex/skills/.system/ is Codex's own bundled default skill set (e.g. review-agent) —
    // not something the user installed or wrote.
    builtInDirnames: [".system"],
    // Confirmed on-disk: ~/.codex/config.toml declares global MCP servers under
    // [mcp_servers.NAME] TOML tables, not a JSON "mcpServers" object like Claude Code.
    mcpConfigPath: "~/.codex/config.toml",
    mcpConfigFormat: "toml",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    icon: "waves",
    svgIcon:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" fill="none"><path fill="currentColor" d="M897.246 286.869H889.819C850.735 286.808 819.017 318.46 819.017 357.539V515.589C819.017 547.15 792.93 572.716 761.882 572.716C743.436 572.716 725.02 563.433 714.093 547.85L552.673 317.304C539.28 298.16 517.486 286.747 493.895 286.747C457.094 286.747 423.976 318.034 423.976 356.657V515.619C423.976 547.181 398.103 572.746 366.842 572.746C348.335 572.746 329.949 563.463 319.021 547.881L138.395 289.882C134.316 284.038 125.154 286.93 125.154 294.052V431.892C125.154 438.862 127.285 445.619 131.272 451.34L309.037 705.2C319.539 720.204 335.033 731.344 352.9 735.392C397.616 745.557 438.77 711.135 438.77 667.278V508.406C438.77 476.845 464.339 451.279 495.904 451.279H495.995C515.02 451.279 532.857 460.562 543.785 476.145L705.235 706.661C718.659 725.835 739.327 737.218 763.983 737.218C801.606 737.218 833.841 705.9 833.841 667.308V508.376C833.841 476.815 859.41 451.249 890.975 451.249H897.276C901.233 451.249 904.43 448.053 904.43 444.097V294.021C904.43 290.065 901.233 286.869 897.276 286.869H897.246Z"/></svg>',
    paths: {
      skill: "~/.codeium/windsurf/skills",
      rule: "~/.windsurf/rules",
    },
  },
  {
    id: "cline",
    name: "Cline",
    icon: "bot",
    svgIcon:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="m23.365 13.556-1.442-2.895V8.994c0-2.764-2.218-5.002-4.954-5.002h-2.464c.178-.367.276-.779.276-1.213A2.77 2.77 0 0 0 12.018 0a2.77 2.77 0 0 0-2.763 2.779c0 .434.098.846.276 1.213H7.067c-2.736 0-4.954 2.238-4.954 5.002v1.667L.64 13.549c-.149.29-.149.636 0 .927l1.472 2.855v1.667C2.113 21.762 4.33 24 7.067 24h9.902c2.736 0 4.954-2.238 4.954-5.002V17.33l1.44-2.865c.143-.286.143-.622.002-.91m-12.854 2.36a2.27 2.27 0 0 1-2.261 2.273 2.27 2.27 0 0 1-2.261-2.273v-4.042A2.27 2.27 0 0 1 8.249 9.6a2.267 2.267 0 0 1 2.262 2.274zm7.285 0a2.27 2.27 0 0 1-2.26 2.273 2.27 2.27 0 0 1-2.262-2.273v-4.042A2.267 2.267 0 0 1 15.535 9.6a2.267 2.267 0 0 1 2.261 2.274z"/></svg>',
    // Confirmed global rules path; no confirmed global directory for skills or workflows (Cline's
    // slash-command equivalent) — only the project-scoped ones below.
    paths: {
      rule: "~/Documents/Cline/Rules",
    },
    // Guessed by symmetry with the confirmed Rules path above (Documents/Cline/Rules) — not
    // documented anywhere found for skills or workflows specifically.
    unconfirmedPaths: {
      skill: "~/Documents/Cline/Skills",
      command: "~/Documents/Cline/Workflows",
    },
    // The VS Code extension and the newer CLI/SDK disagree on the project-scoped layout: the
    // extension only reads .clinerules/ + .clinerules/workflows/, while the SDK/CLI is moving to
    // .cline/rules/ + .cline/workflows/ (and silently ignores the other's rules). Skills land at
    // .cline/skills/ either way. Picked the legacy .clinerules/ form since it's what the
    // currently-dominant VS Code extension reads — swap to .cline/rules if you're on the CLI/SDK.
    projectPaths: {
      skill: ".cline/skills",
      rule: ".clinerules",
      command: ".clinerules/workflows",
    },
  },
  {
    id: "roo-code",
    name: "Roo Code",
    icon: "git-branch",
    svgIcon:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd"><path d="M20.113 5.5l-.442 1.557a.157.157 0 01-.196.106l-7.414-2.157a.16.16 0 00-.143.028l-7.342 5.74a.159.159 0 01-.074.032l-4.37.656a.154.154 0 00-.132.162l.02.245c.005.078.071.14.152.141l5.074.128.058.002 3.75-1.953a.16.16 0 01.164.01l2.657 1.847a.152.152 0 01.066.125l-.023 2.45c0 .032.01.063.028.089l3.737 5.227c.03.04.077.065.129.065h1.182a.153.153 0 00.14-.224l-2.664-4.919a.15.15 0 01.005-.152l1.389-2.169a.156.156 0 01.062-.055l4.965-2.456a.16.16 0 01.158.01l1.418.921a.16.16 0 00.087.026h1.289c.125 0 .2-.136.13-.237l-3.578-5.29c-.074-.109-.246-.082-.282.044z"/></svg>',
    // Rule-only: Roo's custom "modes" (its closest thing to agents) live in a single .roomodes
    // file project-side and a JSON file in VS Code's global storage, not a directory — no clean
    // skill/agent/command directory to map here.
    paths: {
      rule: "~/.roo/rules",
    },
  },
  {
    id: "continue",
    name: "Continue",
    icon: "play",
    // The source mark is the dark glyph on a light circular backdrop — dropped the backdrop
    // path and kept just the glyph, forced to currentColor like every other tool here.
    svgIcon:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" fill="currentColor"><path d="M206.97 92.7966L197.78 108.729L221.009 148.932C221.179 149.237 221.281 149.61 221.281 149.949C221.281 150.288 221.179 150.661 221.009 150.966L197.78 191.203L206.97 207.136L240 149.949L206.97 92.7627V92.7966ZM194.219 106.661L203.409 90.7288H185.029L175.839 106.661H194.253H194.219ZM175.805 110.797L197.271 147.915H215.651L194.219 110.797H175.805ZM194.219 189.169L215.651 152.017H197.271L175.805 189.169H194.219ZM175.805 193.305L184.995 209.169H203.375L194.185 193.305H175.771H175.805ZM113.509 213.102C113.136 213.102 112.797 213 112.492 212.83C112.186 212.661 111.915 212.39 111.745 212.085L88.4819 171.847H70.1017L103.132 229H169.158L159.968 213.102H113.543H113.509ZM163.529 211.034L172.719 226.932L181.909 211L172.719 195.068L163.529 211V211.034ZM169.158 193.034H126.294L117.104 208.966H159.968L169.158 193.034ZM122.699 191L101.233 153.847L92.0427 169.78L113.509 206.932L122.699 191ZM70.0678 167.712H88.448L97.6381 151.78H79.2918L70.0678 167.712ZM111.644 87.9491C111.813 87.6441 112.085 87.3729 112.39 87.2034C112.695 87.0339 113.068 86.9322 113.407 86.9322H159.9L169.09 71H103.03L70 128.186H88.3802L111.576 87.9831L111.644 87.9491ZM97.6381 148.22L88.448 132.288H70.0678L79.2579 148.22H97.6381ZM113.441 93.1017L92.0088 130.22L101.199 146.153L122.631 109.034L113.441 93.1017ZM159.934 91.0339H117.002L126.192 106.966H169.124L159.934 91.0339ZM172.719 104.898L181.875 89L172.719 73.0678L163.529 88.9661L172.719 104.898Z"/></svg>',
    // No global directory for either — Continue's global rules live inside ~/.continue/config.yaml
    // rather than a folder skillmanager can scan, so only the project-scoped paths are set.
    paths: {},
    projectPaths: {
      rule: ".continue/rules",
      command: ".continue/prompts",
    },
  },
  {
    id: "opencode",
    name: "OpenCode",
    icon: "terminal-square",
    svgIcon:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd"><path d="M16 6H8v12h8V6zm4 16H4V2h16v20z"/></svg>',
    // OpenCode also falls back to reading ~/.claude/skills and ~/.agents/skills for
    // cross-tool interop — deliberately not repeated here since those are already covered by
    // the "Claude Code" and "Shared" tools respectively; adding them again would double-list
    // the same files under a third tool tag.
    paths: {
      skill: "~/.config/opencode/skills",
      agent: "~/.config/opencode/agents",
      command: "~/.config/opencode/commands",
    },
    // Rules deliberately excluded: OpenCode's global instructions file is a single
    // ~/.config/opencode/AGENTS.md, not a directory skillmanager can scan.
    //
    // Project-scoped paths are a different folder entirely (.opencode/... vs
    // ~/.config/opencode/...), not just the global path relocated — needs an explicit override.
    projectPaths: {
      skill: ".opencode/skills",
      agent: ".opencode/agents",
      command: ".opencode/commands",
    },
  },
  {
    id: "trae",
    name: "Trae",
    icon: "diamond",
    svgIcon:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M24 20.541H3.428v-3.426H0V3.4h24V20.54zM3.428 17.115h17.144V6.827H3.428v10.288zm8.573-5.196l-2.425 2.424-2.424-2.424 2.424-2.424 2.425 2.424zm6.857-.001l-2.424 2.423-2.425-2.423 2.425-2.425 2.424 2.425z"/></svg>',
    // "rule" confirmed as a real directory (~/.trae/user_rules holds multiple files, unlike most
    // other tools' single global instructions file). "agent" isn't confirmed as a file-based
    // convention at all — Trae's custom-agent docs describe managing them through the IDE/a
    // template gallery, never a folder skillmanager could scan — so left out of both paths here,
    // with only a symmetry-based guess in unconfirmedPaths.
    paths: {
      skill: "~/.trae/skills",
      rule: "~/.trae/user_rules",
    },
    unconfirmedPaths: {
      agent: "~/.trae/agents",
    },
    // Only "rule" needs an override — project skills already land at .trae/skills, the same
    // relative path auto-derived from the global skill path above.
    projectPaths: {
      skill: ".trae/skills",
      rule: ".trae/rules",
    },
  },
  {
    id: "goose",
    name: "Goose",
    icon: "feather",
    svgIcon:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd"><path d="M21.595 23.61c1.167-.254 2.405-.944 2.405-.944l-2.167-1.784a12.124 12.124 0 01-2.695-3.131 12.127 12.127 0 00-3.97-4.049l-.794-.462a1.115 1.115 0 01-.488-.815.844.844 0 01.154-.575c.413-.582 2.548-3.115 2.94-3.44.503-.416 1.065-.762 1.586-1.159.074-.056.148-.112.221-.17.003-.002.007-.004.009-.007.167-.131.325-.272.45-.438.453-.524.563-.988.59-1.193-.061-.197-.244-.639-.753-1.148.319.02.705.272 1.056.569.235-.376.481-.773.727-1.171.165-.266-.08-.465-.086-.471h-.001V3.22c-.007-.007-.206-.25-.471-.086-.567.35-1.134.702-1.639 1.021 0 0-.597-.012-1.305.599a2.464 2.464 0 00-.438.45l-.007.009c-.058.072-.114.147-.17.221-.397.521-.743 1.083-1.16 1.587-.323.391-2.857 2.526-3.44 2.94a.842.842 0 01-.574.153 1.115 1.115 0 01-.815-.488l-.462-.794a12.123 12.123 0 00-4.049-3.97 12.133 12.133 0 01-3.13-2.695L1.332 0S.643 1.238.39 2.405c.352.428 1.27 1.49 2.34 2.302C1.58 4.167.73 3.75.06 3.4c-.103.765-.063 1.92.043 2.816.726.317 1.961.806 3.219 1.066-1.006.236-2.11.278-2.961.262.15.554.358 1.119.64 1.688.119.263.25.52.39.77.452.125 2.222.383 3.164.171l-2.51.897a27.776 27.776 0 002.544 2.726c2.031-1.092 2.494-1.241 4.018-2.238-2.467 2.008-3.108 2.828-3.8 3.67l-.483.678c-.25.351-.469.725-.65 1.117-.61 1.31-1.47 4.1-1.47 4.1-.154.486.202.842.674.674 0 0 2.79-.861 4.1-1.47.392-.182.766-.4 1.118-.65l.677-.483c.227-.187.453-.37.701-.586 0 0 1.705 2.02 3.458 3.349l.896-2.511c-.211.942.046 2.712.17 3.163.252.142.509.272.772.392.569.28 1.134.49 1.688.64-.016-.853.026-1.956.261-2.962.26 1.258.75 2.493 1.067 3.219.895.106 2.051.146 2.816.043a73.87 73.87 0 01-1.308-2.67c.811 1.07 1.874 1.988 2.302 2.34h-.001z"/></svg>',
    // Goose's own docs recommend the shared ~/.agents/skills convention as the primary/preferred
    // location (already covered by the "Shared" tool below) — this entry captures Goose's own
    // distinct fallback location instead, so the same skill doesn't get double-listed under two
    // tool tags. No rule/agent/command directory: project hints live in a single .goosehints
    // file, and Goose's extensibility model (MCP extensions, YAML recipes) has no user-authored
    // markdown agent/command files to scan.
    paths: {
      skill: "~/.config/goose/skills",
    },
    projectPaths: {
      skill: ".goose/skills",
    },
  },
  {
    id: "hermes",
    name: "Hermes",
    icon: "send",
    svgIcon:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd"><path d="M5.938 12.835c.127-.039.285.02.373.143.028.038.036.092.046.14.003.014-.02.033-.04.05-.124-.098-.24-.194-.354-.291-.011-.01-.016-.027-.025-.042zM8.396 9.412c.195-.032.39-.06.588-.05a.54.54 0 01.148.026c.202.071.402.147.601.224.028.01.05.036.075.055l-.013.027a9.203 9.203 0 01-.26-.089c-.115-.038-.213-.077-.315-.098-.25-.05-.25-.046-.292-.014l.574.144c.275.139.55.276.823.417.042.022.09.057.107.098.026.06.063.076.117.072.066-.006.132-.017.213-.027l-.04.086c.051.08.142.02.216.064-.074.13-.247.09-.334.199l.061.074-.12.087c0 .106-.038.168-.306.243l.026.085-.196.042.07.124h-.25l-.007.137c-.081-.01-.161-.018-.244-.027l-.053.123c-.027-.008-.052-.011-.073-.023-.067-.038-.128-.056-.195.006-.019.017-.063.014-.093.008-.026-.006-.05-.029-.07-.042-.11.095-.11.095-.208.003-.057.046-.12.074-.186.011-.063.027-.123-.02-.178-.014-.07.007-.097-.035-.133-.07l-.13.033c-.013-.236-.194-.19-.34-.203.005-.072.05-.092.095-.094a.474.474 0 01.159.022c.164.05.32.12.496.138.203.021.405.029.601-.015.265-.059.52-.149.707-.365.049-.056.083-.127.117-.195.019-.038.02-.084-.02-.116a1.397 1.397 0 00-.382-.217c.024.12-.031.182-.115.221 0 .014-.004.025 0 .03.08.115.084.16-.007.267a1.39 1.39 0 01-.218.211.477.477 0 01-.641-.05 1.36 1.36 0 01-.133-.152c-.078-.107-.076-.108-.033-.236-.165-.08-.128-.226-.104-.364.008-.05.028-.096.049-.163-.04.014-.067.017-.087.032a.897.897 0 00-.316.357c-.007.016-.01.034-.02.047-.012.015-.034.038-.045.035-.02-.006-.037-.027-.05-.045-.008-.012-.007-.032-.012-.057h-.126l.053-.172a14.82 14.82 0 00-.039-.049l.11-.284c-.06.026-.091.044-.124.051-.03.007-.064 0-.095 0 0-.031-.01-.07.004-.092.149-.22.305-.428.593-.476z"/><path d="M8.06 10.788c-.003-.038-.004-.075.037-.062.016.006.034.048.028.067-.01.04-.038.032-.064-.005z"/><path clip-rule="evenodd" d="M11.981.009c.226-.012.453-.011.679 0 .247.01.495.024.74.062.401.064.798.157 1.19.273.463.138.92.299 1.356.511a7.31 7.31 0 012.948 2.642c.292.469.536.963.739 1.479.219.556.446 1.11.623 1.683.204.654.329 1.326.458 1.997.097.504.182 1.01.29 1.511.156.722.329 1.44.494 2.16.186.812.4 1.615.63 2.415.102.355.193.713.282 1.072.11.436.202.876.254 1.323.031.278.066.557.073.837a7.56 7.56 0 01-.017.88c-.037.413-.1.818-.226 1.212a5.017 5.017 0 01-.915 1.649l-.13.156.018.023c.043-.023.088-.041.127-.068.2-.138.373-.307.531-.49.4-.46.721-.973.975-1.529a3.59 3.59 0 00.325-1.72c-.024-.424-.097-.834-.3-1.213-.013-.027-.015-.06-.03-.121.05.035.082.048.101.072.107.13.22.258.315.398.33.494.46 1.052.486 1.64a3.75 3.75 0 01-.47 1.97c-.36.655-.887 1.14-1.526 1.506-.193.111-.394.21-.595.308-.157.078-.248.211-.318.365a.522.522 0 00-.033.406.359.359 0 01.013.139c-.005.077-.077.155-.14.162-.054.006-.125-.043-.15-.116a1.206 1.206 0 01-.06-.233c-.04-.314-.155-.6-.308-.87a3.906 3.906 0 00-.73-.91 2.129 2.129 0 00-.897-.524 4.093 4.093 0 00-.692-.131c-.075-.008-.15-.04-.22.01.18.06.363.11.538.18.434.173.82.43 1.18.728.308.255.58.543.794.884.098.155.186.315.227.496.027.123.042.25.067.375.013.062-.002.109-.053.144-.047.033-.122.034-.163-.01a.455.455 0 01-.08-.14c-.03-.073-.038-.159-.078-.225a7.314 7.314 0 00-1.423-1.664c-.16-.137-.329-.26-.537-.323-.376-.114-.753-.203-1.15-.154-.213.025-.427.032-.64.053a1.6 1.6 0 00-.736.278 5.14 5.14 0 00-.834.72c-.329.342-.642.699-.955 1.055-.136.155-.264.319-.314.531a5.227 5.227 0 00-.012.051.096.096 0 01-.09.076h-.31c-.046 0-.082-.048-.072-.094.023-.108.045-.216.07-.324.075-.325.19-.635.368-.917.024-.039.04-.088.104-.08l.01.049.027.077c.28-.435.571-.834.996-1.135.283-.204.584-.378.89-.55a.196.196 0 00-.098-.002c-.162.043-.325.084-.485.134-.402.124-.764.33-1.11.566-.147.1-.298.193-.414.333a7.314 7.314 0 00-1.07 1.767.845.845 0 00-.04.12.075.075 0 01-.072.056h-.494c-.04 0-.062-.051-.036-.082.123-.14.246-.282.377-.415.275-.281.58-.532.777-.884.027-.048.063-.09.095-.135.238-.333.54-.607.818-.902.082-.086.175-.16.26-.24.029-.027.053-.057.079-.085l-.018-.025-.135.041c-.034.017-.07.031-.102.05-.248.144-.494.292-.743.433-.408.23-.825.439-1.209.711-.281.2-.591.358-.889.533-.02.012-.044.015-.08.028-.015-.135.143-.201.108-.336-.033.014-.064.02-.085.038-.111.096-.227.19-.328.296-.148.157-.284.325-.425.488-.125.143-.25.286-.373.431A.153.153 0 019.89 24H8.762a.316.316 0 00.016-.042c.028-.09.085-.172.083-.28-.091-.018-.162.001-.212.077a4.45 4.45 0 00-.136.215c-.01.016-.024.03-.042.03h-.093c-.019 0-.029-.022-.017-.037.071-.088.14-.178.209-.268.001-.002-.006-.012-.012-.024-.014.004-.03.006-.045.013-.176.09-.352.181-.527.274a.363.363 0 01-.168.042H5.202c-.026 0-.039-.036-.019-.053.21-.178.402-.374.558-.605.335-.496.538-1.047.667-1.629.004-.02-.003-.043-.006-.091-.037.048-.059.072-.076.1a1.943 1.943 0 01-.334.415c-.28.258-.59.448-.983.464-.297.012-.588 0-.865-.127-.46-.21-.722-.57-.794-1.072-.025-.17-.017-.171-.182-.219A3.513 3.513 0 011.97 20.6a2.286 2.286 0 01-.808-1.13 3.569 3.569 0 01-.16-1.245c.002-.034.016-.067.024-.1.032.023.046.043.05.066.033.153.059.308.096.46.086.355.257.664.516.92.258.256.571.419.91.532.358.118.717.138 1.07-.016a1.89 1.89 0 00.621-.452c.328-.348.533-.76.648-1.223.009-.034.005-.071.007-.11-.015.006-.026.006-.03.011-.031.05-.064.1-.093.152-.284.502-.679.887-1.196 1.135-.351.17-.718.255-1.11.159a1.607 1.607 0 01-.971-.64 2.006 2.006 0 01-.368-.924 2.903 2.903 0 01.02-.886c.05-.439.466-1.17.742-1.271-.02.063-.035.112-.053.16-.043.116-.097.227-.13.345a1.901 1.901 0 00-.05.82c.033.212.09.416.204.6.147.236.346.407.62.465.11.023.225.014.338.018a.576.576 0 00.386-.131c.164-.128.282-.292.366-.481.168-.375.24-.777.309-1.179.05-.296.093-.594.133-.893.039-.281.071-.563.104-.845.026-.232.048-.464.074-.696.024-.228.052-.455.076-.683.024-.227.047-.455.069-.683.013-.14.022-.28.034-.42l.037-.417c.022-.25.041-.5.065-.748.008-.082-.02-.132-.09-.177a2.46 2.46 0 01-.492-.418c-.1-.109-.188-.228-.282-.342-.035-.042-.056-.097-.116-.118a2.084 2.084 0 00.275.597c.06.092.131.176.196.265.063.086.182.115.234.226-.028.003-.046.01-.06.006a4.74 4.74 0 01-.22-.057 2.71 2.71 0 01-1.287-.819c-.435-.487-.656-1.076-.71-1.723a5.206 5.206 0 01.014-1.06c.072-.602.22-1.186.45-1.745.155-.376.338-.741.526-1.102.205-.393.466-.75.765-1.076.512-.559 1.104-1.024 1.726-1.448.717-.49 1.478-.898 2.277-1.233C8.244.828 8.767.632 9.31.494c.655-.166 1.31-.33 1.982-.415.229-.03.458-.058.688-.07zm-1.847 22.82c-.07.06-.147.111-.207.18-.238.27-.464.549-.668.869l-.044.108a.177.177 0 00.093-.057c.174-.19.351-.378.519-.574.104-.122.195-.255.288-.386.024-.034.03-.08.046-.12l-.027-.02zm1.65-3.695a5.51 5.51 0 00-.653.593l-.37.386a.963.963 0 01-.377.25 1.372 1.372 0 01-.467.09c-.044 0-.087.006-.151.012.028.058.043.097.064.131.15.242.301.482.45.724.136.22.276.438.399.666.068.125.105.267.156.404.077.027.14-.018.202-.048.29-.135.579-.274.867-.412.213-.101.437-.186.636-.31.347-.215.68-.455 1.018-.685.015-.01.026-.028.042-.046-.023-.019-.038-.037-.056-.044-.287-.111-.527-.3-.77-.482a5.319 5.319 0 01-.506-.42 1.757 1.757 0 01-.41-.653c-.019-.049-.045-.095-.075-.156zm-5.847.264c-.06.096-.097.194-.132.293a3.38 3.38 0 01-.555 1.01c-.2.25-.455.412-.762.493-.23.06-.464.076-.7.07-.048-.002-.097.002-.158.005.016.04.021.066.035.085.1.145.23.246.4.295.157.046.316.034.498.023.181-.037.343-.115.485-.234.238-.199.402-.454.536-.732.175-.363.264-.751.342-1.144.01-.053.008-.11.011-.164zm14.945-4.586c.008.029.016.057.027.107.024.155.051.31.072.464.03.219.067.437.078.657.017.344.027.689-.014 1.033-.037.315-.063.633-.116.946a6.153 6.153 0 01-.46 1.518c-.008.018-.01.039-.02.082.047-.03.077-.042.098-.064.085-.083.17-.167.248-.255.271-.305.458-.66.596-1.043.18-.498.228-1.011.145-1.531-.103-.65-.33-1.263-.597-1.881a9.055 9.055 0 00-.024-.055l-.033.022zM5.797 8.29a.26.26 0 00.018.153c.124.251.25.501.379.75.025.049.066.09.03.163-.284.06-.578.119-.88.255.059.038.097.06.132.087.042.032.112.058.09.12-.01.033-.075.048-.117.072.017.01.043.021.067.036.166.102.33.207.447.368.138.192.229.404.188.644-.079.469-.306.85-.69 1.132-.054.04-.106.083-.161.122a.243.243 0 00-.103.245.77.77 0 00.055.195c.083.196.22.35.375.492.083.076.159.164.222.257a.37.37 0 01.025.377c-.023.05-.05.099-.076.148-.03.06-.028.111.022.162.041.042.08.089.112.138.038.058.078.079.147.05a.486.486 0 01.333-.006c.16.046.302.126.444.21.13.077.264.149.4.219.067.035.14.05.219.026.071-.022.124.01.145.076.02.064-.003.108-.074.139-.07.03-.137.063-.209.088-.1.035-.201.073-.314.077-.013-.107.11-.088.127-.159-.206-.126-.643-.145-.801-.034.063.112.035.21-.096.313-.13-.1-.025-.202.002-.3a.209.209 0 00-.249.17c-.015.101.067.216.178.224.108.007.218-.005.326-.012.06-.005.12-.027.199 0-.103.123-.248.127-.357.19.002.05.07.086.019.131-.053.048-.095-.001-.132-.03-.08-.063-.16-.126-.231-.197a.474.474 0 01-.157-.311.52.52 0 00-.043-.172c-.032-.074-.032-.137.033-.19-.018-.03-.028-.053-.045-.072a1.222 1.222 0 01-.196-.369c-.053-.137-.046-.264.048-.381.024-.03.05-.06.064-.095a.664.664 0 00.047-.168c.017-.165-.064-.287-.182-.387-.186-.156-.36-.322-.46-.551-.005-.011-.024-.017-.037-.026-.011.017-.024.027-.025.038-.019.185-.045.37-.052.557-.014.377.058.743.162 1.104.118.41.289.798.488 1.173.267.502.537 1.002.812 1.5.055.098.13.189.208.27.198.202.452.272.724.273.202 0 .404-.006.605-.026.295-.03.59-.073.884-.113.183-.025.365-.057.548-.08.21-.026.38.073.522.21.16.156.305.327.447.5.22.265.397.56.554.867.05.098.07.1.147.03.13-.121.26-.242.394-.36.067-.059.088-.12.067-.213a3.535 3.535 0 01-.085-.796c.002-.157.006-.314.018-.471.015-.224.03-.45.06-.672a59.114 59.114 0 01.362-2.298c.087-.493.182-.984.268-1.477.06-.347.118-.694.162-1.043.034-.273.055-.55.063-.825.011-.332.003-.665.002-.998 0-.077.004-.155-.01-.23-.028-.142-.01-.155-.162-.19a5.826 5.826 0 00-.607-.107c-.146-.018-.207-.053-.221-.19-.006-.049-.025-.098-.041-.146-.009-.025-.024-.048-.046-.09l-.025.264c-.009.096-.029.116-.127.115-.055 0-.11-.008-.164-.008-.476 0-.952-.008-1.426.032-.095.008-.173-.015-.226-.103-.04-.066-.088-.126-.134-.186-.063-.084-.086-.093-.182-.06-.195.068-.388.138-.582.21a2.71 2.71 0 00-.675.394.986.986 0 01-.323.168c-.033.01-.07.008-.127.013.02-.066.024-.114.047-.15.064-.105.135-.205.205-.306.023-.033.049-.063.073-.095l-.015-.023-.201.037c-.146.04-.296.07-.437.122-.148.053-.266.023-.386-.072a3.623 3.623 0 01-.733-.786l-.093-.132zm8.592 8.963l-.147.09c-.22.134-.44.266-.659.402-.093.058-.184.12-.27.188-.085.07-.124.161-.072.272.047.1.093.2.147.294.047.08.124.138.213.147.11.01.228.012.336-.012.217-.05.372-.205.528-.357a.291.291 0 00.087-.308c-.046-.18-.079-.365-.118-.547-.011-.052-.027-.103-.045-.169zm-.257-2.409c-.12.291-.205.597-.325.91-.151.433-.294.87-.435 1.323.036-.01.054-.01.067-.018.261-.16.522-.324.785-.484.054-.033.071-.078.065-.138-.012-.13-.024-.262-.034-.393l-.068-.886c-.008-.103-.02-.206-.029-.31-.009 0-.017-.002-.026-.004zm3.081-8.13l.099.285c.08.231.159.463.24.714l.58 1.952c.187.63.372 1.262.558 1.893.114.382.235.762.343 1.146.072.257.126.519.186.799.044.206.087.413.127.64.034.106.023.226.077.325l.025-.006-.068-.362c-.038-.206-.077-.412-.113-.638-.015-.07-.029-.141-.046-.211-.095-.396-.177-.796-.29-1.187-.196-.685-.413-1.364-.618-2.046-.165-.549-.322-1.1-.488-1.648-.069-.227-.15-.45-.226-.695l-.117-.336c-.037-.107-.075-.216-.115-.322-.04-.106-.084-.21-.127-.314a7.558 7.558 0 01-.027.01zM6.225 14.304c-.063-.001-.115.014-.134.083a.35.35 0 00.41.012 4.533 4.533 0 00-.276-.095zM5.23 11.98c-.026-.027-.057-.048-.075.002-.012.032-.007.07-.01.113.082-.037.082-.037.085-.115zm.062-1.189a.135.135 0 00-.088.056.197.197 0 00-.025.11c.005.152.01.306.026.457a.751.751 0 00.066.218c.061.136.157.167.288.101.055-.027.06-.054.025-.11a4.52 4.52 0 01-.129-.211c-.015-.068-.066-.131-.033-.207.04-.09-.076-.116-.074-.19V10.874c-.003-.038-.006-.087-.056-.083zm-.017-.968a.867.867 0 00-.467.127c-.076.045-.084.07-.05.158.034.087.07.173.115.254.064.117.09.125.21.077a.657.657 0 01.336-.053c.202.022.357.136.504.264l.092.077c.007-.006.014-.013.022-.018-.019-.105-.035-.226-.149-.264-.157-.053-.324-.075-.508-.117l-.24-.005c.24-.169.452-.044.687.009-.063-.115-.153-.147-.23-.193-.082-.05-.17-.092-.25-.144-.06-.037-.12-.08-.072-.172zm10.233.325c-.23-.01-.427.08-.608.211-.034.026-.06.065-.105.117.087.026.15.046.232.065.044-.015.088-.03.13-.046.306-.114.61-.115.904.031.126.063.237.04.366-.005-.02-.031-.03-.054-.045-.071a.986.986 0 00-.448-.273c-.14-.044-.284-.024-.426-.03zM7.99 6.483a.308.308 0 00.002.133c.08.321.156.643.242.962.104.387.27.75.456 1.103.02.037.061.08.098.087a.404.404 0 00.253-.051l-.472-.84c-.23-.448-.405-.92-.579-1.394zM10.397.497c-.2-.008-.405.004-.603.034-.236.035-.47.087-.7.152-.287.08-.569.18-.852.273-.04.013-.074.038-.11.058.028.014.05.018.07.014.287-.068.58-.085.873-.09.134-.002.269.009.402.025.19.024.382.048.57.09.456.104.874.3 1.265.556.464.306.888.66 1.257 1.078.205.232.395.475.56.739.17.274.315.561.449.856.273.601.456 1.232.6 1.876.04.173.07.348.1.524.017.104.065.167.17.19.122.028.2.105.22.251-.003.102-.06.174-.129.24a1.065 1.065 0 00-.268.358.164.164 0 00.083-.039c.08-.086.162-.172.235-.265a.56.56 0 00.13-.333c.009-.05.022-.1.024-.15.007-.124-.017-.15-.143-.168-.025-.004-.049-.014-.073-.015-.082-.007-.125-.063-.137-.131-.033-.198-.004-.355.247-.408.086-.018.174-.03.26-.042.158-.023.315-.053.473-.067.14-.012.19.033.226.167.008.029.018.057.021.087.019.179-.008.225-.141.288-.027.013-.055.024-.078.042a.148.148 0 00-.051.067c-.039.144.073.382.206.445l.673.32c.023.011.05.015.075.023l.018-.026c-.015-.008-.032-.013-.044-.024a2.27 2.27 0 00-.544-.32 4.898 4.898 0 00-.173-.075.203.203 0 01-.126-.191c-.003-.085.045-.154.128-.187l.059-.025c.099-.044.118-.076.112-.187a.384.384 0 00-.008-.063c-.067-.294-.123-.59-.205-.88a9.478 9.478 0 00-.826-2.036 7.465 7.465 0 00-1.39-1.805 4.536 4.536 0 00-1.177-.824 3.656 3.656 0 00-1.016-.328 6.155 6.155 0 00-.712-.074zm6.719 5.955c.01.014.018.028.038.034l-.022-.044-.016.01zM4.103 3.917a.062.062 0 01-.03.012.455.455 0 01-.04.039c-.01.01-.02.02-.045.04l-.363.354c-.088.085-.17.178-.266.253-.284.22-.425.53-.544.855a.132.132 0 00-.007.071c.013.055.033.108.052.168l.074.026c-.017.056-.03.105-.047.152-.058.164-.118.327-.175.491-.005.015.008.036.019.077.08-.175.158-.33.225-.489.228-.544.484-1.074.819-1.561.09-.133.182-.266.283-.401.004-.006.007-.013.022-.03.001-.016.003-.032.015-.04l.008-.017zm12.976 2.408a.023.023 0 01.009.019.073.073 0 00-.006.01.188.188 0 00.007.02l.018.022c.002-.007.007-.016.005-.021-.003-.01-.012-.018-.02-.038a1.331 1.331 0 01-.013-.012zM4.199 4.48c-.003.004-.008.008-.027.014-.005.013-.011.025-.031.047a2.085 2.085 0 01-.124.167c-.048.07-.116.055-.181.041-.134-.028-.228.016-.287.143-.089.187-.187.37-.273.56-.049.108-.11.216-.118.36.081.003.154.007.228.008h.228a2.563 2.563 0 01-.079.264c-.01.052-.022.103-.033.155l.02.004c.018-.046.037-.092.067-.153.066-.142.13-.285.2-.426.02-.04.034-.1.116-.092 0 .043.004.084 0 .124-.005.045-.017.09-.028.143.141.043.086.174.115.269.102-.022.104-.195.248-.144v.205l.017.002.439-1.059c-.13 0-.246-.02-.358.033-.024.011-.058-.001-.108-.004.075-.15.139-.278.211-.417a.128.128 0 01.025-.036c0-.015-.001-.03.008-.038l.006-.02c-.005.006-.01.011-.028.017-.004.012-.009.024-.026.045a.085.085 0 01-.032.033c-.123.157-.09.164-.258.106-.079-.027-.078-.028-.047-.144.028-.046.056-.093.098-.15 0-.016-.001-.032.007-.042L4.2 4.48zm2.073-.67c-.003.006-.007.011-.027.016-.094.125-.194.246-.28.377-.155.238-.301.481-.451.723-.14.224-.345.368-.575.481-.017.008-.04.006-.079.011.012-.059.016-.109.033-.153a6.076 6.076 0 01.229-.518l-.007-.02a.138.138 0 01-.035.025c-.028.05-.055.1-.093.164-.26.424-.443.817-.442.95.024.004.048.011.073.013.177.013.188.007.26-.165.03-.07.077-.12.147-.15l.175-.07c.044-.018.085-.057.146-.032.003.05-.01.11.014.145.042.062.044.125.047.193.002.049.017.098.026.147.029-.034.039-.065.05-.097.142-.39.277-.782.428-1.17.1-.256.22-.504.33-.756.013-.03.013-.067.03-.092V3.81zm3.987-.34c0 .045.01.084.021.123.042.16.094.318.124.48.024.133.023.27.028.406 0 .033-.019.067-.032.11-.094-.058-.047-.158-.106-.215h-.125c-.015.072-.01.152-.046.2-.066.085-.155.154-.236.227-.043.038-.078.018-.103-.025l-.046-.087c-.065.035-.117.069-.172.093-.116.051-.235.095-.35.147-.085.038-.09.053-.07.147.014.075.034.148.047.223.013.072.05.109.123.124.233.05.462.115.657.265.058-.102.058-.102.168-.151.03-.014.06-.03.092-.042.08-.03.115-.017.15.06.023.048.041.098.066.158.06-.14-.042-.267.017-.416.157.18.24.39.375.567a.235.235 0 00.022-.098c.002-.124 0-.247.002-.371 0-.034.013-.067.02-.1l.032-.003c.11.155.13.354.226.52a3.036 3.036 0 00-.01-.392c-.004-.045 0-.074.05-.088.08.036.116.14.215.158-.03-.275-.423-1.137-.798-1.635-.114-.127-.2-.28-.34-.386zm-2.667.696c-.019.034-.03.05-.037.067-.061.185-.125.37-.18.556-.031.105-.087.169-.195.19-.09.019-.178.052-.268.073-.038.009-.089.015-.118-.003-.024-.016-.025-.069-.036-.106-.064.076-.082.087-.17.047-.133-.062-.262-.135-.393-.201-.048-.025-.093-.063-.17-.03-.043.12-.091.25-.137.382-.099.28-.087.242.095.453.046.048.102.03.154.023.054-.009.106-.03.16-.036.13-.013.26-.08.367-.015.204-.064.387-.122.571-.178.05-.015.089.005.114.054.022.042.034.093.082.121.038-.056-.013-.128.063-.178l.14.241-.042-1.46zm.278.358c-.096-.01-.107.01-.11.108-.002.038-.003.078.002.115.03.2.099.386.174.57.002.006.012.01.022.015l.078-.05c.052.036.081.088.153.088.205-.002.41.014.616.012.099-.001.158.042.205.12.018.03.024.077.088.066l-.08-.394c-.05-.195-.085-.395-.172-.589-.057.057-.114.068-.18.046a.72.72 0 00-.135-.028c-.22-.028-.44-.059-.66-.08zm10.254-1.727c.089.163.155.316.139.491-.016.168.026.342-.044.516-.047-.033-.088-.082-.112-.075-.117.035-.164-.057-.227-.115a4.772 4.772 0 01-.286-.29l-.104-.113a4.856 4.856 0 01-.023.019c.035.046.07.093.11.156.04.064.084.127.122.193.034.058.065.118.031.205-.082-.01-.164-.019-.246-.032-.06-.01-.101 0-.124.07-.031.098-.037.096-.15.09.02.042.036.08.057.116.041.074.03.138-.03.196-.06.06-.118.122-.178.181a.175.175 0 01-.185.046c-.222-.061-.447-.113-.67-.174-.032-.009-.063-.04-.086-.068-.03-.04-.052-.087-.08-.13-.044-.07-.09-.138-.136-.207a.18.18 0 00-.014.105c.012.127.03.253.035.38.005.1-.024.12-.121.104-.104-.017-.206-.04-.31-.058-.064-.012-.131-.028-.202.03l.081.208c.09 0 .166-.01.237.002a.819.819 0 01.458.251c.078.083.154.168.241.26l.018-.005c-.004-.006-.008-.013-.01-.04.014-.056-.062-.118.018-.178.031.03.064.057.088.09.058.078.111.159.169.257l.089.141.024-.013a2093.819 2093.819 0 01-.427-.934c.055.007.083.007.108.016.193.07.385.142.577.216.074.028.147.06.219.094.062.028.112.018.157-.033.05-.056.102-.112.154-.167.05-.051.095-.046.132.014.016.025.026.053.04.08.071.138.143.277.217.433l.159.308.025-.011c-.044-.106-.07-.218-.138-.334-.057-.182-.168-.346-.206-.545.136.034.362.326.567.732l.057.074.018-.011a1.563 1.563 0 01-.052-.127c-.046-.145-.097-.29-.136-.436-.022-.083-.036-.173.022-.26l.109.058-.026-.207.027-.016c.022.02.05.036.065.06.073.108.143.22.215.33.01.016.029.029.043.043-.036-.217-.2-.38-.229-.626l.155.112c.014-.166.012-.319.042-.465.032-.158-.023-.297-.063-.445.024.004.036.006.055.025.092.124.183.249.277.371.02.027.05.047.069.087l.04.063.019-.015a.293.293 0 01-.053-.082 27.922 27.922 0 01-.332-.49c-.221-.311-.363-.467-.485-.521zm-6.57.327c-.003.161.092.275.069.415l-.368.087c.09.139.032.237-.052.331-.05.057-.092.122-.143.178-.037.04-.046.078-.018.126l.16.275c.029.048.072.066.128.064.076-.003.152 0 .228-.001.116-.003.216.022.275.137.006.014.02.024.044.052.004-.059-.003-.098.01-.13.016-.04.04-.099.072-.108.084-.023.173-.024.26-.03.013-.001.027.018.04.029l.071.065c.019-.11-.082-.198-.024-.31l.126.04c-.026-.123-.07-.245-.071-.366 0-.123.051-.243.115-.36.107.062.16.156.234.253.183.265.36.533.494.834.165-.078.27.068.407.088-.003-.106-.133-.441-.197-.492a.142.142 0 00-.102-.028c-.06.011-.119.039-.191.063-.025-.039-.056-.078-.077-.122a3.936 3.936 0 00-.473-.783c-.076-.094-.16-.182-.228-.26l-.391.285c-.049.035-.094.03-.132-.017l-.169-.207c-.025-.03-.053-.059-.097-.108z" fill-rule="evenodd"/></svg>',
    // "skill" is the only confirmed directory-based convention — the rest are symmetry guesses
    // off it, not documented anywhere found; Hermes also reads the shared .agents/skills at the
    // project level for interop, deliberately not repeated here (already covered by "Shared").
    paths: {
      skill: "~/.hermes/skills",
    },
    unconfirmedPaths: {
      agent: "~/.hermes/agents",
      command: "~/.hermes/commands",
      rule: "~/.hermes/rules",
    },
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    icon: "github",
    svgIcon:
      '<svg xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid" viewBox="0 0 256 208"><path fill="currentColor" d="M205.3 31.4c14 14.8 20 35.2 22.5 63.6 6.6 0 12.8 1.5 17 7.2l7.8 10.6c2.2 3 3.4 6.6 3.4 10.4v28.7a12 12 0 0 1-4.8 9.5C215.9 187.2 172.3 208 128 208c-49 0-98.2-28.3-123.2-46.6a12 12 0 0 1-4.8-9.5v-28.7c0-3.8 1.2-7.4 3.4-10.5l7.8-10.5c4.2-5.7 10.4-7.2 17-7.2 2.5-28.4 8.4-48.8 22.5-63.6C77.3 3.2 112.6 0 127.6 0h.4c14.7 0 50.4 2.9 77.3 31.4ZM128 78.7c-3 0-6.5.2-10.3.6a27.1 27.1 0 0 1-6 12.1 45 45 0 0 1-32 13c-6.8 0-13.9-1.5-19.7-5.2-5.5 1.9-10.8 4.5-11.2 11-.5 12.2-.6 24.5-.6 36.8 0 6.1 0 12.3-.2 18.5 0 3.6 2.2 6.9 5.5 8.4C79.9 185.9 105 192 128 192s48-6 74.5-18.1a9.4 9.4 0 0 0 5.5-8.4c.3-18.4 0-37-.8-55.3-.4-6.6-5.7-9.1-11.2-11-5.8 3.7-13 5.1-19.7 5.1a45 45 0 0 1-32-12.9 27.1 27.1 0 0 1-6-12.1c-3.4-.4-6.9-.5-10.3-.6Zm-27 44c5.8 0 10.5 4.6 10.5 10.4v19.2a10.4 10.4 0 0 1-20.8 0V133c0-5.8 4.6-10.4 10.4-10.4Zm53.4 0c5.8 0 10.4 4.6 10.4 10.4v19.2a10.4 10.4 0 0 1-20.8 0V133c0-5.8 4.7-10.4 10.4-10.4Zm-73-94.4c-11.2 1.1-20.6 4.8-25.4 10-10.4 11.3-8.2 40.1-2.2 46.2A31.2 31.2 0 0 0 75 91.7c6.8 0 19.6-1.5 30.1-12.2 4.7-4.5 7.5-15.7 7.2-27-.3-9.1-2.9-16.7-6.7-19.9-4.2-3.6-13.6-5.2-24.2-4.3Zm69 4.3c-3.8 3.2-6.4 10.8-6.7 19.9-.3 11.3 2.5 22.5 7.2 27a41.7 41.7 0 0 0 30 12.2c8.9 0 17-2.9 21.3-7.2 6-6.1 8.2-34.9-2.2-46.3-4.8-5-14.2-8.8-25.4-9.9-10.6-1-20 .7-24.2 4.3ZM128 56c-2.6 0-5.6.2-9 .5.4 1.7.5 3.7.7 5.7 0 1.5 0 3-.2 4.5 3.2-.3 6-.3 8.5-.3 2.6 0 5.3 0 8.5.3-.2-1.6-.2-3-.2-4.5.2-2 .3-4 .7-5.7-3.4-.3-6.4-.5-9-.5Z"/></svg>',
    paths: {
      skill: "~/.copilot/skills",
    },
    // Copilot's project-scoped layout uses .github/, not .copilot/ — a different folder
    // entirely, not just the global path relocated under the project root.
    projectPaths: {
      rule: ".github/instructions",
      command: ".github/prompts",
    },
    // .vscode/mcp.json is really VS Code's own native MCP feature (usable by more than just
    // Copilot Chat), not something Copilot itself owns — attributed here anyway since this
    // codebase has no separate "vscode" tool id and .vscode/ already sits alongside .github/ as
    // this entry's project-scoped territory. Confirmed on-disk shape: a top-level "servers" key
    // (not Claude Code's "mcpServers") mapping name -> { type, url } or { command, args, env }.
    projectMcpConfigPath: ".vscode/mcp.json",
    mcpConfigKey: "servers",
  },
  {
    id: "pi",
    name: "Pi",
    icon: "pi",
    svgIcon:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800" fill="currentColor" fill-rule="evenodd"><path clip-rule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"/><path d="M517.36 400H634.72V634.72H517.36Z"/></svg>',
    // Pi also reads the shared ~/.agents/skills/ (and project .agents/skills/, searched up
    // through ancestors to the git root) for cross-tool interop — deliberately not repeated here
    // since that's already covered by the "Shared" tool; this captures Pi's own distinct
    // location instead. No confirmed directory for agents or commands: Pi's slash commands are
    // served by skills themselves (/skill:name), and custom commands register through
    // ~/.pi/agent/extensions/ (code, not user-authored markdown files) — nothing here for
    // skillmanager to scan as an "agent" or "command" folder.
    paths: {
      skill: "~/.pi/agent/skills",
    },
    // AGENTS.md is auto-discovered at the project root, not from a global ~/.pi/ file.
    projectPaths: {
      skill: ".pi/skills",
      rule: "AGENTS.md",
    },
    singleFileRule: true,
  },
  {
    // Cross-tool shared library convention (~/.agents/skills/). No project-local equivalent:
    // project folders symlink INTO this directory instead of having their own copy.
    id: "global",
    name: "Shared",
    // Not "globe" — that icon is already spoken for by originLabel's "Global" scope indicator
    // (sourceLabel.ts), which is a different concept (an item's scope) from this tool's own
    // identity (a cross-tool shared skills directory). Reusing it would make the two look like
    // the same fact wherever both appear on a card (tool caption vs. footer origin).
    icon: "share-2",
    paths: {
      skill: "~/.agents/skills",
    },
  },
];

export const DEFAULT_SETTINGS: SkillManagerPluginSettings = {
  storageFolder: "AI Skills Manager",
  tools: DEFAULT_TOOLS,
  collections: [],
  discoverCatalog: [],
  discoverSources: [],
  projectWorkspaces: [],
  sectionOrder: DEFAULT_SECTION_ORDER,
  showEmptySidebarRows: false,
  autoRescanMinutes: 0,
  autoUpdateCheckMinutes: 0,
  defaultSortOrder: "name-asc",
  defaultEnabledFilter: "all",
  dashboardRecentlyDisabled: {},
  dashboardDisregarded: {},
  workspaceHintDismissed: false,
  mcpConfigEditorApp: "",
};
