import { Component, FileSystemAdapter, ItemView, Menu, MarkdownRenderer, Notice, WorkspaceLeaf, displayTooltip, parseYaml, setIcon, setTooltip } from "obsidian";
import { execFile, execFileSync } from "child_process";
import { cpSync, existsSync, lstatSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join, relative, sep } from "path";
import { homedir } from "os";
import {
  Collection,
  BrokenSymlink,
  DiscoverEntry,
  EnabledFilter,
  ItemMetadata,
  ItemType,
  McpServerEntry,
  MORE_HORIZONTAL_ICON_ID,
  MORE_ICON_ID,
  PLUGIN_ICON_ID,
  PluginSource,
  ProjectWorkspace,
  RulePathEntry,
  SkillManagerPluginSettings,
  SortOrder,
  LibraryLayout,
  ToolConfig,
  TYPE_LABEL_SINGULAR,
  TYPE_CATEGORY_LABELS,
  TYPE_LABELS,
} from "../types";
import { parseFrontmatter, parseSourceMeta, FrontmatterField, isBuiltInPath, expandHome, toProjectRelative } from "../scanners";
import { addToProject, removeFromProject } from "../projectLink";
import { deleteItem, disabledLocation, previewToggle, toggleItemEnabled, togglePluginEnabled } from "../itemToggle";
import { linkableUnit } from "../fsUnit";
import { MEMORY_INDEX_FILENAME, checkMemoryIndexed, forgetMemoryIndexEntry, isMemoryIndex, isMemoryItem, toggleMemoryEnabled } from "../memories";
import { ShadowNoteStore } from "../store";
import { deleteCollectionAndSync, upsertCollectionAndSync } from "../collections";
import { CollectionEditModal } from "../modals/CollectionEditModal";
import { AddToCollectionModal } from "../modals/AddToCollectionModal";
import { PluginItemInfoModal } from "../modals/PluginItemInfoModal";
import { InfoModal } from "../modals/InfoModal";
import { ProjectPresenceModal } from "../modals/ProjectPresenceModal";
import { ProjectEditModal } from "../modals/ProjectEditModal";
import { InstallFromGitHubModal } from "../modals/InstallFromGitHubModal";
import { AddDiscoverSourceModal } from "../modals/AddDiscoverSourceModal";
import { ConfirmModal } from "../modals/ConfirmModal";
import { AddToolModal } from "../modals/AddToolModal";
import {
  computeDashboardMetrics,
  findOverlapPairs,
  findPruneCandidates,
  pairSimilarity,
  isSameName,
  DashboardMetric,
  OverlapPair,
  OVERLAP_THRESHOLD,
} from "../dashboard";
import {
  CLAUDE_PROJECTS_DIR,
  computeClaudeUsage,
  findUsagePruneCandidates,
  invocationName,
  usageKey,
  listTranscriptFiles,
  rankTopUsedItems,
  scanTranscriptFile,
  ClaudeUsageStats,
  USAGE_STALE_DAYS,
  TOP_USED_WINDOW_DAYS,
} from "../claude-usage";
import { CODEX_SESSIONS_DIR, computeCodexUsage, listCodexSessionFiles, scanCodexSessionFile } from "../codex-usage";
import {
  addDiscoverSource,
  dedupeDiscoverCatalog,
  discoverGitSkills,
  discoverSourceId,
  fetchGithubStars,
  githubSourceUrl,
  parseOwnerRepo,
  refetchDiscoverEntry,
} from "../discover";
import { errorMessage } from "../errors";
import { checkIntegrity } from "../integrity";
import { DayCounts, HEATMAP_WEEKS, buildHeatmap, heatLevel, historyKey, mergeUsageHistory } from "../usage-history";
import { formatBytes, formatDate, formatRelativeDay, formatTokens, stripFrontmatter } from "../format";
import { buildFileTree, countFiles, isFolderItem, TreeNode } from "../fileTree";
import { getAllProjects as computeAllProjects, performRescan, projectIcon, RescanResult, VAULT_PROJECT_ID } from "../rescan";
import { originLabel as resolveOriginLabel, sourceLabel as resolveSourceLabel, toolLabel as resolveToolLabel } from "../sourceLabel";
import { ClonedRepo, remoteHeadCommit, shallowCloneAtCommit, shallowCloneRepo } from "../git";
import { renderDiffBody } from "../diff/renderDiff";
import { computeCompanionChanges, CompanionRow } from "../diff/companions";
import { UnchangedUpdateModal } from "../modals/UnchangedUpdateModal";

export const LIBRARY_VIEW_TYPE = "skillmanager-library-view";

export type UpdateMode = "update" | "restore";
type PluginBundleSortOrder = "name-asc" | "name-desc" | "items-desc" | "items-asc";

/** A pending update/restore review, shown inline in the detail rail in place of the manifest's
 *  normal content (see renderDetailRail/renderDiffReview) rather than a separate view — scoped to
 *  one item (`entryId`) so navigating to a different skill implicitly cancels it (see
 *  cleanupReview, called from every navigation method). */
type ReviewState =
  | { status: "loading"; entryId: string; mode: UpdateMode }
  | { status: "error"; entryId: string; mode: UpdateMode; message: string }
  | {
      status: "ready";
      entryId: string;
      mode: UpdateMode;
      oldText: string;
      newText: string;
      companions: CompanionRow[];
      unitPath: string;
      isDirectory: boolean;
      newRoot: string;
      newCommit: string;
      clone: ClonedRepo;
    };

export const SORT_OPTIONS: { key: SortOrder; label: string }[] = [
  { key: "name-asc", label: "Name (A to Z)" },
  { key: "name-desc", label: "Name (Z to A)" },
  { key: "modified-desc", label: "Modified time (new to old)" },
  { key: "modified-asc", label: "Modified time (old to new)" },
  { key: "usage-desc", label: `Most used (last ${HEATMAP_WEEKS} weeks)` },
  { key: "last-used-desc", label: "Recently used" },
];

type DiscoverSortOrder = "recent-desc" | "name-asc" | "name-desc" | "stars-desc" | "source";

/** Identifies a "Source (grouped)" section (see renderDiscoverGroupedGrid/collapsedDiscoverSources) —
 *  a repo can be discovered at more than one ref, so ref has to be part of the key too. */
function discoverGroupKey(repoUrl: string, ref: string): string {
  return `${repoUrl}#${ref}`;
}

const DISCOVER_SORT_OPTIONS: { key: DiscoverSortOrder; label: string }[] = [
  { key: "recent-desc", label: "Recently added" },
  { key: "stars-desc", label: "Most stars" },
  { key: "name-asc", label: "Name (A to Z)" },
  { key: "name-desc", label: "Name (Z to A)" },
  { key: "source", label: "Source (grouped)" },
];

const TYPE_ICONS: Record<ItemType, string> = {
  skill: "sparkles",
  agent: "bot",
  command: "terminal",
  rule: "scroll-text",
};

/** Colors the Dashboard's "cost by tool" stacked bars and legend by type — arbitrary but stable,
 *  same mapping everywhere the Dashboard shows a type. */
const DASHBOARD_TYPE_COLORS: Record<ItemType, string> = {
  skill: "var(--color-accent, var(--interactive-accent))",
  agent: "var(--color-blue, #4f9cf9)",
  command: "var(--color-green, #4caf50)",
  rule: "var(--color-orange, #e8a33d)",
};

const DASHBOARD_RANKED_COLLAPSED_COUNT = 5;

type InsightTone = "danger" | "warn" | "muted";

interface InsightAction {
  label: string;
  run: () => void;
  warning?: boolean;
}

interface InsightFact {
  label: string;
  value: string;
  path?: boolean;
  missing?: boolean;
  multiline?: boolean;
  /** Clamped to two lines (descriptions). */
  clamp?: boolean;
  tooltip?: string;
}

/** One Health/Cleanup row (see renderInsightRow). */
interface InsightRow {
  /** Unique across sections; tracks the row's open state. */
  key: string;
  renderName: (el: HTMLElement) => void;
  /** One plain sentence under the name saying what's wrong. */
  problem: string;
  tone: InsightTone;
  /** Lower-case bucket for the section summary ("source missing") and the pill by the name. */
  group: string;
  figure?: string;
  facts: InsightFact[];
  /** Overlaps: both items side by side in the open panel, each with its own actions. */
  pair?: [ItemMetadata, ItemMetadata];
  /** The row's fix. Absent for overlaps, whose fixes live on each side of the pair. */
  primary?: InsightAction;
  open?: () => void;
  extra?: InsightAction[];
  disregardKey: string;
}

/** Shortens an absolute path under the home folder to "~/…" for display. */
function tildePath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + sep) ? "~" + path.slice(home.length) : path;
}
/** Ranked by cost shows more before collapsing: it's a bar chart, and the head of a long-tailed
 *  cost distribution is where the comparison is worth reading. */
const DASHBOARD_COST_COLLAPSED_COUNT = 10;
/** How many of the costliest items the Ranked by cost summary line sums up ("Top 5 = 62%"). */
const DASHBOARD_COST_SUMMARY_COUNT = 5;

/** The sidebar's Insights section: one page per question the old single Dashboard answered. */
type InsightsPage = "context" | "usage" | "health" | "cleanup";
const INSIGHTS_PAGES: { page: InsightsPage; label: string; icon: string }[] = [
  { page: "context", label: "Context", icon: "gauge" },
  { page: "usage", label: "Usage", icon: "activity" },
  { page: "health", label: "Health", icon: "heart-pulse" },
  { page: "cleanup", label: "Cleanup", icon: "scissors" },
];
/** Tools that record per-item invocation history this plugin can read (see claude-usage.ts and
 *  codex-usage.ts) — the only ones the Usage page can show anything for. */
const USAGE_TOOLS: { id: "claude-code" | "codex"; name: string }[] = [
  { id: "claude-code", name: "Claude Code" },
  { id: "codex", name: "Codex" },
];

/** How long a "Disable" from Prune candidates keeps offering a "Restore" shortcut before the
 *  dashboard stops reminding about it (the item itself stays disabled either way). */
const DASHBOARD_RESTORE_WINDOW_MS = 24 * 60 * 60 * 1000;

function dashboardRelativeAge(ms: number): string {
  const hours = Math.max(1, Math.round(ms / (60 * 60 * 1000)));
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** One-click suggestions for Discover's empty state — real, verified repos (checked against the
 *  GitHub API while building this, not guessed) known to hold SKILL.md-convention content, so a
 *  brand-new user has something to click besides a blank "+ Add source" form. Clicking one runs
 *  the exact same addDiscoverSource() flow the modal uses, just without the form. */
const STARTER_DISCOVER_SOURCES: { name: string; description: string; repoUrl: string }[] = [
  {
    name: "Obsidian Skills",
    description: "Kepano's Agent Skills for Obsidian",
    repoUrl: "https://github.com/kepano/obsidian-skills.git",
  },
  { name: "Matt Pocock Skills", description: "Matt Pocock's public Agent Skills", repoUrl: "https://github.com/mattpocock/skills.git" },
  {
    name: "Caveman",
    description: "Julius Brussee's Agent Skills",
    repoUrl: "https://github.com/juliusbrussee/caveman.git",
  },
  {
    name: "Superpowers",
    description: "Agentic skills framework & dev methodology",
    repoUrl: "https://github.com/obra/superpowers.git",
  },
];

const TAG_COLORS = 8;

function tagColorIndex(tag: string): number {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = (hash * 31 + tag.charCodeAt(i)) >>> 0;
  }
  return hash % TAG_COLORS;
}

const SOURCE_FILTER_LABELS: Record<"github" | "builtin" | "local", string> = {
  github: "GitHub-tracked",
  builtin: "Built-in",
  local: "Local",
};

type RuleKind = "instructions" | "granular" | "memory";
/** A Filter-menu section (see renderFilterButton). */
type FilterDimension = "type" | "kind" | "tool" | "scope" | "source";
const RULE_KIND_LABELS: Record<RuleKind, string> = {
  instructions: "Instructions files",
  granular: "Individual rules",
  memory: "Memories",
};

export class LibraryView extends ItemView {
  private items: ItemMetadata[] = [];
  private search = "";
  private enabledFilter: EnabledFilter = "all";
  private sortOrder: SortOrder = "name-asc";
  private typeFilter: ItemType | null = null;
  private toolFilter: string | null = null;
  /** Page-local cross-filters: these narrow a type/tool page without activating the other
   *  sidebar navigation row, so the primary page scope remains visually unambiguous. */
  private pageToolFilter: string | null = null;
  private pageTypeFilter: ItemType | null = null;
  private collectionFilter: string | null = null;
  private projectFilter: string | null = null;
  private pluginFilter: string | null = null;
  private favoritesOnly = false;
  /** Not one of the scope filters below (isScoped/clearScopeFilters) — like tagFilter, it's a
   *  compounding filter that stays put across sidebar navigation and ANDs with whatever scope
   *  you're already in, rather than being a scope of its own. Lives in the tagbar row (see
   *  renderSourceButton), not the sidebar. */
  private sourceFilter: "github" | "builtin" | "local" | null = null;
  /** Same compounding, sticks-around-across-navigation shape as sourceFilter, but scoped to
   *  ItemType "rule": "instructions" narrows to a tool's single loaded-every-session file (e.g.
   *  Claude Code's CLAUDE.md, ToolConfig.singleFileRule), "granular" to a directory of many
   *  separate rule files (e.g. Cursor's ~/.cursor/rules), "memory" to files the agent wrote
   *  itself (ToolConfig.memoryPath). Rendered only while typeFilter === "rule" (see
   *  renderRuleKindButton) since it's meaningless for any other type. */
  private ruleKindFilter: RuleKind | null = null;
  /** Page-level scope filter from the Filter menu (see renderFilterButton): "global" for items
   *  found under a tool's home-directory paths, or a workspace id. Hidden, and ignored, on a
   *  workspace page, where the sidebar already fixes the scope. */
  private pageScopeFilter: string | null = null;
  /** Per-session only (see silentUpdateItem/bulkCheckForUpdates) — whether a sourceRepo item was
   *  last confirmed current or behind. Absent (including for anything with no sourceRepo at all)
   *  reads as "unknown," the same muted dot as "not tracked from GitHub," until an explicit check
   *  proves otherwise — there's no way to know staleness without asking GitHub, so nothing here
   *  is ever assumed or persisted across sessions. */
  private syncStatus = new Map<string, "current" | "stale">();
  private bulkCheckInProgress = false;
  private bulkUpdateInProgress = false;
  /** True while the sidebar's "Discover" row is active — swaps the whole content pane for the
   *  catalog grid (see renderContent/renderDiscoverContent) instead of the normal filtered
   *  library grid. Not one of the scope filters below since it isn't a way of narrowing
   *  this.items — Discover browses settings.discoverCatalog instead. */
  private discoverMode = false;
  private discoverSearch = "";
  private discoverSortOrder: DiscoverSortOrder = "source";
  /** Per-session only, keyed by discoverGroupKey — which "Source (grouped)" sections are
   *  collapsed to just their header, so hopping to the next source doesn't mean scrolling past
   *  however many hundred cards the current one has. */
  private collapsedDiscoverSources = new Set<string>();
  private discoverTypeFilter: ItemType | null = null;
  /** The catalog entry currently open in the Discover rail (see renderDiscoverRail) — mirrors
   *  selectedItem's role for the real library, but stays entirely separate: a DiscoverEntry has
   *  no tree/file/edit state to track. */
  private selectedDiscoverEntry: DiscoverEntry | null = null;
  private refreshingAllDiscover = false;
  private rescanningManually = false;
  /** True while the sidebar's "All tools" row is active — same swap-the-content-pane idea as
   *  discoverMode, for the tool-configuration page (see renderContent/renderToolsPageContent).
   *  Not a scope filter either, for the same reason: it isn't a way of narrowing this.items. */
  private toolsMode = false;
  /** The tool currently open in the docked rail (see renderToolDetailRail) — mirrors
   *  selectedItem's role, kept entirely separate since a ToolConfig has no tree/file/edit state. */
  private selectedTool: ToolConfig | null = null;
  /** Narrows the "All tools" page's grid to tools matching a given status — rendered via
   *  renderToolStatusButton, next to the "Add tool" button. Deliberately doesn't affect the
   *  stats row above it (see renderToolsPageContent), which always totals every configured tool
   *  regardless of this filter — otherwise picking "Custom" would make "Detected"/"Enabled"
   *  read as counts of custom tools only, silently changing what those numbers mean. */
  private toolStatusFilter: "all" | "detected" | "not-detected" | "enabled" | "disabled" | "custom" = "all";
  /** True while any of the sidebar's Insights pages is active — same swap-the-content-pane idea as
   *  discoverMode/toolsMode. Not a scope filter: it doesn't narrow this.items, it reports on it.
   *  insightsPage says which one; it outlives dashboardMode so "Back" from an item opened on a
   *  page lands on that same page. */
  private dashboardMode = false;
  private insightsPage: InsightsPage = "context";
  /** Which tool the Usage page is showing; only tools with readable invocation history. */
  private insightsUsageTool: "claude-code" | "codex" = "claude-code";
  /** Computed lazily the first time the Dashboard is opened (or after an item is toggled from
   *  within it), not on every render — each entry means a file read, and nothing in the dashboard
   *  changes just from typing in the search box or switching some other sidebar filter. */
  private dashboardMetrics: DashboardMetric[] | null = null;
  /** Counts behind the sidebar's Health and Cleanup badges, so "attention needed" is visible
   *  without opening Insights. Cached alongside dashboardMetrics and invalidated the same places —
   *  the sidebar renders far more often than Insights itself, so this must stay a cache, not a
   *  recompute-on-every-render. */
  private insightsCounts: { health: number; cleanup: number } | null = null;
  /** entryId -> integrity issues for every enabled item that has any (see integrity.ts). Lazy,
   *  cleared on rescan and after a save from the detail rail, same lifecycle as dashboardMetrics. */
  private integrityIssues: Map<string, string[]> | null = null;
  private brokenSymlinks: BrokenSymlink[] = [];
  private knownBrokenSymlinkKeys = new Set<string>();
  /** Which "Source size by tool" card is selected — filters the ranked list below to just that tool;
   *  null means "All tools." */
  private dashboardActiveTool: string | null = null;
  /** Which type pill is selected above the Ranked list — ANDs with dashboardActiveTool; null
   *  means "All types." */
  private dashboardTypeFilter: ItemType | null = null;
  private dashboardBrokenSymlinksExpanded = false;
  private dashboardIntegrityExpanded = false;
  private dashboardRankedExpanded = false;
  /** Section ids ("broken", "integrity", "prune", "overlaps") whose disregarded rows are shown. */
  private dashboardShowDisregarded = new Set<string>();
  /** Health/Cleanup rows the user has expanded, keyed by InsightRow.key. */
  private dashboardOpenRows = new Set<string>();
  private dashboardPruneExpanded = false;
  private dashboardOverlapsExpanded = false;
  /** Live-tracked scroll offset of the dashboard's scrollable body, restored on the next render
   *  the same way libraryScrollTop/dockedScrollTop work for the main grid. */
  private dashboardScrollTop = 0;
  /** entryId -> real Claude Code invocation stats, computed only once the "Claude Code" tool tile
   *  is selected (see getClaudeUsage/loadClaudeUsage) — unlike dashboardMetrics this means walking
   *  every session transcript under ~/.claude/projects, so it's not just lazy, it's asynchronous:
   *  loadClaudeUsage yields between files so a multi-second scan doesn't freeze the render thread.
   *  Invalidated at the same sites as dashboardMetrics. */
  private claudeUsage: Map<string, ClaudeUsageStats> | null = null;
  /** True while loadClaudeUsage's file loop is running — guards against a second scan starting
   *  before the first finishes, and lets the two Claude-Code-only sections show a loading state
   *  instead of an empty one. */
  private claudeUsageLoading = false;
  /** Codex usage is derived from the CLI's session JSONL and loaded only when its tile is selected. */
  private codexUsage: Map<string, ClaudeUsageStats> | null = null;
  private codexUsageLoading = false;
  /** True while the Library's installed plugin-bundle browser is active. Unlike pluginFilter,
   *  this swaps the content pane for bundle cards; clicking one enters the normal item grid. */
  private pluginBundlesMode = false;
  private pluginBundleSearch = "";
  private pluginBundleToolFilter: string | null = null;
  private pluginBundleGroupFilter: string | null = null;
  private pluginBundleTagFilter: string | null = null;
  private pluginBundleSortOrder: PluginBundleSortOrder = "name-asc";
  /** Set right before leaving dashboardMode to open an item clicked from the Ranked list, so
   *  backToLibrary() knows to land back on the Dashboard (in the same scroll/filter state)
   *  instead of the plain Library. Consumed (reset to false) the moment backToLibrary() runs. */
  private detailReturnsToDashboard = false;
  private tagFilter: string | null = null;
  private untaggedOnly = false;
  private collapsedSections = new Set<string>();
  private draggedSectionKey: string | null = null;
  private dragHighlightEl: HTMLElement | null = null;
  private discoveredPlugins: PluginSource[] = [];
  private mcpServers: McpServerEntry[] = [];
  /** True while the sidebar's "MCP servers" row is active — same swap-the-content-pane idea as
   *  discoverMode/toolsMode/dashboardMode. Read-only: no enable/disable here, see McpServerEntry. */
  private mcpMode = false;
  private mcpToolFilter: string | null = null;
  /** Mirrors selectedItem/selectedTool's role for the docked detail rail, but for an
   *  McpServerEntry — see renderMcpServerDetailRail. */
  private selectedMcpServer: McpServerEntry | null = null;
  /** Env var keys currently shown in plaintext in the open MCP detail rail — per-session only,
   *  reset whenever a different server is selected (see renderMcpServerCard's click handler). */
  private revealedMcpEnvKeys = new Set<string>();

  // Selection: which card is highlighted, and — for a folder-based skill with more than one
  // file — the file tree shown in the detail rail beside the grid. A single-file item skips the
  // tree entirely and goes straight to the file (see selectItem). selectedFilePath is null while
  // the tree itself is showing (nothing picked yet) and set once a file is chosen, in the same
  // rail. The grid stays put the whole time (see renderContent) — only the rail's contents and
  // the breadcrumb trail above it change with depth.
  private selectedItem: ItemMetadata | null = null;
  private selectedFilePath: string | null = null;
  // Scroll position of the full (un-docked) library grid, tracked live while it's visible and
  // restored on backToLibrary — otherwise returning from a skill snaps back to the top instead
  // of wherever the user actually was.
  private libraryScrollTop = 0;
  // Same idea for the docked grid (beside the detail rail): tracked live so switching between
  // cards while already docked keeps the list exactly where it was instead of recalculating a
  // scroll position from the newly selected card's DOM position, which is what caused a visible
  // jump — since the grid is rebuilt from scratch on every render, "nearest" scrolling to a card
  // near the bottom of the list snapped the whole grid down to it even though the card was
  // already on screen. wasDocked distinguishes "already docked, just switching cards" (restore
  // scroll) from "just became docked" (scroll the new selection into view, since we don't know
  // where it landed in the narrower column layout).
  private dockedScrollTop = 0;
  private wasDocked = false;
  // Same idea again, for the tagbar's horizontal tag scroller — selecting a tag re-renders the
  // whole view, so without tracking/restoring this the scroll region would snap back to the
  // start on every click instead of staying where the user left it. Only the "All" chip resets
  // it to 0 explicitly.
  private tagbarScrollLeft = 0;
  // Same pair, for the Discover grid's own docked/undocked toggle (see renderDiscoverContent) —
  // kept separate since the two grids are different DOM subtrees with independent scroll state.
  private dockedDiscoverScrollTop = 0;
  private wasDiscoverDocked = false;
  private detailLoadedFor: string | null = null;
  private detailContent = "";
  private detailEditing = false;
  private collapsedTreeFolders = new Set<string>();
  // Set only by an actual navigation action (see selectItem/selectFile/backToTree/
  // backToLibrary, and their Discover-card equivalents in renderDiscoverCard/renderDiscoverRail)
  // and consumed once by renderContent/renderDiscoverContent, so the enter animation plays for a
  // real depth change but never replays on an incidental re-render (a card toggle, a sidebar
  // reorder, a favourite toggle). The grid itself never swaps content — only the rail does — so
  // this only needs a direction, not a target. Shared by both the library and Discover rails so
  // opening a file preview feels the same regardless of which list it was opened from.
  private pendingDetailAnimation: "forward" | "back" | null = null;
  private readonly markdownComponent = new Component();
  private review: ReviewState | null = null;
  // entryId of the item currently showing the inline "add a tag" input in place of the "+ tag"
  // button — local UI state, not persisted, reset whenever selection changes.
  private addingTagFor: string | null = null;
  // Whether the "N more fields" frontmatter disclosure is open — local UI state, reset whenever
  // selection changes so a freshly-opened file always starts collapsed.

  constructor(
    leaf: WorkspaceLeaf,
    private getSettings: () => SkillManagerPluginSettings,
    private store: ShadowNoteStore,
    private saveSettings: () => Promise<void>
  ) {
    super(leaf);
  }

  getViewType() {
    return LIBRARY_VIEW_TYPE;
  }

  getDisplayText() {
    return "AI Skills Manager";
  }

  getIcon() {
    return PLUGIN_ICON_ID;
  }

  async onOpen() {
    this.markdownComponent.load();
    this.sortOrder = this.getSettings().defaultSortOrder;
    this.enabledFilter = this.getSettings().defaultEnabledFilter;
    await this.rescan();
  }

  onClose() {
    this.markdownComponent.unload();
    this.cleanupReview();
    return Promise.resolve();
  }

  /** Discards any pending review and its temp clone — called whenever navigation moves away from
   *  the file it's reviewing (a review only ever makes sense for the exact file it was started
   *  against), and before starting a new one. */
  private cleanupReview() {
    if (this.review?.status === "ready") this.review.clone.cleanup();
    this.review = null;
  }

  async rescan(): Promise<RescanResult> {
    const result = await performRescan(this.app, this.getSettings(), this.store);
    this.discoveredPlugins = result.plugins;
    this.mcpServers = result.mcpServers;
    this.brokenSymlinks = result.brokenSymlinks;
    const brokenKeys = new Set(this.brokenSymlinks.map((link) => link.path));
    const newBroken = this.brokenSymlinks.filter((link) => !this.knownBrokenSymlinkKeys.has(link.path));
    if (newBroken.length > 0) {
      new Notice(`${newBroken.length} broken symlink${newBroken.length === 1 ? "" : "s"} found. Review ${newBroken.length === 1 ? "it" : "them"} in the Dashboard.`);
    }
    this.knownBrokenSymlinkKeys = brokenKeys;
    this.items = result.items;
    if (this.selectedItem) {
      const previousSourcePath = this.selectedItem.sourcePath;
      const updated = this.items.find((i) => i.entryId === this.selectedItem?.entryId) ?? null;
      // A toggle (or any other action that moves the underlying file/folder, e.g. into or out of
      // .skillmanager-disabled) changes sourcePath out from under the currently-open file. Without
      // remapping it here, selectedFilePath keeps pointing at the old, now-nonexistent location,
      // and the detail rail renders blank (loadFileContent's readFileSync throws and is swallowed
      // into an empty string).
      if (updated && this.selectedFilePath && previousSourcePath !== updated.sourcePath) {
        if (this.selectedFilePath === previousSourcePath) {
          this.selectedFilePath = updated.sourcePath;
        } else {
          // A multi-file skill's sourcePath is its SKILL.md, but sibling files in its tree live
          // under the containing folder (see fileTree.ts's skillFolder) — one level up from
          // sourcePath itself. Matching against sourcePath here (rather than its dirname) missed
          // every sibling file, leaving the preview stuck on a since-moved path.
          const previousDir = dirname(previousSourcePath);
          if (this.selectedFilePath.startsWith(previousDir + sep)) {
            const updatedDir = dirname(updated.sourcePath);
            this.selectedFilePath = updatedDir + this.selectedFilePath.slice(previousDir.length);
          }
        }
      }
      this.selectedItem = updated;
      if (!updated) this.selectedFilePath = null;
    }
    // Whatever file is open in the rail may have just changed on disk out from under it (a
    // restore/update, an external edit) — invalidate the cached preview so renderFileContent
    // re-reads it instead of showing what was there before this rescan.
    this.detailLoadedFor = null;
    // Items just changed underneath both caches — a stale dashboardMetrics/attention count would
    // otherwise linger in the sidebar badge until the next Dashboard-specific action cleared it.
    this.dashboardMetrics = null;
    this.insightsCounts = null;
    this.integrityIssues = null;
    this.claudeUsage = null;
    this.codexUsage = null;
    this.render();
    return result;
  }

  /** Re-renders against already-discovered items — for a settings change that affects display
   *  only (e.g. which tools the sidebar shows), where a full disk rescan would be wasted work. */
  refresh() {
    this.render();
  }

  /** The sidebar's "Rescan tools" row calls this, not rescan() directly — rescan() itself runs
   *  silently after every install/delete/toggle (its own Notice, if any, is specific to that
   *  action), so spinning the icon and popping a summary Notice for every one of those would be
   *  noisy. This is only for the explicit "I clicked rescan, is it doing anything?" moment. */
  private async manualRescan() {
    if (this.rescanningManually) return;
    this.rescanningManually = true;
    this.render();
    try {
      const result = await this.rescan();
      new Notice(`Rescan complete: ${result.items.length} item${result.items.length === 1 ? "" : "s"} found.`);
    } catch (err) {
      new Notice(`Scan failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.rescanningManually = false;
      this.render();
    }
  }

  /** Walks every Claude Code session transcript to compute real invocation counts — see
   *  claude-usage.ts for the parsing itself. This is meaningfully more expensive than
   *  dashboardMetrics (that's a handful of already-known item files; this is however many
   *  sessions Claude Code has ever logged), so beyond being lazy it also yields between files
   *  (an awaited zero-delay setTimeout) rather than blocking the render thread for one long
   *  synchronous pass, and caps total bytes read so a very long history can't make the wait
   *  unbounded — newest sessions first, so a cut-off drops the oldest, least-relevant history. */
  /** Assumes claudeUsageLoading is already true (set by getClaudeUsage before scheduling this) —
   *  started from a window.setTimeout, never called directly, so its first "await"-free lines
   *  never run inside an in-progress render() call. Calling this.render() synchronously from
   *  inside renderInsightsContent (which getClaudeUsage is called from) would re-enter render()
   *  while the outer call is still writing to the DOM, tearing out what it had already built —
   *  deferring the start of this method past the current render pass is what avoids that. */
  private async loadClaudeUsage() {
    try {
      // No total-byte ceiling here on purpose — an earlier version capped this at 40MB, which
      // silently excluded older transcripts and broke exactly the case this feature exists for
      // (finding a *rarely* invoked skill, whose only invocation is likely to be in older
      // history, not the most recent slice). Measured directly against this project's own
      // ~124MB/91-file history: a full scan takes well under a second, so the per-file yield
      // below is already enough to keep the UI responsive — a size ceiling wasn't buying
      // anything a real user would notice, only breaking correctness. The per-file
      // MAX_TRANSCRIPT_FILE_BYTES guard in scanTranscriptFile still protects against one
      // pathologically large session file.
      const projectsDir = expandHome(CLAUDE_PROJECTS_DIR);
      const files = listTranscriptFiles(projectsDir);

      // Windows the invocation *count* to TOP_USED_WINDOW_DAYS (for the "Top Skills & Agents"
      // ranking) without touching lastUsedMs, which scanTranscriptFile always tracks all-time —
      // see its sinceMs doc comment.
      const sinceMs = Date.now() - TOP_USED_WINDOW_DAYS * 24 * 60 * 60 * 1000;
      const raw = new Map<string, ClaudeUsageStats>();
      const days = new Map<string, DayCounts>();
      for (const f of files) {
        scanTranscriptFile(f, raw, sinceMs, days);
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }

      this.claudeUsage = computeClaudeUsage(this.items, raw);
      await this.saveUsageHistory("claude-code", days);
    } catch (e) {
      // Without this, a thrown error here was an unhandled rejection nobody could see — the tile
      // just looked permanently empty with no way to tell "broken" from "genuinely no usage yet."
      console.error("AI Skills Manager: failed to read Claude Code usage history", e);
      new Notice(`Couldn't read Claude Code usage history: ${errorMessage(e)}`);
      this.claudeUsage = new Map();
    } finally {
      // Runs even if something above threw, so a bad transcript can't leave the tile stuck
      // showing "Scanning…" forever with getClaudeUsage refusing to ever retry.
      this.claudeUsageLoading = false;
      this.render();
    }
  }

  private async loadCodexUsage() {
    try {
      const files = listCodexSessionFiles(expandHome(CODEX_SESSIONS_DIR));
      const sinceMs = Date.now() - TOP_USED_WINDOW_DAYS * 24 * 60 * 60 * 1000;
      const raw = new Map<string, ClaudeUsageStats>();
      const codexItems = this.items.filter((i) => i.tool === "codex" && (i.type === "skill" || i.type === "agent"));
      const days = new Map<string, DayCounts>();
      for (const file of files) {
        scanCodexSessionFile(file, codexItems, raw, sinceMs, days);
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
      this.codexUsage = computeCodexUsage(this.items, raw);
      await this.saveUsageHistory("codex", days);
    } catch (e) {
      console.error("AI Skills Manager: failed to read Codex usage history", e);
      new Notice(`Couldn't read Codex usage history: ${errorMessage(e)}`);
      this.codexUsage = new Map();
    } finally {
      this.codexUsageLoading = false;
      this.render();
    }
  }

  /** Folds a fresh scan's per-day sessions into the saved heatmap history. A failed save only
   *  costs history older than the tool's own transcript retention, so it's logged, not surfaced. */
  private async saveUsageHistory(tool: string, days: Map<string, DayCounts>) {
    const settings = this.getSettings();
    settings.usageHistory ??= {};
    if (!mergeUsageHistory(settings.usageHistory, tool, days)) return;
    try {
      await this.saveSettings();
    } catch (e) {
      console.error("AI Skills Manager: failed to save usage history", e);
    }
  }

  /** Returns the cached usage map, or null while it's still being computed — kicks off
   *  loadClaudeUsage as a side effect the first time this is called (from an Insights page,
   *  e.g. Usage or Cleanup), same "getter triggers the lazy computation" shape
   *  as getDashboardMetrics, just asynchronous. Sets the loading flag and schedules the load via
   *  window.setTimeout rather than calling it directly — this getter runs mid-render, and
   *  loadClaudeUsage's own this.render() call needs to land strictly after the current render()
   *  call has finished, not inside it. */
  private getClaudeUsage(): Map<string, ClaudeUsageStats> | null {
    if (this.claudeUsage) return this.claudeUsage;
    if (!this.claudeUsageLoading) {
      this.claudeUsageLoading = true;
      window.setTimeout(() => void this.loadClaudeUsage(), 0);
    }
    return null;
  }

  private getCodexUsage(): Map<string, ClaudeUsageStats> | null {
    if (this.codexUsage) return this.codexUsage;
    if (!this.codexUsageLoading) {
      this.codexUsageLoading = true;
      window.setTimeout(() => void this.loadCodexUsage(), 0);
    }
    return null;
  }

  /** Actually enables/disables an item by moving its file — the tool only ever sees whatever
   *  files sit in its configured directories, so anything less than a real move has no effect
   *  on it. This changes the item's path, so a rescan (not an optimistic patch) follows. */
  private async toggleEnabled(item: ItemMetadata) {
    try {
      if (this.isMemory(item)) toggleMemoryEnabled(item);
      else toggleItemEnabled(item);
    } catch (e) {
      new Notice(`Couldn't toggle "${item.name}": ` + errorMessage(e));
      return;
    }
    await this.rescan();
  }

  /** Gate in front of every enable/disable that moves a real file or folder — a card's toggle,
   *  the Dashboard's Disable/Restore actions, and the broken-symlinks "Enable source" shortcut
   *  all route through here rather than calling toggleEnabled (or whatever Dashboard bookkeeping
   *  wraps it) directly, so a stray click doesn't silently move something on disk. Skipped
   *  entirely when confirmBeforeToggle (Settings, on by default) is off. `perform` is whatever
   *  that call site already did — this only decides whether it runs immediately or behind a
   *  confirmation naming the exact move, worded from previewToggle so it can never drift from
   *  what toggleItemEnabled itself is about to do. */
  private confirmToggle(item: ItemMetadata, perform: () => void | Promise<void>) {
    if (!this.getSettings().confirmBeforeToggle) {
      void perform();
      return;
    }
    const preview = previewToggle(item);
    const toolText = this.toolLabel(item).text;
    const indexNote =
      this.isMemory(item) && !isMemoryIndex(item)
        ? preview.willDisable
          ? ` Its line in ${MEMORY_INDEX_FILENAME} is removed too.`
          : ` Its line in ${MEMORY_INDEX_FILENAME} is restored too.`
        : "";
    new ConfirmModal(
      this.app,
      preview.willDisable ? `Disable "${item.name}"?` : `Enable "${item.name}"?`,
      preview.willDisable
        ? `This moves "${item.name}" to ${preview.toPath}, so ${toolText} stops seeing it.${indexNote}`
        : `This moves "${item.name}" back to ${preview.toPath}, so ${toolText} can see it again.${indexNote}`,
      preview.willDisable ? "Disable" : "Enable",
      async () => {
        await perform();
      }
    ).open();
  }

  /** Quick unlink for a card the user is looking at directly, rather than routing through the
   *  project presence modal — removeFromProject already refuses anything that isn't actually a
   *  symlink, so this can't run against a Local card even if one somehow triggers it. */
  private async unlinkFromProject(item: ItemMetadata) {
    try {
      removeFromProject(item.sourcePath);
    } catch (e) {
      new Notice(`Couldn't unlink "${item.name}": ` + errorMessage(e));
      return;
    }
    await this.rescan();
  }

  /** Persists a single item's metadata and patches in-memory state directly, rather than
   *  re-reading from Obsidian's metadata cache (which updates asynchronously and can lag
   *  a moment behind the write — reading it back immediately risked showing stale state). */
  private async applyItemUpdate(entryId: string, changes: Partial<ItemMetadata>) {
    await this.store.update(entryId, changes);
    this.items = this.items.map((item) => (item.entryId === entryId ? { ...item, ...changes } : item));
    if (this.selectedItem?.entryId === entryId) {
      this.selectedItem = { ...this.selectedItem, ...changes };
    }
    this.render();
  }

  private getAllProjects() {
    return computeAllProjects(this.app, this.getSettings());
  }

  /** A project-scoped instance's own sourcePath is a symlink, not the real source — resolving
   *  back to the global item (same realPath, projectId === null) before opening the presence
   *  modal is what lets "add to another project" always link from the true source. */
  private resolveGlobalItem(item: ItemMetadata): ItemMetadata | null {
    if (item.projectId === null) return item;
    return this.items.find((i) => i.projectId === null && i.realPath === item.realPath) ?? null;
  }

  /** The single "manage this skill's project links" control — same icon, same color rule, same
   *  click behavior wherever it appears, whether that's a global card or a project-scoped one
   *  resolved back to its global source. Always opens the picker; nothing here unlinks directly. */
  private renderProjectLinkButton(container: HTMLElement, globalItem: ItemMetadata) {
    const linkedSomewhere = this.items.some(
      (i) => i.projectId && i.projectId !== globalItem.projectId && i.realPath === globalItem.realPath
    );
    const btn = container.createEl("button", {
      cls: `skillmanager-icon-btn${linkedSomewhere ? " is-present" : ""}`,
      attr: { "aria-label": linkedSomewhere ? "Manage project links" : "Link into a workspace" },
    });
    setIcon(btn, "link");
    btn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.openProjectPresence(globalItem);
    });
  }

  private openProjectPresence(item: ItemMetadata) {
    const tool = this.getSettings().tools.find((t) => t.id === item.tool);
    if (!tool) return;

    const presentIds = new Set(
      this.items.filter((i) => i.projectId && i.realPath === item.realPath).map((i) => i.projectId as string)
    );

    new ProjectPresenceModal(
      this.app,
      item.name,
      this.getAllProjects(),
      presentIds,
      async (project) => {
        addToProject(item, tool, project);
        await this.rescan();
      },
      async (project) => {
        const projectItem = this.items.find((i) => i.projectId === project.id && i.realPath === item.realPath);
        if (projectItem) {
          removeFromProject(projectItem.sourcePath);
          await this.rescan();
        }
      }
    ).open();
  }

  private openInstallFromGitHub(preferredToolId?: string) {
    new InstallFromGitHubModal(
      this.app,
      this.getSettings(),
      this.getAllProjects(),
      this.store,
      () => this.rescan(),
      undefined,
      undefined,
      undefined,
      undefined,
      preferredToolId
    ).open();
  }

  private openAddDiscoverSource() {
    new AddDiscoverSourceModal(
      this.app,
      this.getSettings(),
      this.saveSettings,
      (repoUrl, subpath) => this.isDiscoverEntryInstalled(repoUrl, subpath),
      () => this.render()
    ).open();
  }

  /** Matches a catalog/discovered item against this.items by exactly what InstallFromGitHubModal
   *  records at install time (sourceRepo + sourceSubpath) — used to keep Discover from showing an
   *  "install" card for something already sitting in the real library. */
  private isDiscoverEntryInstalled(repoUrl: string, subpath: string): boolean {
    return this.items.some((item) => item.sourceRepo === repoUrl && item.sourceSubpath === subpath);
  }

  /** Discover's true empty state (no sources added at all yet, not just "no search matches") —
   *  a real heading/description instead of one line of muted text, plus one-click "starter"
   *  suggestions (STARTER_DISCOVER_SOURCES) so there's something to click besides opening the
   *  blank "+ Add source" form cold. */
  private renderDiscoverEmptyState(container: HTMLElement) {
    const empty = container.createDiv({ cls: "skillmanager-empty-state" });
    const icon = empty.createDiv({ cls: "skillmanager-empty-state-icon" });
    setIcon(icon, "compass");
    empty.createEl("h3", { text: "Nothing here yet", cls: "skillmanager-empty-state-title" });
    empty.createEl("p", {
      cls: "skillmanager-empty-state-desc",
      text: "Add a GitHub repo to find the skills, agents, commands, and rules inside it.",
    });

    const addBtn = empty.createEl("button", { text: "Add your own repo", cls: "mod-cta" });
    addBtn.addEventListener("click", () => this.openAddDiscoverSource());

    empty.createEl("p", { cls: "skillmanager-discover-starters-label", text: "Or add one of these" });

    const starters = empty.createDiv({ cls: "skillmanager-discover-starters" });
    for (const source of STARTER_DISCOVER_SOURCES) {
      const pill = starters.createEl("button", { cls: "skillmanager-discover-starter" });
      setIcon(pill.createSpan({ cls: "skillmanager-discover-starter-icon" }), "github");
      const text = pill.createDiv({ cls: "skillmanager-discover-starter-text" });
      text.createSpan({ text: source.name, cls: "skillmanager-discover-starter-name" });
      text.createSpan({ text: source.description, cls: "skillmanager-discover-starter-desc" });
      pill.addEventListener("click", () => void this.addStarterDiscoverSource(source, pill));
    }
  }

  private async addStarterDiscoverSource(source: { name: string; repoUrl: string }, pill: HTMLButtonElement) {
    if (pill.disabled) return;
    pill.disabled = true;
    pill.addClass("is-loading");
    const nameEl = pill.querySelector<HTMLElement>(".skillmanager-discover-starter-name");
    const originalText = nameEl?.textContent ?? source.name;
    if (nameEl) nameEl.textContent = "Adding…";
    try {
      const { foundCount, skippedCount } = await addDiscoverSource(this.getSettings(), source.repoUrl, "", "", (repoUrl, subpath) =>
        this.isDiscoverEntryInstalled(repoUrl, subpath)
      );
      await this.saveSettings();
      new Notice(
        `Found ${foundCount} item${foundCount === 1 ? "" : "s"} in ${source.name}.` +
          (skippedCount > 0 ? ` (${skippedCount} already installed, not shown.)` : "")
      );
      this.render();
    } catch (e) {
      new Notice(`Couldn't add "${source.name}": ` + errorMessage(e));
      pill.disabled = false;
      pill.removeClass("is-loading");
      if (nameEl) nameEl.textContent = originalText;
    }
  }

  /** The one choke point every sidebar nav row calls before setting its own filter (see
   *  renderSidebar/renderTypesSection/renderToolsSection/renderProjectsSection/
   *  renderPluginsSection/renderCollectionsSection) — so jumping to a different scope from the
   *  sidebar always lands on that scope's fresh list, closing out whatever card + file preview
   *  happened to be docked open rather than leaving it stuck there until the user manually clicks
   *  "Library" in the breadcrumb. Mirrors backToLibrary()'s reset. */
  private clearScopeFilters() {
    this.typeFilter = null;
    this.toolFilter = null;
    this.pageToolFilter = null;
    this.pageTypeFilter = null;
    this.pageScopeFilter = null;
    this.collectionFilter = null;
    this.projectFilter = null;
    this.pluginFilter = null;
    this.favoritesOnly = false;
    this.discoverMode = false;
    this.selectedDiscoverEntry = null;
    this.toolsMode = false;
    this.selectedTool = null;
    this.dashboardMode = false;
    this.pluginBundlesMode = false;
    this.detailReturnsToDashboard = false;
    this.mcpMode = false;
    this.mcpToolFilter = null;
    this.selectedMcpServer = null;
    this.revealedMcpEnvKeys = new Set();
    this.cleanupReview();
    this.selectedItem = null;
    this.selectedFilePath = null;
    this.detailLoadedFor = null;
    this.addingTagFor = null;
  }

  private isScoped(): boolean {
    return !!(
      this.typeFilter ||
      this.toolFilter ||
      this.collectionFilter ||
      this.projectFilter ||
      this.pluginFilter ||
      this.favoritesOnly ||
      this.discoverMode ||
      this.toolsMode ||
      this.dashboardMode ||
      this.mcpMode ||
      this.pluginBundlesMode
    );
  }

  /** In-page filters layered on top of the sidebar scope: everything the "Clear filters" button
   *  resets. Search isn't included; it has its own clear button and is shown separately. */
  private activeFilterLabels(): string[] {
    const labels: string[] = [];
    if (this.enabledFilter !== "all") labels.push(this.enabledFilter === "enabled" ? "Enabled only" : "Disabled only");
    if (this.tagFilter) labels.push(`Tag: ${this.tagFilter}`);
    if (this.untaggedOnly) labels.push("Untagged");
    if (this.sourceFilter) labels.push(SOURCE_FILTER_LABELS[this.sourceFilter]);
    if (this.ruleKindFilter) labels.push(RULE_KIND_LABELS[this.ruleKindFilter]);
    if (this.pageToolFilter) {
      labels.push(this.getSettings().tools.find((t) => t.id === this.pageToolFilter)?.name ?? "One tool");
    }
    if (this.pageTypeFilter) labels.push(TYPE_CATEGORY_LABELS[this.pageTypeFilter]);
    if (this.pageScopeFilter) labels.push(this.scopeFilterLabel(this.pageScopeFilter));
    return labels;
  }

  private clearFilters() {
    this.enabledFilter = "all";
    this.tagFilter = null;
    this.untaggedOnly = false;
    this.sourceFilter = null;
    this.ruleKindFilter = null;
    this.pageToolFilter = null;
    this.pageTypeFilter = null;
    this.pageScopeFilter = null;
    this.tagbarScrollLeft = 0;
  }

  private filteredItems(): ItemMetadata[] {
    return this.sortItems(this.items.filter((item) => this.matchesFilters(item)));
  }

  /** Every sidebar scope and page filter, except the Filter-menu dimension named in `ignore` —
   *  that's how the menu counts what each option would show if picked (see renderFilterButton). */
  private matchesFilters(item: ItemMetadata, ignore?: FilterDimension): boolean {
    const query = this.search.trim().toLowerCase();
    // Baseline, not a togglable filter (unlike everything below) — a disabled tool's items
    // never show in the main grid, same spirit as enabledFilter already being separate from
    // the scope-filter group. this.items itself stays the full set (rescan.ts deliberately
    // doesn't drop them, to keep their shadow-note metadata alive across a disable/re-enable),
    // so the "All tools" page can still read true per-tool counts straight off this.items.
    if (this.isToolDisabled(item.tool)) return false;
    if (this.enabledFilter === "enabled" && !item.enabled) return false;
    if (this.enabledFilter === "disabled" && item.enabled) return false;
    if (this.favoritesOnly && !item.favorite) return false;
    if (this.typeFilter && item.type !== this.typeFilter) return false;
    if (this.toolFilter && item.tool !== this.toolFilter) return false;
    if (ignore !== "type" && this.pageTypeFilter && item.type !== this.pageTypeFilter) return false;
    if (ignore !== "tool" && this.pageToolFilter && item.tool !== this.pageToolFilter) return false;
    if (this.collectionFilter && !item.collections.includes(this.collectionFilter)) return false;
    if (this.projectFilter && item.projectId !== this.projectFilter) return false;
    if (ignore !== "scope" && this.pageScopeFilter && !this.projectFilter && this.scopeKeyOf(item) !== this.pageScopeFilter) return false;
    if (this.pluginFilter && item.pluginId !== this.pluginFilter) return false;
    if (ignore !== "kind" && this.ruleKindFilter && item.type === "rule" && this.ruleKindOf(item) !== this.ruleKindFilter) return false;
    if (ignore !== "source") {
      if (this.sourceFilter === "github" && !item.sourceRepo) return false;
      if (this.sourceFilter === "builtin" && !this.isBuiltIn(item)) return false;
      if (this.sourceFilter === "local" && (item.sourceRepo || this.isBuiltIn(item))) return false;
    }
    if (this.untaggedOnly && item.tags.length > 0) return false;
    if (this.tagFilter && !item.tags.includes(this.tagFilter)) return false;
    if (query) {
      const haystack = `${item.name} ${item.description}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  }

  private scopeKeyOf(item: ItemMetadata): string {
    return item.projectId ?? "global";
  }

  private scopeFilterLabel(key: string): string {
    if (key === "global") return "Global";
    return this.getAllProjects().find((p) => p.id === key)?.name ?? "Workspace";
  }

  private sortItems(items: ItemMetadata[]): ItemMetadata[] {
    const sorted = [...items];
    switch (this.sortOrder) {
      case "name-asc":
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "name-desc":
        sorted.sort((a, b) => b.name.localeCompare(a.name));
        break;
      case "modified-desc":
        sorted.sort((a, b) => this.itemModifiedMs(b) - this.itemModifiedMs(a));
        break;
      case "modified-asc":
        sorted.sort((a, b) => this.itemModifiedMs(a) - this.itemModifiedMs(b));
        break;
      case "usage-desc":
      case "last-used-desc": {
        // Items with no usage signal at all (other tools, commands, rules) sink below everything
        // that has one, then fall back to name order among themselves.
        const recency = this.sortOrder === "last-used-desc";
        // "Most used" ranks by the same session count the list view's Sessions column shows, so
        // sorting by that column never disagrees with the numbers in it.
        const score = (item: ItemMetadata) => {
          if (!this.usageHistoryKey(item)) return -1;
          return recency ? (this.lastUsedMs(item) ?? -1) : (this.sessionCount(item) ?? -1);
        };
        const scores = new Map(sorted.map((item) => [item.entryId, score(item)]));
        sorted.sort((a, b) => (scores.get(b.entryId) ?? -1) - (scores.get(a.entryId) ?? -1) || a.name.localeCompare(b.name));
        break;
      }
    }
    return sorted;
  }

  /** Usage for a Claude Code or Codex skill/agent, or null when the item has no usage signal
   *  (or it's still loading). Kicks off the transcript scan the first time it's needed. */
  private usageStatsFor(item: ItemMetadata): ClaudeUsageStats | null {
    if (item.type !== "skill" && item.type !== "agent") return null;
    if (item.tool === "claude-code") return this.getClaudeUsage()?.get(item.entryId) ?? null;
    if (item.tool === "codex") return this.getCodexUsage()?.get(item.entryId) ?? null;
    return null;
  }

  /** Sessions over the heatmap window, from the saved history, or null for an item with no usage
   *  signal. Starts the transcript scan the first time it's needed, so the history is current. */
  private sessionCount(item: ItemMetadata): number | null {
    const key = this.usageHistoryKey(item);
    if (!key) return null;
    this.usageStatsFor(item);
    return buildHeatmap(this.getSettings().usageHistory?.[key] ?? {}).total;
  }

  /** Most recent use from either the live transcripts or the saved history; 0 means never, null
   *  means the item has no usage signal at all. */
  private lastUsedMs(item: ItemMetadata): number | null {
    if (!this.usageHistoryKey(item)) return null;
    return Math.max(this.usageStatsFor(item)?.lastUsedMs ?? 0, this.lastHistoryDayMs(item));
  }

  /** Latest day in the saved heatmap history, so "Recently used" still knows about use whose
   *  transcript the tool has since deleted. */
  private lastHistoryDayMs(item: ItemMetadata): number {
    const key = this.usageHistoryKey(item);
    const days = key ? Object.keys(this.getSettings().usageHistory?.[key] ?? {}) : [];
    if (days.length === 0) return 0;
    const [y, m, d] = days.sort()[days.length - 1].split("-").map(Number);
    return new Date(y, m - 1, d).getTime();
  }

  private itemModifiedMs(item: ItemMetadata): number {
    try {
      return statSync(item.sourcePath).mtimeMs;
    } catch {
      return 0;
    }
  }

  private scopeTitle(): string {
    const settings = this.getSettings();
    if (this.collectionFilter) {
      return settings.collections.find((c) => c.id === this.collectionFilter)?.name ?? "Collection";
    }
    if (this.typeFilter) return TYPE_CATEGORY_LABELS[this.typeFilter];
    if (this.toolFilter) {
      return settings.tools.find((t) => t.id === this.toolFilter)?.name ?? "Tool";
    }
    if (this.projectFilter) {
      return this.getAllProjects().find((p) => p.id === this.projectFilter)?.name ?? "Project";
    }
    if (this.pluginFilter) {
      return this.discoveredPlugins.find((p) => p.id === this.pluginFilter)?.name ?? "Plugin";
    }
    if (this.favoritesOnly) return "Favourites";
    return "All";
  }

  private scopeDescription(): string {
    const settings = this.getSettings();
    if (this.collectionFilter) {
      return "A curated bundle of skills, agents, and commands you can enable or disable together.";
    }
    if (this.typeFilter) {
      const descriptions: Record<ItemType, string> = {
        skill: "Reusable capabilities your AI tools can invoke on demand.",
        agent: "Specialized sub-agents your tools can delegate tasks to.",
        command: "Slash commands and prompts your tools expose directly.",
        rule: "Standing instructions your tools always apply: either one instructions file loaded every session (CLAUDE.md-style) or a directory of many individually-applied rule files.",
      };
      return descriptions[this.typeFilter];
    }
    if (this.toolFilter) {
      const tool = settings.tools.find((t) => t.id === this.toolFilter);
      return tool?.id === "global"
        ? "Shared across every tool via ~/.agents/skills. Projects symlink into this instead of keeping their own copy."
        : `Everything found in ${tool?.name ?? "this tool"}'s configured directories.`;
    }
    if (this.projectFilter) {
      return this.projectFilter === VAULT_PROJECT_ID
        ? "Skills scoped to this vault's own project-local folders, symlinked in from your shared library."
        : "Skills scoped to this project's local folders, symlinked in from your shared library.";
    }
    if (this.pluginFilter) {
      return "Bundled with this installed plugin, as its own package, separate from your tool's global directories.";
    }
    if (this.favoritesOnly) return "Items you've starred for quick access.";
    return "Every skill, agent, command, and rule across your configured tools and projects.";
  }

  /** How many workspaces beyond the vault are currently tracked — every scanner (skills, agents,
   *  commands, rules, MCP servers) only looks at the vault plus these, plus every tool's own
   *  global directories, never the whole disk, so this number is what actually controls how much
   *  of a given project shows up anywhere in the plugin. */
  private workspaceCount(): number {
    return this.getSettings().projectWorkspaces.length;
  }

  /** Shared prose for the tooltip/banner/menu copy below — kept in one place so "vault + global,
   *  add a workspace for project-scoped stuff" is worded identically everywhere it appears.
   *  Deliberately doesn't say "only this vault": global tool directories (~/.claude/skills,
   *  ~/.claude.json's global mcpServers, etc.) are scanned regardless of workspaces, so saying
   *  "only" undersold what's already covered. */
  private workspaceScopeTooltip(): string {
    const extra = this.workspaceCount();
    return extra === 0
      ? "Scanning this vault and every tool's own global skills, agents, and MCP servers. Add a workspace to also include a project's own."
      : `Scanning this vault, ${extra} tracked workspace${extra === 1 ? "" : "s"}, and every tool's own global skills, agents, and MCP servers.`;
  }

  /** True while the one-time banner (see renderWorkspaceBanner) should show instead of the quiet
   *  header chip (renderWorkspaceChip) — callers place each at the right spot themselves (the
   *  banner belongs after the subtitle in the header; the chip belongs inline in the title row,
   *  before any page-specific filter button), so this only decides which one, not where. The
   *  persistent, always-on signal lives in the sidebar regardless of this (see
   *  renderProjectsSection's heading badge and the "All"/"MCP servers" nav row tooltips, both
   *  driven by workspaceScopeTooltip) — this is just the one-time nudge on top of that. */
  private showWorkspaceBanner(): boolean {
    return this.workspaceCount() === 0 && !this.getSettings().workspaceHintDismissed;
  }

  private renderWorkspaceBanner(container: HTMLElement) {
    const banner = container.createDiv({ cls: "skillmanager-workspace-banner" });
    const icon = banner.createSpan({ cls: "skillmanager-workspace-banner-icon" });
    setIcon(icon, "info");
    const body = banner.createDiv({ cls: "skillmanager-workspace-banner-body" });
    body.createDiv({
      text: "Also scanning every tool's global skills, agents, and MCP servers",
      cls: "skillmanager-workspace-banner-title",
    });
    body.createDiv({
      text: "This vault, and each tool's own global directories, are already covered. Add a project folder as a workspace to bring in its own skills, agents, and MCP servers too.",
      cls: "skillmanager-workspace-banner-desc",
    });
    const addBtn = body.createEl("button", { cls: "mod-cta skillmanager-workspace-banner-add", text: "+ Add workspace" });
    addBtn.addEventListener("click", () => {
      new ProjectEditModal(this.app, null, (project) => this.upsertProject(project)).open();
    });
    const closeBtn = banner.createEl("button", {
      cls: "skillmanager-icon-btn skillmanager-workspace-banner-close",
      attr: { "aria-label": "Dismiss" },
    });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", () => void this.dismissWorkspaceBanner());
  }

  private async dismissWorkspaceBanner() {
    this.getSettings().workspaceHintDismissed = true;
    await this.saveSettings();
    this.render();
  }

  private renderWorkspaceChip(container: HTMLElement) {
    const extra = this.workspaceCount();
    const label = extra === 0 ? "Vault only" : `${extra} workspace${extra === 1 ? "" : "s"}`;
    const chip = container.createEl("button", { cls: "skillmanager-workspace-chip", attr: { title: this.workspaceScopeTooltip() } });
    const chipIcon = chip.createSpan({ cls: "skillmanager-workspace-chip-icon" });
    setIcon(chipIcon, "folder-git-2");
    chip.createSpan({ text: label });
    chip.addEventListener("click", (evt) => this.openWorkspaceScopeMenu(evt));
  }

  /** Every tracked location listed for reference (not clickable — this menu is about visibility
   *  and adding one, not navigation), plus the one real action. */
  private openWorkspaceScopeMenu(evt: MouseEvent) {
    const menu = new Menu();
    for (const project of this.getAllProjects()) {
      const count = this.items.filter((i) => i.projectId === project.id).length;
      menu.addItem((menuItem) =>
        menuItem
          .setTitle(`${project.name} (${count})`)
          .setIcon(projectIcon(project.id))
          .setDisabled(true)
      );
    }
    menu.addSeparator();
    menu.addItem((menuItem) =>
      menuItem.setTitle("Add workspace…").setIcon("plus").onClick(() => {
        new ProjectEditModal(this.app, null, (project) => this.upsertProject(project)).open();
      })
    );
    menu.showAtMouseEvent(evt);
  }

  private render() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("skillmanager-view");

    this.renderSidebar(container.createDiv({ cls: "skillmanager-sidebar" }));
    this.renderContent(container.createDiv({ cls: "skillmanager-content" }));
  }

  // ---------- sidebar ----------

  private renderSidebar(sidebar: HTMLElement) {
    const brand = sidebar.createDiv({ cls: "skillmanager-brand" });
    const brandLeft = brand.createDiv({ cls: "skillmanager-brand-left" });
    const brandIcon = brandLeft.createSpan({ cls: "skillmanager-brand-icon" });
    setIcon(brandIcon, PLUGIN_ICON_ID);
    brandLeft.createSpan({ text: "AI Skills Manager", cls: "skillmanager-brand-name" });

    const installBtn = brand.createEl("button", {
      cls: "skillmanager-icon-btn skillmanager-install-btn",
      attr: { "aria-label": "Install from GitHub" },
    });
    setIcon(installBtn, "plus");
    installBtn.addEventListener("click", () => this.openInstallFromGitHub());

    // Library — always first, not reorderable.
    sidebar.createDiv({ cls: "skillmanager-sidebar-heading", text: "Library" });
    this.renderNavRow(
      sidebar,
      "library",
      "All",
      this.items.length,
      !this.isScoped(),
      () => {
        this.clearScopeFilters();
        this.render();
      },
      undefined,
      false,
      "default",
      undefined,
      false,
      this.workspaceScopeTooltip()
    );
    this.renderNavRow(sidebar, "star", "Favourites", this.items.filter((i) => i.favorite).length, this.favoritesOnly, () => {
      this.clearScopeFilters();
      this.favoritesOnly = true;
      this.render();
    });
    this.renderNavRow(sidebar, "compass", "Discover", this.getSettings().discoverCatalog.length, this.discoverMode, () => {
      this.clearScopeFilters();
      this.discoverMode = true;
      this.render();
    });
    this.renderInsightsSection(sidebar);

    const sectionRenderers: Record<string, (sidebar: HTMLElement) => void> = {
      types: (s) => this.renderTypesSection(s),
      tools: (s) => this.renderToolsSection(s),
      extensions: (s) => this.renderExtensionsSection(s),
      projects: (s) => this.renderProjectsSection(s),
      collections: (s) => this.renderCollectionsSection(s),
    };
    for (const key of this.getSettings().sectionOrder) {
      if (this.isSectionVisible(key)) sectionRenderers[key]?.(sidebar);
    }

    const footer = sidebar.createDiv({ cls: "skillmanager-sidebar-footer" });
    this.renderNavRow(
      footer,
      "refresh-cw",
      "Rescan tools",
      null,
      false,
      () => void this.manualRescan(),
      undefined,
      this.rescanningManually,
      "default",
      "skillmanager-nav-item-accent"
    );

    this.wireSectionDragTargets(sidebar);
  }

  /** Delegated dragover/drop for section reordering, registered once per sidebar render rather
   *  than per heading. Each heading only needs to start its own drag (see
   *  renderCollapsibleHeading) — figuring out which heading is currently under the cursor, and
   *  updating the drop-target highlight, is handled centrally here instead, so it can't end up
   *  direction-dependent the way duplicated per-heading listeners did. */
  private wireSectionDragTargets(sidebar: HTMLElement) {
    const headingAt = (evt: DragEvent) =>
      (evt.target as HTMLElement).closest<HTMLElement>(".skillmanager-sidebar-heading-collapsible");

    sidebar.addEventListener("dragover", (evt) => {
      const target = headingAt(evt);
      const targetKey = target?.dataset.sectionKey;
      if (!this.draggedSectionKey || !target || !targetKey || targetKey === this.draggedSectionKey) return;
      evt.preventDefault();
      if (evt.dataTransfer) evt.dataTransfer.dropEffect = "move";
      if (this.dragHighlightEl && this.dragHighlightEl !== target) {
        this.dragHighlightEl.removeClass("is-drop-target");
      }
      target.addClass("is-drop-target");
      this.dragHighlightEl = target;
    });

    sidebar.addEventListener("dragleave", (evt) => {
      if (sidebar.contains(evt.relatedTarget as Node | null)) return; // moved to a child, not out
      this.dragHighlightEl?.removeClass("is-drop-target");
      this.dragHighlightEl = null;
    });

    sidebar.addEventListener("drop", (evt) => {
      const target = headingAt(evt);
      this.dragHighlightEl?.removeClass("is-drop-target");
      this.dragHighlightEl = null;
      const draggedKey = this.draggedSectionKey;
      const targetKey = target?.dataset.sectionKey;
      this.draggedSectionKey = null;
      if (!draggedKey || !targetKey || draggedKey === targetKey) return;
      evt.preventDefault();
      void this.moveSectionBefore(draggedKey, targetKey);
    });
  }

  private isSectionVisible(key: string): boolean {
    if (key === "extensions") return this.mcpServers.length > 0 || this.discoveredPlugins.length > 0;
    return true;
  }

  /** Fixed under Library rather than one of the reorderable sections: it's navigation, not a
   *  filter over this.items, so it collapses but doesn't drag. Health counts what's broken (red); Cleanup counts judgment calls
   *  (muted), so the two never read as equally urgent. */
  private renderInsightsSection(sidebar: HTMLElement) {
    if (!this.renderCollapsibleHeading(sidebar, "insights", "Insights", undefined, undefined, false)) return;
    const counts = this.getInsightsCounts();
    for (const { page, label, icon } of INSIGHTS_PAGES) {
      const count = page === "health" ? counts.health : page === "cleanup" ? counts.cleanup : 0;
      this.renderNavRow(
        sidebar,
        icon,
        label,
        count > 0 ? count : null,
        this.dashboardMode && this.insightsPage === page,
        () => this.openInsightsPage(page),
        undefined,
        false,
        page === "health" ? "danger" : "default"
      );
    }
  }

  /** Entering Insights from anywhere else starts fresh: a disk rescan (so an item added or edited
   *  straight on disk shows up in prune/overlap stats right away, not only after "Rescan tools")
   *  and a fresh usage scan. Hopping between Insights pages keeps all of that, so it's instant. */
  private openInsightsPage(page: InsightsPage) {
    const entering = !this.dashboardMode;
    this.dashboardScrollTop = 0;
    this.insightsPage = page;
    if (!entering) {
      this.render();
      return;
    }
    this.clearScopeFilters();
    this.dashboardMode = true;
    this.claudeUsage = null;
    this.claudeUsageLoading = false;
    this.codexUsage = null;
    this.codexUsageLoading = false;
    this.dashboardActiveTool = null;
    this.dashboardTypeFilter = null;
    // rescan() already nulls dashboardMetrics/insightsCounts and re-renders.
    void this.rescan();
  }

  private renderExtensionsSection(sidebar: HTMLElement) {
    if (!this.renderCollapsibleHeading(sidebar, "extensions", "Extensions")) return;
    if (this.mcpServers.length > 0) {
      this.renderNavRow(
        sidebar,
        "plug",
        "MCP servers",
        this.mcpServers.length,
        this.mcpMode,
        () => {
          this.clearScopeFilters();
          this.mcpMode = true;
          this.render();
        },
        undefined,
        false,
        "default",
        undefined,
        false,
        this.workspaceScopeTooltip()
      );
    }
    if (this.discoveredPlugins.length > 0) {
      this.renderNavRow(
        sidebar,
        "package",
        "Plugin bundles",
        this.discoveredPlugins.length,
        this.pluginBundlesMode,
        () => {
          this.clearScopeFilters();
          this.pluginBundlesMode = true;
          this.pluginBundleSearch = "";
          this.pluginBundleToolFilter = null;
          this.pluginBundleGroupFilter = null;
          this.pluginBundleTagFilter = null;
          this.render();
        },
        undefined,
        false,
        "default",
        undefined,
        false,
        "Installed plugin bundles, browsed separately from individual skills."
      );
    }
  }

  private renderTypesSection(sidebar: HTMLElement) {
    if (!this.renderCollapsibleHeading(sidebar, "types", "Types")) return;
    for (const type of Object.keys(TYPE_LABELS) as ItemType[]) {
      const count = this.items.filter((i) => i.type === type).length;
      this.renderNavRow(sidebar, TYPE_ICONS[type], TYPE_CATEGORY_LABELS[type], count, this.typeFilter === type, () => {
        this.clearScopeFilters();
        this.typeFilter = this.typeFilter === type ? null : type;
        this.render();
      });
    }
  }

  private renderToolsSection(sidebar: HTMLElement) {
    if (!this.renderCollapsibleHeading(sidebar, "tools", "Tools")) return;
    const settings = this.getSettings();
    this.renderNavRow(sidebar, "layout-grid", "All tools", settings.tools.length, this.toolsMode, () => {
      this.clearScopeFilters();
      this.toolsMode = true;
      this.render();
    });
    const showEmpty = settings.showEmptySidebarRows;
    for (const tool of this.getSettings().tools) {
      const count = this.items.filter((i) => i.tool === tool.id).length;
      if (!showEmpty && count === 0) continue;
      this.renderNavRow(
        sidebar,
        tool.icon,
        tool.name,
        count,
        this.toolFilter === tool.id,
        () => {
          this.clearScopeFilters();
          this.toolFilter = this.toolFilter === tool.id ? null : tool.id;
          this.render();
        },
        tool.svgIcon
      );
    }
  }

  private renderProjectsSection(sidebar: HTMLElement) {
    const total = this.getAllProjects().length;
    const expanded = this.renderCollapsibleHeading(
      sidebar,
      "projects",
      "Workspaces",
      (actionWrap) => {
        const addBtn = actionWrap.createEl("button", { cls: "skillmanager-icon-btn", attr: { "aria-label": "New workspace" } });
        setIcon(addBtn, "plus");
        addBtn.addEventListener("click", (evt) => {
          evt.stopPropagation();
          new ProjectEditModal(this.app, null, (project) => this.upsertProject(project)).open();
        });
      },
      // Persistent signal (visible whether this section is expanded or collapsed, unlike the
      // one-time banner/chip in the content pane) that scanning covers more than just the vault
      // once a workspace is tracked — see workspaceScopeTooltip. Sits right next to the
      // "Workspaces" label itself, not over by the "+" button.
      { text: total === 1 ? "1 vault" : `${total} tracked`, tooltip: this.workspaceScopeTooltip() }
    );
    if (!expanded) return;

    const showEmpty = this.getSettings().showEmptySidebarRows;
    const projects = this.getAllProjects();
    for (const project of projects) {
      const count = this.items.filter((i) => i.projectId === project.id).length;
      if (!showEmpty && count === 0 && project.id !== VAULT_PROJECT_ID) continue;

      const row = sidebar.createDiv({ cls: "skillmanager-nav-item" });
      if (this.projectFilter === project.id) row.addClass("is-active");
      const iconEl = row.createSpan({ cls: "skillmanager-nav-icon" });
      setIcon(iconEl, projectIcon(project.id));
      row.createSpan({ text: project.name, cls: "skillmanager-nav-label" });
      row.createSpan({ text: String(count), cls: "skillmanager-nav-count" });

      if (project.id !== VAULT_PROJECT_ID) {
        const actions = row.createDiv({ cls: "skillmanager-nav-actions" });
        const moreBtn = actions.createEl("button", { cls: "skillmanager-icon-btn", attr: { "aria-label": "More" } });
        setIcon(moreBtn, MORE_ICON_ID);
        moreBtn.addEventListener("click", (evt) => {
          evt.stopPropagation();
          const menu = new Menu();
          menu.addItem((menuItem) =>
            menuItem
              .setTitle("Edit")
              .setIcon("pencil")
              .onClick(() => new ProjectEditModal(this.app, project, (updated) => this.upsertProject(updated)).open())
          );
          menu.addItem((menuItem) =>
            menuItem
              .setTitle("Remove")
              .setIcon("trash-2")
              .setWarning(true)
              .onClick(() => void this.deleteProject(project))
          );
          menu.showAtMouseEvent(evt);
        });
      }

      row.addEventListener("click", () => {
        this.clearScopeFilters();
        this.projectFilter = this.projectFilter === project.id ? null : project.id;
        this.render();
      });
    }
    if (projects.length <= 1) {
      sidebar.createDiv({
        cls: "skillmanager-sidebar-empty",
        text: "No extra workspaces yet. Add one to scan its own skills, agents, and MCP servers too.",
      });
    }
  }

  private renderPluginsSection(sidebar: HTMLElement) {
    if (!this.renderCollapsibleHeading(sidebar, "plugins", "Plugins")) return;
    const showEmpty = this.getSettings().showEmptySidebarRows;
    for (const plugin of this.discoveredPlugins) {
      const count = this.items.filter((i) => i.pluginId === plugin.id).length;
      // Some plugins (e.g. a language-server integration) contribute no skill/agent/command/rule
      // content at all, not just "none scanned yet" — same "don't pad the sidebar with rows that
      // always read 0" reasoning Tools/Projects already apply, just missing here until now.
      if (!showEmpty && count === 0) continue;

      const row = sidebar.createDiv({ cls: "skillmanager-nav-item" });
      if (this.pluginFilter === plugin.id) row.addClass("is-active");
      if (!plugin.enabled) row.addClass("is-off");
      const iconEl = row.createSpan({ cls: "skillmanager-nav-icon" });
      this.renderIcon(iconEl, "package");
      row.createSpan({ text: plugin.name, cls: "skillmanager-nav-label" });
      row.createSpan({ text: String(count), cls: "skillmanager-nav-count" });
      row.addEventListener("click", () => {
        this.clearScopeFilters();
        this.pluginFilter = this.pluginFilter === plugin.id ? null : plugin.id;
        this.render();
      });

      // Per-item toggling is blocked for a plugin's own cards (see renderCard) since the tool
      // has no concept of disabling one skill inside a plugin — this whole-plugin toggle is the
      // real, supported equivalent, same slot Collections uses for its own toggle.
      const tool = this.getSettings().tools.find((t) => t.id === plugin.toolId);
      if (tool?.pluginsSettingsPath) {
        const actions = row.createDiv({ cls: "skillmanager-nav-actions" });
        const toggle = actions.createEl("button", {
          cls: `skillmanager-toggle skillmanager-toggle-sm${plugin.enabled ? " is-on" : ""}`,
          attr: { "aria-label": plugin.enabled ? "Disable this plugin" : "Enable this plugin" },
        });
        toggle.addEventListener("click", (evt) => {
          evt.stopPropagation();
          this.explainPluginBundleToggle(plugin);
        });
      }
    }
  }

  private async togglePlugin(tool: ToolConfig, plugin: PluginSource) {
    try {
      togglePluginEnabled(tool, plugin.id, plugin.enabled);
    } catch (e) {
      new Notice(`Couldn't toggle "${plugin.name}": ` + errorMessage(e));
      return;
    }
    await this.rescan();
  }

  /** A plugin card's toggle click lands here instead of toggleEnabled — same "explain, don't
   *  pretend it worked" reasoning as itemToggle.ts's guards, just surfaced as a modal since a
   *  thrown error from a click handler would otherwise only ever show as a terse Notice. */
  private explainPluginToggle(item: ItemMetadata) {
    const plugin = this.discoveredPlugins.find((p) => p.id === item.pluginId);
    const tool = plugin ? this.getSettings().tools.find((t) => t.id === plugin.toolId) : undefined;
    if (!plugin || !tool) return;
    new PluginItemInfoModal(
      this.app,
      item,
      plugin,
      tool,
      tool.pluginsSettingsPath ? () => this.togglePlugin(tool, plugin) : undefined,
      plugin.repoUrl ? () => this.installPluginItemStandalone(item, plugin) : undefined
    ).open();
  }

  private explainPluginBundleToggle(plugin: PluginSource) {
    const tool = this.pluginBundleTool(plugin);
    if (!tool) return;
    new PluginItemInfoModal(
      this.app,
      null,
      plugin,
      tool,
      tool.pluginsSettingsPath ? () => this.togglePlugin(tool, plugin) : undefined,
      undefined,
      plugin.repoUrl ? () => this.openPluginRepoInDiscover(plugin) : undefined
    ).open();
  }

  /** Reopens a known plugin repository through Discover so users can browse its contents and
   *  install selected skills/agents as independently managed copies. */
  private openPluginRepoInDiscover(plugin: PluginSource) {
    if (!plugin.repoUrl) return;
    new AddDiscoverSourceModal(
      this.app,
      this.getSettings(),
      this.saveSettings,
      (repoUrl, subpath) => this.isDiscoverEntryInstalled(repoUrl, subpath),
      () => {
        this.clearScopeFilters();
        this.discoverMode = true;
        this.render();
      },
      plugin.repoUrl
    ).open();
  }

  /** Prefills the real install pipeline with the plugin's own repo and the item's path relative
   *  to the plugin's install root — the same relative layout the repo itself uses, since the
   *  plugin's install directory IS a clone of that repo (confirmed against a real Claude Code
   *  plugin install). Always lands at global scope (lockToGlobal): a standalone copy escaping a
   *  plugin boundary is exactly the "Add to another tool…" case, not a one-project duplicate. */
  private installPluginItemStandalone(item: ItemMetadata, plugin: PluginSource) {
    if (!plugin.repoUrl) return;
    const unitPath = linkableUnit(item.sourcePath).path;
    const subpath = relative(plugin.path, unitPath).split(sep).join("/");
    new InstallFromGitHubModal(
      this.app,
      this.getSettings(),
      this.getAllProjects(),
      this.store,
      () => this.rescan(),
      { repoUrl: plugin.repoUrl, ref: "", subpath, type: item.type },
      undefined,
      undefined,
      true,
      item.tool
    ).open();
  }

  private renderCollectionsSection(sidebar: HTMLElement) {
    const settings = this.getSettings();
    const expanded = this.renderCollapsibleHeading(sidebar, "collections", "Collections", (actionWrap) => {
      const addBtn = actionWrap.createEl("button", { cls: "skillmanager-icon-btn", attr: { "aria-label": "New collection" } });
      setIcon(addBtn, "plus");
      addBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        new CollectionEditModal(this.app, null, this.items, (collection) => this.upsertCollection(collection)).open();
      });
    });
    if (!expanded) return;

    if (settings.collections.length === 0) {
      sidebar.createDiv({ cls: "skillmanager-sidebar-empty", text: "No collections yet" });
    }

    for (const collection of settings.collections) {
      const row = sidebar.createDiv({ cls: "skillmanager-nav-item" });
      const icon = row.createSpan({ cls: "skillmanager-nav-icon" });
      setIcon(icon, "folder");
      row.createSpan({ text: collection.name, cls: "skillmanager-nav-label" });
      if (this.collectionFilter === collection.id) row.addClass("is-active");

      const actions = row.createDiv({ cls: "skillmanager-nav-actions" });

      const moreBtn = actions.createEl("button", { cls: "skillmanager-icon-btn", attr: { "aria-label": "More" } });
      setIcon(moreBtn, MORE_ICON_ID);
      moreBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        const menu = new Menu();
        menu.addItem((menuItem) =>
          menuItem
            .setTitle("Edit")
            .setIcon("pencil")
            .onClick(() => new CollectionEditModal(this.app, collection, this.items, (updated) => this.upsertCollection(updated)).open())
        );
        menu.addItem((menuItem) =>
          menuItem
            .setTitle("Delete")
            .setIcon("trash-2")
            .setWarning(true)
            .onClick(() => void this.deleteCollection(collection))
        );
        menu.showAtMouseEvent(evt);
      });

      row.addEventListener("click", () => {
        const next = this.collectionFilter === collection.id ? null : collection.id;
        this.clearScopeFilters();
        this.collectionFilter = next;
        this.render();
      });
    }
  }

  private renderCollapsibleHeading(
    sidebar: HTMLElement,
    key: string,
    title: string,
    renderAction?: (container: HTMLElement) => void,
    titleBadge?: { text: string; tooltip?: string },
    reorderable = true
  ): boolean {
    const isCollapsed = this.collapsedSections.has(key);
    const heading = sidebar.createDiv({ cls: "skillmanager-sidebar-heading skillmanager-sidebar-heading-collapsible" });
    // No sectionKey means wireSectionDragTargets never treats it as a drop target either.
    if (reorderable) heading.dataset.sectionKey = key;

    const left = heading.createDiv({ cls: "skillmanager-sidebar-heading-left" });
    if (reorderable) left.setAttr("draggable", "true");
    const chevron = left.createSpan({ cls: "skillmanager-chevron" });
    setIcon(chevron, isCollapsed ? "chevron-right" : "chevron-down");
    left.createSpan({ text: title });
    if (titleBadge) {
      left.createSpan({
        cls: "skillmanager-sidebar-heading-badge",
        text: titleBadge.text,
        attr: titleBadge.tooltip ? { title: titleBadge.tooltip } : undefined,
      });
    }
    left.addEventListener("click", () => {
      if (isCollapsed) this.collapsedSections.delete(key);
      else this.collapsedSections.add(key);
      this.render();
    });

    // Grab handle is just the chevron+title; the drop target is the whole heading row (dropping
    // anywhere on it reorders it) — see wireSectionDragTargets for dragover/dragleave/drop,
    // handled once per sidebar via delegation rather than per heading.
    left.addEventListener("dragstart", (evt) => {
      this.draggedSectionKey = key;
      evt.dataTransfer?.setData("text/plain", key);
      if (evt.dataTransfer) evt.dataTransfer.effectAllowed = "move";
    });
    left.addEventListener("dragend", () => {
      this.draggedSectionKey = null;
      this.dragHighlightEl?.removeClass("is-drop-target");
      this.dragHighlightEl = null;
    });

    if (renderAction) {
      renderAction(heading.createDiv({ cls: "skillmanager-sidebar-heading-action" }));
    }

    return !isCollapsed;
  }

  private async moveSectionBefore(key: string, beforeKey: string) {
    const settings = this.getSettings();
    const order = [...settings.sectionOrder];
    const fromIndex = order.indexOf(key);
    if (fromIndex === -1) return;
    order.splice(fromIndex, 1);
    const targetIndex = order.indexOf(beforeKey);
    order.splice(targetIndex === -1 ? fromIndex : targetIndex, 0, key);
    settings.sectionOrder = order;
    await this.saveSettings();
    this.render();
  }

  private renderNavRow(
    parent: HTMLElement,
    icon: string,
    label: string,
    count: number | null,
    active: boolean,
    onClick: () => void,
    svgIcon?: string,
    spinning?: boolean,
    countVariant: "default" | "danger" = "default",
    extraCls?: string,
    dot?: boolean,
    tooltip?: string
  ) {
    const row = parent.createDiv({ cls: "skillmanager-nav-item" });
    if (extraCls) row.addClass(extraCls);
    if (active) row.addClass("is-active");
    if (tooltip) row.title = tooltip;
    const iconEl = row.createSpan({ cls: "skillmanager-nav-icon" });
    this.renderIcon(iconEl, icon, svgIcon);
    if (spinning) iconEl.addClass("is-syncing");
    row.createSpan({ text: label, cls: "skillmanager-nav-label" });
    if (count !== null) {
      const cls = countVariant === "danger" ? "skillmanager-nav-count-danger" : "skillmanager-nav-count";
      row.createSpan({ text: String(count), cls });
    } else if (dot) {
      // "Needs a look" indicator that doesn't compete with the label for attention the way a
      // number does — see getInsightsCounts's callers.
      row.createSpan({ cls: "skillmanager-nav-dot" });
    }
    row.addEventListener("click", onClick);
  }

  /** Obsidian's setIcon only knows its own Lucide set, which has no real brand logos — a tool
   *  can supply its own inline SVG instead, forced to white since these marks are typically
   *  drawn to sit on a colored badge, not blend into the muted icon color everything else uses. */
  private renderIcon(container: HTMLElement, icon: string, svgIcon?: string) {
    if (svgIcon) {
      container.empty();
      const parsed = new DOMParser().parseFromString(svgIcon, "image/svg+xml").documentElement;
      container.appendChild(parsed);
    } else {
      setIcon(container, icon);
    }
  }

  private sourceLabel(item: ItemMetadata) {
    return resolveSourceLabel(item, this.getSettings(), this.getAllProjects(), this.discoveredPlugins);
  }

  private toolLabel(item: ItemMetadata) {
    return resolveToolLabel(item, this.getSettings(), this.discoveredPlugins);
  }

  private originLabel(item: ItemMetadata) {
    return resolveOriginLabel(item, this.getAllProjects());
  }

  private isBuiltIn(item: ItemMetadata): boolean {
    const tool = this.getSettings().tools.find((t) => t.id === item.tool);
    return isBuiltInPath(item.sourcePath, tool);
  }

  private isToolDisabled(toolId: string): boolean {
    return !!this.getSettings().tools.find((t) => t.id === toolId)?.disabled;
  }

  private isSingleFileRuleTool(toolId: string): boolean {
    return !!this.getSettings().tools.find((t) => t.id === toolId)?.singleFileRule;
  }

  private isMemory(item: ItemMetadata): boolean {
    return item.type === "rule" && isMemoryItem(item, this.getSettings().tools.find((t) => t.id === item.tool), this.getAllProjects());
  }

  private ruleKindOf(item: ItemMetadata): RuleKind {
    if (this.isMemory(item)) return "memory";
    return this.isSingleFileRuleTool(item.tool) ? "instructions" : "granular";
  }

  /** TYPE_LABEL_SINGULAR, except a memory reads as "Memory" rather than "Rule" wherever one
   *  item is labeled, so agent-written files stand apart from rules the user wrote. */
  private itemTypeLabel(item: ItemMetadata): string {
    return this.isMemory(item) ? "Memory" : TYPE_LABEL_SINGULAR[item.type];
  }

  private syncStatusFor(item: ItemMetadata): "current" | "stale" | "unknown" {
    if (!item.sourceRepo) return "unknown";
    return this.syncStatus.get(item.entryId) ?? "unknown";
  }

  private async upsertCollection(collection: Collection) {
    const settings = this.getSettings();
    await upsertCollectionAndSync(this.store, settings, this.saveSettings, this.items, collection);

    this.items = this.items.map((item) => {
      const shouldHave = collection.itemIds.includes(item.entryId);
      const has = item.collections.includes(collection.id);
      if (shouldHave === has) return item;
      return {
        ...item,
        collections: shouldHave ? [...item.collections, collection.id] : item.collections.filter((c) => c !== collection.id),
      };
    });
    if (this.selectedItem) {
      this.selectedItem = this.items.find((i) => i.entryId === this.selectedItem?.entryId) ?? null;
    }
    this.render();
  }

  private async deleteCollection(collection: Collection) {
    const settings = this.getSettings();
    await deleteCollectionAndSync(this.store, settings, this.saveSettings, this.items, collection.id);

    this.items = this.items.map((item) =>
      item.collections.includes(collection.id)
        ? { ...item, collections: item.collections.filter((c) => c !== collection.id) }
        : item
    );
    if (this.collectionFilter === collection.id) this.collectionFilter = null;
    if (this.selectedItem) {
      this.selectedItem = this.items.find((i) => i.entryId === this.selectedItem?.entryId) ?? null;
    }
    new Notice(`Deleted collection "${collection.name}".`);
    this.render();
  }

  private async upsertProject(project: ProjectWorkspace) {
    const settings = this.getSettings();
    const idx = settings.projectWorkspaces.findIndex((p) => p.id === project.id);
    if (idx >= 0) settings.projectWorkspaces[idx] = project;
    else settings.projectWorkspaces.push(project);
    await this.saveSettings();
    await this.rescan();
  }

  private async deleteProject(project: ProjectWorkspace) {
    const settings = this.getSettings();
    settings.projectWorkspaces = settings.projectWorkspaces.filter((p) => p.id !== project.id);
    await this.saveSettings();
    if (this.projectFilter === project.id) this.projectFilter = null;
    new Notice(`Removed workspace "${project.name}".`);
    await this.rescan();
  }

  // ---------- content ----------

  private renderContent(content: HTMLElement) {
    if (this.pluginBundlesMode) {
      this.renderPluginBundlesContent(content);
      return;
    }
    if (this.discoverMode) {
      this.renderDiscoverContent(content);
      return;
    }
    if (this.toolsMode) {
      this.renderToolsPageContent(content);
      return;
    }
    if (this.dashboardMode) {
      this.renderInsightsContent(content);
      return;
    }
    if (this.mcpMode) {
      this.renderMcpServersContent(content);
      return;
    }

    const items = this.filteredItems();

    const header = content.createDiv({ cls: "skillmanager-content-header" });
    if (this.pluginFilter) this.renderPluginLibraryBreadcrumb(header);
    const titleRow = header.createDiv({ cls: "skillmanager-title-row" });
    titleRow.createEl("h2", { text: this.scopeTitle(), cls: "skillmanager-title" });
    titleRow.createSpan({ text: String(items.length), cls: "skillmanager-count-pill" });
    if (!this.isScoped() && !this.showWorkspaceBanner()) this.renderWorkspaceChip(titleRow);
    header.createDiv({ text: this.scopeDescription(), cls: "skillmanager-subtitle" });
    if (!this.isScoped() && this.showWorkspaceBanner()) this.renderWorkspaceBanner(header);

    const toolbar = content.createDiv({ cls: "skillmanager-toolbar" });

    const searchWrap = toolbar.createDiv({ cls: "skillmanager-search-wrap" });
    const searchIcon = searchWrap.createSpan({ cls: "skillmanager-search-icon" });
    setIcon(searchIcon, "search");
    const searchInput = searchWrap.createEl("input", {
      type: "text",
      placeholder: "Search skills, agents, commands…",
      cls: "skillmanager-search",
    });
    searchInput.value = this.search;

    const clearBtn = searchWrap.createEl("button", {
      cls: "skillmanager-icon-btn skillmanager-search-clear",
      attr: { "aria-label": "Clear search" },
    });
    setIcon(clearBtn, "x");
    const updateClearBtn = () => clearBtn.toggle(searchInput.value.length > 0);
    updateClearBtn();

    const segmented = toolbar.createDiv({ cls: "skillmanager-segmented" });
    this.renderSegment(segmented, "All", this.enabledFilter === "all", () => {
      this.enabledFilter = "all";
      this.render();
    });
    this.renderSegment(segmented, "Enabled", this.enabledFilter === "enabled", () => {
      this.enabledFilter = "enabled";
      this.render();
    });
    this.renderSegment(segmented, "Disabled", this.enabledFilter === "disabled", () => {
      this.enabledFilter = "disabled";
      this.render();
    });

    // Bulk sync actions only make sense against the whole library, so only the true unscoped
    // "All" page offers them — a filtered/scoped view (a type, a tool, a project, …) doesn't.
    if (!this.isScoped()) {
      const syncActions = toolbar.createDiv({ cls: "skillmanager-toolbar-actions" });
      const staleCount = [...this.syncStatus.values()].filter((s) => s === "stale").length;

      // Only one of these two ever holds the solid accent fill at a time: "Check for updates" is
      // the primary action until a check turns up stale items, at which point "Update all"
      // becomes the more consequential action and takes the fill, demoting Check to a stroke.
      const checkBtn = syncActions.createEl("button", {
        text: "Check for updates",
        cls: staleCount > 0 ? "skillmanager-btn-accent-stroke" : "mod-cta",
      });
      checkBtn.addEventListener("click", () => void this.bulkCheckForUpdates(checkBtn));

      if (staleCount > 0) {
        const updateAllBtn = syncActions.createEl("button", { text: `Update all (${staleCount})`, cls: "mod-cta" });
        updateAllBtn.addEventListener("click", () => void this.bulkUpdateAll(updateAllBtn));
      }
    }

    // Same idea as Discover's own "+ Add source" — a one-click install that already knows which
    // tool you're looking at, instead of landing on a blank modal and having to pick it manually.
    if (this.toolFilter) {
      const tool = this.getSettings().tools.find((t) => t.id === this.toolFilter);
      if (tool) {
        const installActions = toolbar.createDiv({ cls: "skillmanager-toolbar-actions" });
        const installBtn = installActions.createEl("button", { cls: "mod-cta", text: `Install into ${tool.name}` });
        installBtn.addEventListener("click", () => this.openInstallFromGitHub(tool.id));
      }
    }

    this.renderTagBar(content.createDiv({ cls: "skillmanager-tagbar" }));

    const body = content.createDiv({ cls: "skillmanager-body" });

    // The grid is always on screen and always the same width once something's selected — it
    // never gets replaced by a tree or narrowed further to make room for a file. The one thing
    // that changes with depth is the detail rail beside it (see renderDetailRail), so only that
    // rail gets the enter animation, and only for a real navigation action (see
    // selectItem/selectFile/backToTree/backToLibrary) — an unrelated re-render (reordering a
    // sidebar section, toggling a card, favouriting) never replays it.
    const animation = this.pendingDetailAnimation;
    this.pendingDetailAnimation = null;

    const isList = this.getSettings().libraryLayout === "list";
    const grid = body.createDiv({
      cls: `skillmanager-items${isList ? " is-list" : ""}${this.selectedItem ? " is-docked" : ""}`,
    });
    const itemsEl = grid;
    const renderList = (el: HTMLElement, list: ItemMetadata[]) =>
      isList ? this.renderItemList(el, list) : this.renderItems(el, list);
    renderList(grid, items);
    if (this.selectedItem) {
      if (this.wasDocked) {
        // Already docked, just switching cards: the column layout hasn't changed, so restore
        // the exact scroll position rather than recomputing one — the newly selected card was
        // already on screen when it was clicked, so there's nothing to scroll into view.
        grid.scrollTop = this.dockedScrollTop;
      } else {
        // Just became docked (coming from the full, wider grid): the column layout changed, so
        // scroll the newly selected card into view since we don't know where it landed. "start"
        // (not "nearest") so it always lands at the top of the grid rather than wherever the
        // minimal scroll happens to leave it — e.g. pinned to the bottom edge when it was below
        // the fold.
        grid.querySelector(".skillmanager-card.is-selected, .skillmanager-list-row.is-selected")?.scrollIntoView({ block: "start" });
        // In the list layout the sticky column header sits over the top of the scroll area, so
        // "start" would tuck the row underneath it. Back off by the header's height plus the
        // row gap so the row settles just below the header instead.
        const listHead = grid.querySelector<HTMLElement>(".skillmanager-list-head");
        if (listHead) grid.scrollTop -= listHead.offsetHeight + parseFloat(getComputedStyle(grid).rowGap || "0");
      }
      grid.addEventListener("scroll", () => {
        this.dockedScrollTop = grid.scrollTop;
      });
      this.wasDocked = true;
    } else {
      // Full library view: restore wherever the user had scrolled to, and keep tracking it
      // live so the next backToLibrary() has an up-to-date position to return to.
      grid.scrollTop = this.libraryScrollTop;
      grid.addEventListener("scroll", () => {
        this.libraryScrollTop = grid.scrollTop;
      });
      this.wasDocked = false;
    }

    if (this.selectedItem) {
      const rail = body.createDiv({ cls: `skillmanager-detail${animation ? ` skillmanager-panel-enter-${animation}` : ""}` });
      this.renderDetailRail(rail, this.selectedItem);
    }

    // Re-filtering on each keystroke only needs the item grid redrawn, not the whole view —
    // but only while the grid is actually the visible side of the panel.
    searchInput.addEventListener("input", () => {
      this.search = searchInput.value;
      updateClearBtn();
      header.querySelector(".skillmanager-count-pill")?.setText(String(this.filteredItems().length));
      if (itemsEl) renderList(itemsEl, this.filteredItems());
    });

    clearBtn.addEventListener("click", () => {
      searchInput.value = "";
      this.search = "";
      updateClearBtn();
      header.querySelector(".skillmanager-count-pill")?.setText(String(this.filteredItems().length));
      if (itemsEl) renderList(itemsEl, this.filteredItems());
      searchInput.focus();
    });
  }

  private renderSegment(container: HTMLElement, label: string, active: boolean, onClick: () => void) {
    const btn = container.createEl("button", { text: label, cls: "skillmanager-segment" });
    if (active) btn.addClass("is-active");
    btn.addEventListener("click", onClick);
  }

  // ---------- Discover: a browsable catalog of items found on GitHub, not yet installed ----------

  private filteredDiscoverEntries(): DiscoverEntry[] {
    const query = this.discoverSearch.trim().toLowerCase();
    const entries = this.getSettings().discoverCatalog.filter((entry) => {
      if (this.discoverTypeFilter && entry.type !== this.discoverTypeFilter) return false;
      if (!query) return true;
      const haystack = `${entry.name} ${entry.description} ${entry.tags.join(" ")} ${entry.repoUrl}`.toLowerCase();
      return haystack.includes(query);
    });
    return this.sortDiscoverEntries(entries);
  }

  private sortDiscoverEntries(entries: DiscoverEntry[]): DiscoverEntry[] {
    const sorted = [...entries];
    switch (this.discoverSortOrder) {
      case "name-asc":
        sorted.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "name-desc":
        sorted.sort((a, b) => b.name.localeCompare(a.name));
        break;
      case "stars-desc":
        sorted.sort((a, b) => (b.starCount ?? -1) - (a.starCount ?? -1));
        break;
      case "source":
        // Flat fallback order (repo, then name) — renderDiscoverGroupedGrid is what actually
        // presents this sort mode's grouping in the UI.
        sorted.sort((a, b) => a.repoUrl.localeCompare(b.repoUrl) || a.name.localeCompare(b.name));
        break;
      case "recent-desc":
      default:
        sorted.sort((a, b) => b.discoveredAt - a.discoveredAt);
        break;
    }
    return sorted;
  }

  private renderDiscoverContent(content: HTMLElement) {
    // Same enter animation as the library rail (see renderContent) — consumed once here so it
    // plays for a real open/close but not for an incidental re-render (search, refresh, sort).
    const animation = this.pendingDetailAnimation;
    this.pendingDetailAnimation = null;

    const totalCount = this.getSettings().discoverCatalog.length;

    const header = content.createDiv({ cls: "skillmanager-content-header" });
    const titleRow = header.createDiv({ cls: "skillmanager-title-row" });
    titleRow.createEl("h2", { text: "Discover", cls: "skillmanager-title" });
    const countPill = titleRow.createSpan({
      text: String(this.filteredDiscoverEntries().length),
      cls: "skillmanager-count-pill",
    });
    header.createDiv({
      text: "Skills, agents, commands, and rules found in GitHub repos you've pointed at. Browse the real content, install whenever.",
      cls: "skillmanager-subtitle",
    });

    const toolbar = content.createDiv({ cls: "skillmanager-toolbar" });

    const searchWrap = toolbar.createDiv({ cls: "skillmanager-search-wrap" });
    const searchIcon = searchWrap.createSpan({ cls: "skillmanager-search-icon" });
    setIcon(searchIcon, "search");
    const searchInput = searchWrap.createEl("input", {
      type: "text",
      placeholder: "Search discovered skills…",
      cls: "skillmanager-search",
    });
    searchInput.value = this.discoverSearch;
    const clearBtn = searchWrap.createEl("button", {
      cls: "skillmanager-icon-btn skillmanager-search-clear",
      attr: { "aria-label": "Clear search" },
    });
    setIcon(clearBtn, "x");
    const updateClearBtn = () => clearBtn.toggle(searchInput.value.length > 0);
    updateClearBtn();

    this.renderDiscoverSortButton(toolbar);
    if (this.discoverSortOrder === "source") this.renderDiscoverCollapseAllButton(toolbar);
    this.renderDiscoverRefreshAllButton(toolbar);

    const addBtn = toolbar.createEl("button", { cls: "mod-cta", text: "+ Add source" });
    addBtn.addEventListener("click", () => this.openAddDiscoverSource());

    if (totalCount > 0) this.renderDiscoverTypeFilterBar(content.createDiv({ cls: "skillmanager-tagbar" }));

    const body = content.createDiv({ cls: "skillmanager-body" });
    const grouped = this.discoverSortOrder === "source";
    const grid = body.createDiv({
      cls: `skillmanager-items${this.selectedDiscoverEntry ? " is-docked" : ""}${grouped ? " is-grouped" : ""}`,
    });

    const renderGrid = () => {
      grid.empty();
      const entries = this.filteredDiscoverEntries();
      if (entries.length === 0) {
        if (totalCount === 0) {
          this.renderDiscoverEmptyState(grid);
        } else {
          grid.createDiv({ cls: "skillmanager-empty", text: "Nothing discovered matches your search." });
        }
        return;
      }
      if (grouped) {
        this.renderDiscoverGroupedGrid(grid, entries);
      } else {
        for (const entry of entries) this.renderDiscoverCard(grid, entry);
      }
      if (this.selectedDiscoverEntry) {
        if (this.wasDiscoverDocked) {
          // Already docked, just switching cards: restore the exact scroll position instead of
          // recomputing one — see the matching comment on the main library grid above for why
          // scrollIntoView on every render caused a visible jump.
          grid.scrollTop = this.dockedDiscoverScrollTop;
        } else {
          grid.querySelector(".skillmanager-card.is-selected")?.scrollIntoView({ block: "start" });
        }
      }
    };
    renderGrid();
    grid.addEventListener("scroll", () => {
      this.dockedDiscoverScrollTop = grid.scrollTop;
    });
    this.wasDiscoverDocked = !!this.selectedDiscoverEntry;

    if (this.selectedDiscoverEntry) {
      const rail = body.createDiv({
        cls: `skillmanager-detail skillmanager-discover-rail${animation ? ` skillmanager-panel-enter-${animation}` : ""}`,
      });
      this.renderDiscoverRail(rail, this.selectedDiscoverEntry);
    }

    const updateCount = () => countPill.setText(String(this.filteredDiscoverEntries().length));
    searchInput.addEventListener("input", () => {
      this.discoverSearch = searchInput.value;
      updateClearBtn();
      updateCount();
      renderGrid();
    });
    clearBtn.addEventListener("click", () => {
      searchInput.value = "";
      this.discoverSearch = "";
      updateClearBtn();
      updateCount();
      renderGrid();
      searchInput.focus();
    });
  }

  /** Same row/chip styling as the real library's tag bar (renderTagBar) — counts always reflect
   *  the whole catalog, not the current search text, so switching the type filter doesn't feel
   *  like it's fighting whatever you just typed. */
  private renderDiscoverTypeFilterBar(bar: HTMLElement) {
    const catalog = this.getSettings().discoverCatalog;
    const allChip = bar.createEl("button", { text: `All (${catalog.length})`, cls: "skillmanager-chip" });
    if (!this.discoverTypeFilter) allChip.addClass("is-active");
    allChip.addEventListener("click", () => {
      this.discoverTypeFilter = null;
      this.render();
    });
    for (const type of Object.keys(TYPE_LABELS) as ItemType[]) {
      const count = catalog.filter((e) => e.type === type).length;
      if (count === 0) continue;
      const chip = bar.createEl("button", { text: `${TYPE_LABELS[type]} (${count})`, cls: "skillmanager-chip" });
      if (this.discoverTypeFilter === type) chip.addClass("is-active");
      chip.addEventListener("click", () => {
        this.discoverTypeFilter = this.discoverTypeFilter === type ? null : type;
        this.render();
      });
    }
  }

  private renderDiscoverSortButton(toolbar: HTMLElement) {
    const current = DISCOVER_SORT_OPTIONS.find((o) => o.key === this.discoverSortOrder) ?? DISCOVER_SORT_OPTIONS[0];
    const btn = toolbar.createEl("button", { cls: "skillmanager-sort-btn", attr: { "aria-label": "Sort by" } });
    const icon = btn.createSpan({ cls: "skillmanager-sort-btn-icon" });
    setIcon(icon, "arrow-up-down");
    btn.createSpan({ text: current.label, cls: "skillmanager-sort-btn-label" });
    const chevron = btn.createSpan({ cls: "skillmanager-sort-btn-chevron" });
    setIcon(chevron, "chevron-down");
    btn.addEventListener("click", (evt) => {
      const menu = new Menu();
      for (const option of DISCOVER_SORT_OPTIONS) {
        menu.addItem((menuItem) =>
          menuItem
            .setTitle(option.label)
            .setChecked(this.discoverSortOrder === option.key)
            .onClick(() => {
              this.discoverSortOrder = option.key;
              this.render();
            })
        );
      }
      menu.showAtMouseEvent(evt);
    });
  }

  private renderDiscoverRefreshAllButton(toolbar: HTMLElement) {
    const btn = toolbar.createEl("button", {
      cls: "skillmanager-sort-btn skillmanager-discover-refresh-all-btn",
      attr: { "aria-label": "Re-search every repo already in Discover for anything new or changed" },
    });
    const icon = btn.createSpan({ cls: "skillmanager-sort-btn-icon" });
    setIcon(icon, "refresh-cw");
    btn.createSpan({ text: "Refresh all", cls: "skillmanager-sort-btn-label" });
    if (this.refreshingAllDiscover) {
      btn.disabled = true;
      btn.addClass("is-syncing");
    }
    btn.addEventListener("click", () => void this.refreshAllDiscoverSources());
  }

  /** Only shown in "Source (grouped)" sort. A one-click way to shrink every section down to its
   *  header (or bring them all back), for jumping straight to a particular source without
   *  scrolling past however many hundred cards a big one has. Flips to "Expand all" once every
   *  currently-visible group is already collapsed. */
  private renderDiscoverCollapseAllButton(toolbar: HTMLElement) {
    const keys = new Set<string>();
    for (const entry of this.filteredDiscoverEntries()) keys.add(discoverGroupKey(entry.repoUrl, entry.ref));
    if (keys.size < 2) return;
    const allCollapsed = Array.from(keys).every((key) => this.collapsedDiscoverSources.has(key));

    const btn = toolbar.createEl("button", { cls: "skillmanager-sort-btn" });
    const icon = btn.createSpan({ cls: "skillmanager-sort-btn-icon" });
    setIcon(icon, allCollapsed ? "chevrons-down-up" : "chevrons-up-down");
    btn.createSpan({ text: allCollapsed ? "Expand all" : "Collapse all", cls: "skillmanager-sort-btn-label" });
    btn.addEventListener("click", () => {
      if (allCollapsed) {
        for (const key of keys) this.collapsedDiscoverSources.delete(key);
      } else {
        for (const key of keys) this.collapsedDiscoverSources.add(key);
      }
      this.render();
    });
  }

  /** Re-runs discovery for every tracked source (settings.discoverSources) — a plain per-entry
   *  Refresh (see refreshDiscoverEntry) only re-fetches items already known, so it can't recover
   *  anything a source's search missed the first time (e.g. everything under .github/ before
   *  findRepoManifests stopped skipping dot-prefixed folders), and it can't bring back an item
   *  you deleted from the real library either. Backfills a source record from the catalog for
   *  anything added before sources were tracked separately (repoUrl/ref with no matching source,
   *  searched from the repo root since the original subpath was never recorded) — after one
   *  refresh, every source is durable going forward even if every item it found gets installed
   *  or removed, which used to make it silently drop out of this list entirely. Deliberately
   *  excludes anything already installed (matched by sourceRepo+sourceSubpath, same as
   *  AddDiscoverSourceModal) — otherwise re-installing everything a source offers would make it
   *  reappear in Discover right alongside the real item it now duplicates. Only ever adds/
   *  updates the catalog, never prunes an entry that's no longer found upstream, so a bad network
   *  blip can't silently wipe out part of it. */
  private async refreshAllDiscoverSources() {
    if (this.refreshingAllDiscover) return;
    const settings = this.getSettings();
    // Keyed by repoUrl+ref+subpath (matching discoverSourceId's own identity) — two sources from
    // the same repo+ref but different subpaths are genuinely distinct searches, and collapsing
    // them onto a repoUrl+ref-only key silently dropped one of them from every future refresh
    // (whichever subpath was inserted last "won"), so an item living only under the dropped
    // subpath could never be rediscovered even after being deleted and refreshed for.
    const sources = new Map<string, { repoUrl: string; ref: string; subpath: string }>();
    for (const source of settings.discoverSources) {
      sources.set(discoverSourceId(source.repoUrl, source.ref, source.subpath), source);
    }
    for (const entry of settings.discoverCatalog) {
      const key = `${entry.repoUrl}#${entry.ref}#`;
      if (!sources.has(key) && ![...sources.values()].some((s) => s.repoUrl === entry.repoUrl && s.ref === entry.ref)) {
        sources.set(key, { repoUrl: entry.repoUrl, ref: entry.ref, subpath: "" });
      }
    }
    if (sources.size === 0) {
      new Notice("Nothing to refresh yet. Add a source first.");
      return;
    }

    this.refreshingAllDiscover = true;
    this.render();

    let sourcesDone = 0;
    let itemsFound = 0;
    const failures: string[] = [];
    for (const source of sources.values()) {
      sourcesDone++;
      new Notice(`Refreshing source ${sourcesDone} of ${sources.size}…`);
      try {
        const [allFound, starCount] = await Promise.all([
          discoverGitSkills(source.repoUrl, source.ref, source.subpath),
          fetchGithubStars(source.repoUrl),
        ]);
        const found = allFound.filter((entry) => !this.isDiscoverEntryInstalled(entry.repoUrl, entry.subpath));
        const starsFetchedAt = starCount !== null ? Date.now() : null;
        for (const entry of found) {
          entry.starCount = starCount;
          entry.starsFetchedAt = starsFetchedAt;
        }

        const live = this.getSettings();
        const byId = new Map(live.discoverCatalog.map((e) => [e.id, e]));
        for (const entry of found) byId.set(entry.id, entry);
        live.discoverCatalog = dedupeDiscoverCatalog(Array.from(byId.values()));

        const sourceId = discoverSourceId(source.repoUrl, source.ref, source.subpath);
        if (!live.discoverSources.some((s) => s.id === sourceId)) {
          live.discoverSources.push({ id: sourceId, repoUrl: source.repoUrl, ref: source.ref, subpath: source.subpath, addedAt: Date.now() });
        }

        await this.saveSettings();
        itemsFound += found.length;
      } catch (e) {
        failures.push(`${source.repoUrl}: ${errorMessage(e)}`);
      }
    }

    this.refreshingAllDiscover = false;
    new Notice(
      failures.length === 0
        ? `Refreshed ${sources.size} source${sources.size === 1 ? "" : "s"}: ${itemsFound} item${itemsFound === 1 ? "" : "s"} found.`
        : `Refreshed ${sources.size - failures.length} of ${sources.size} sources. Failed: ${failures.join("; ")}`
    );
    this.render();
  }

  /** "Source (grouped)" sort mode: entries grouped under a header per distinct repo/ref, each
   *  header carrying that repo's identity (avatar, owner/repo, count) and a bulk-remove action —
   *  the point of grouping in the first place, since a flat sorted-by-repo list would still make
   *  "remove everything from this repo" a card-by-card chore. */
  private renderDiscoverGroupedGrid(container: HTMLElement, entries: DiscoverEntry[]) {
    const groups = new Map<string, { repoUrl: string; ref: string; entries: DiscoverEntry[] }>();
    for (const entry of entries) {
      const key = discoverGroupKey(entry.repoUrl, entry.ref);
      let group = groups.get(key);
      if (!group) {
        group = { repoUrl: entry.repoUrl, ref: entry.ref, entries: [] };
        groups.set(key, group);
      }
      group.entries.push(entry);
    }

    const sortedGroups = Array.from(groups.values()).sort((a, b) => a.repoUrl.localeCompare(b.repoUrl));
    for (const group of sortedGroups) {
      group.entries.sort((a, b) => a.name.localeCompare(b.name));
      this.renderDiscoverSourceGroup(container, group);
    }
  }

  private renderDiscoverSourceGroup(container: HTMLElement, group: { repoUrl: string; ref: string; entries: DiscoverEntry[] }) {
    const groupKey = discoverGroupKey(group.repoUrl, group.ref);
    const isCollapsed = this.collapsedDiscoverSources.has(groupKey);

    const section = container.createDiv({
      cls: `skillmanager-discover-source-group${isCollapsed ? " is-collapsed" : ""}`,
    });
    const header = section.createDiv({ cls: "skillmanager-discover-source-group-header" });

    // Dedicated toggle, separate from the header's own click handler below (scroll-to-top) —
    // collapsing a section with hundreds of cards is the whole point of this control, so it
    // shouldn't be at the mercy of "did the click also land on the sticky-scroll logic."
    const chevron = header.createSpan({
      cls: "skillmanager-chevron",
      attr: { "aria-label": isCollapsed ? `Expand ${group.repoUrl}` : `Collapse ${group.repoUrl}` },
    });
    setIcon(chevron, isCollapsed ? "chevron-right" : "chevron-down");
    chevron.addEventListener("click", (evt) => {
      evt.stopPropagation();
      if (isCollapsed) this.collapsedDiscoverSources.delete(groupKey);
      else this.collapsedDiscoverSources.add(groupKey);
      this.render();
    });

    const parsed = parseOwnerRepo(group.repoUrl);
    const label = parsed ? `${parsed.owner}/${parsed.repo}` : group.repoUrl;
    const repoLine = header.createDiv({ cls: "skillmanager-card-discover-repo" });
    if (parsed) {
      repoLine.createEl("img", { attr: { src: `https://github.com/${parsed.owner}.png?size=32` } });
    }
    repoLine.createSpan({ text: label, cls: "skillmanager-card-discover-repo-name" });
    header.createSpan({ text: String(group.entries.length), cls: "skillmanager-count-pill" });

    const removeBtn = header.createEl("button", {
      cls: "skillmanager-icon-btn",
      attr: { "aria-label": `Remove all ${group.entries.length} items from ${label}` },
    });
    setIcon(removeBtn, "trash-2");
    removeBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.confirmRemoveDiscoverSource(group.repoUrl, group.ref, group.entries.length, label);
    });

    // The header stays pinned at the top of the scroll area for as long as any of this
    // section's cards are still in view (see .skillmanager-discover-source-group-header's
    // position: sticky) — clicking it while stuck jumps back to this section's own top,
    // rather than scrolling to wherever the sticky header's own box currently reports (which,
    // being sticky, is always "already at the top" and wouldn't move anything).
    header.addEventListener("click", () => {
      const scrollContainer = section.closest<HTMLElement>(".skillmanager-items");
      if (!scrollContainer) return;
      // getBoundingClientRect rather than offsetTop — offsetTop is relative to whichever
      // ancestor happens to be positioned, not necessarily the scroll container itself.
      const delta = section.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top;
      scrollContainer.scrollTo({ top: scrollContainer.scrollTop + delta, behavior: "smooth" });
    });

    // Skip building the (potentially hundreds-deep) card grid at all while collapsed, rather
    // than rendering it and hiding it with CSS — the point is to make a huge source cheap to
    // skip past, not just invisible.
    if (!isCollapsed) {
      const grid = section.createDiv({ cls: "skillmanager-discover-source-group-grid" });
      for (const entry of group.entries) this.renderDiscoverCard(grid, entry);
    }
  }

  /** Bulk removal is still just dropping our own cached rows (nothing on disk to touch, same as
   *  a single Remove) — but at the scale a whole source can reach (dozens of entries in one
   *  click), a lightweight confirm earns its keep in a way it doesn't for one card. */
  private confirmRemoveDiscoverSource(repoUrl: string, ref: string, count: number, label: string) {
    new ConfirmModal(
      this.app,
      `Remove all from ${label}?`,
      `This removes ${count} discovered item${count === 1 ? "" : "s"} from "${label}" out of Discover and stops tracking it. "Refresh all" won't search it again until you add it back. Nothing on disk is affected: none of these are installed.`,
      "Remove all",
      async () => {
        const settings = this.getSettings();
        settings.discoverCatalog = settings.discoverCatalog.filter((e) => !(e.repoUrl === repoUrl && e.ref === ref));
        settings.discoverSources = settings.discoverSources.filter((s) => !(s.repoUrl === repoUrl && s.ref === ref));
        if (this.selectedDiscoverEntry && this.selectedDiscoverEntry.repoUrl === repoUrl && this.selectedDiscoverEntry.ref === ref) {
          this.selectedDiscoverEntry = null;
        }
        await this.saveSettings();
        new Notice(`Removed ${count} item${count === 1 ? "" : "s"} from "${label}".`);
        this.render();
      }
    ).open();
  }

  /** Card variant for a not-yet-installed catalog entry — deliberately a sibling to renderCard,
   *  not a branch inside it: a DiscoverEntry has none of the enabled/tags-editing/project/
   *  favourite/sourcePath semantics renderCard is built around, and clicking one must never touch
   *  selectItem's tree/file/edit state machine, which is entirely file-on-disk-oriented. */
  private renderDiscoverCard(container: HTMLElement, entry: DiscoverEntry) {
    const card = container.createDiv({ cls: "skillmanager-card skillmanager-card-discover" });
    if (this.selectedDiscoverEntry?.id === entry.id) card.addClass("is-selected");

    const head = card.createDiv({ cls: "skillmanager-card-head" });
    head.createSpan({ text: entry.name, cls: "skillmanager-card-name" });

    const actions = head.createDiv({ cls: "skillmanager-card-discover-actions" });
    const linkBtn = actions.createEl("button", { cls: "skillmanager-icon-btn", attr: { "aria-label": "Open on GitHub" } });
    setIcon(linkBtn, "external-link");
    linkBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      window.open(this.discoverEntryUrl(entry), "_blank");
    });
    const installBtn = actions.createEl("button", {
      cls: "skillmanager-icon-btn skillmanager-install-btn",
      attr: { "aria-label": "Install" },
    });
    setIcon(installBtn, "plus");
    installBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.installDiscoverEntry(entry);
    });

    if (entry.description) {
      card.createDiv({ text: entry.description, cls: "skillmanager-card-desc" });
    }
    if (entry.tags.length > 0) {
      const tags = card.createDiv({ cls: "skillmanager-card-tags" });
      for (const tag of entry.tags) {
        tags.createSpan({ text: tag, cls: `skillmanager-chip skillmanager-tag-c${tagColorIndex(tag)}` });
      }
    }

    const footer = card.createDiv({ cls: "skillmanager-card-footer" });
    this.renderDiscoverRepoLine(footer, entry);

    const rightGroup = footer.createDiv({ cls: "skillmanager-card-footer-right" });
    rightGroup.createSpan({ text: TYPE_LABEL_SINGULAR[entry.type], cls: "skillmanager-card-type" });
    const menuBtn = rightGroup.createEl("button", { cls: "skillmanager-icon-btn", attr: { "aria-label": "More actions" } });
    setIcon(menuBtn, MORE_HORIZONTAL_ICON_ID);
    menuBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.openDiscoverCardMenu(evt, entry);
    });

    card.addEventListener("click", () => {
      this.selectedDiscoverEntry = entry;
      this.pendingDetailAnimation = "forward";
      this.render();
    });
  }

  /** Repo avatar + owner/repo + star count, all one inline group — shared between the card
   *  footer and the rail header so "which repo this came from" reads identically in both. */
  private renderDiscoverRepoLine(container: HTMLElement, entry: DiscoverEntry) {
    const repo = container.createDiv({ cls: "skillmanager-card-discover-repo" });
    const parsed = parseOwnerRepo(entry.repoUrl);
    if (parsed) {
      repo.createEl("img", { attr: { src: `https://github.com/${parsed.owner}.png?size=32` } });
      repo.createSpan({ text: `${parsed.owner}/${parsed.repo}`, cls: "skillmanager-card-discover-repo-name" });
    } else {
      repo.createSpan({ text: entry.repoUrl, cls: "skillmanager-card-discover-repo-name" });
    }
    if (entry.starCount !== null) {
      const stars = repo.createDiv({ cls: "skillmanager-card-discover-stars" });
      setIcon(stars.createSpan(), "star");
      stars.createSpan({ text: String(entry.starCount) });
    }
  }

  private discoverEntryUrl(entry: DiscoverEntry): string {
    return githubSourceUrl(entry.repoUrl, entry.ref, entry.subpath, entry.commit);
  }

  private openDiscoverCardMenu(evt: MouseEvent, entry: DiscoverEntry) {
    const menu = new Menu();
    menu.addItem((menuItem) =>
      menuItem
        .setTitle("Refresh")
        .setIcon("refresh-cw")
        .onClick(() => void this.refreshDiscoverEntry(entry))
    );
    menu.addSeparator();
    menu.addItem((menuItem) =>
      menuItem
        .setTitle("Remove")
        .setIcon("trash-2")
        .setWarning(true)
        .onClick(() => void this.removeDiscoverEntry(entry))
    );
    menu.showAtMouseEvent(evt);
  }

  /** Opens the real install modal pre-filled from this catalog entry, so the proven clone/copy/
   *  register pipeline (InstallFromGitHubModal.install()) stays the single source of truth for
   *  actually installing something — Discover only ever hands it a repoUrl/ref/subpath/type. */
  private installDiscoverEntry(entry: DiscoverEntry) {
    new InstallFromGitHubModal(
      this.app,
      this.getSettings(),
      this.getAllProjects(),
      this.store,
      () => this.rescan(),
      { repoUrl: entry.repoUrl, ref: entry.ref, subpath: entry.subpath, type: entry.type },
      () => void this.removeDiscoverEntry(entry, { silent: true })
    ).open();
  }

  /** Nothing on disk to clean up — a catalog entry never had a filesystem footprint, so removing
   *  one is just dropping our own cached row. `silent` is used right after a successful install,
   *  where the entry's removal is implied by "Installed …" already showing, not worth a second
   *  notice for. */
  private async removeDiscoverEntry(entry: DiscoverEntry, opts: { silent?: boolean } = {}) {
    const settings = this.getSettings();
    settings.discoverCatalog = settings.discoverCatalog.filter((e) => e.id !== entry.id);
    if (this.selectedDiscoverEntry?.id === entry.id) this.selectedDiscoverEntry = null;
    await this.saveSettings();
    if (!opts.silent) new Notice(`Removed "${entry.name}" from Discover.`);
    this.render();
  }

  private async refreshDiscoverEntry(entry: DiscoverEntry) {
    new Notice(`Refreshing "${entry.name}"…`);
    try {
      const [updated, starCount] = await Promise.all([refetchDiscoverEntry(entry), fetchGithubStars(entry.repoUrl)]);
      updated.starCount = starCount ?? entry.starCount;
      updated.starsFetchedAt = starCount !== null ? Date.now() : entry.starsFetchedAt;

      const settings = this.getSettings();
      settings.discoverCatalog = settings.discoverCatalog.map((e) => (e.id === entry.id ? updated : e));
      if (this.selectedDiscoverEntry?.id === entry.id) this.selectedDiscoverEntry = updated;
      await this.saveSettings();
      new Notice(`Refreshed "${updated.name}".`);
      this.render();
    } catch (e) {
      new Notice(`Couldn't refresh "${entry.name}": ` + errorMessage(e));
    }
  }

  /** The Discover equivalent of renderDetailRail — deliberately similar (same breadcrumb/header/
   *  body chrome and classes as the real file preview) so it reads as "the same kind of thing,"
   *  but visibly distinct throughout: a "Not installed" pill instead of a tool pill, Install/
   *  open-on-GitHub actions instead of Edit, repo attribution instead of a file path, and no
   *  tags-editing, frontmatter box, or tree — this is a read-only look at someone else's skill,
   *  not a file on disk. */
  private renderDiscoverRail(panel: HTMLElement, entry: DiscoverEntry) {
    const crumbs = panel.createDiv({ cls: "skillmanager-crumbs" });
    const backBtn = crumbs.createEl("button", { cls: "skillmanager-icon-btn", attr: { "aria-label": "Back" } });
    setIcon(backBtn, "arrow-left");
    const back = () => {
      this.selectedDiscoverEntry = null;
      this.pendingDetailAnimation = "back";
      this.render();
    };
    backBtn.addEventListener("click", back);
    const discoverCrumb = crumbs.createEl("button", { cls: "skillmanager-crumb", text: "Discover" });
    discoverCrumb.addEventListener("click", back);
    crumbs.createSpan({ cls: "skillmanager-crumb-sep", text: "/" });
    crumbs.createEl("button", { cls: "skillmanager-crumb is-current", text: entry.name });

    const header = panel.createDiv({ cls: "skillmanager-detail-header" });
    header.createEl("h3", { text: entry.name, cls: "skillmanager-detail-title" });
    header.createSpan({ text: TYPE_LABEL_SINGULAR[entry.type], cls: "skillmanager-card-type" });
    header.createSpan({ text: "Not installed", cls: "skillmanager-detail-tool-pill skillmanager-discover-pill" });
    const actions = header.createDiv({ cls: "skillmanager-detail-actions" });
    const linkBtn = actions.createEl("button", { cls: "skillmanager-icon-btn", attr: { "aria-label": "Open on GitHub" } });
    setIcon(linkBtn, "external-link");
    linkBtn.addEventListener("click", () => window.open(this.discoverEntryUrl(entry), "_blank"));
    const installBtn = actions.createEl("button", { cls: "mod-cta skillmanager-discover-rail-install-btn", text: "+ Install" });
    installBtn.addEventListener("click", () => this.installDiscoverEntry(entry));

    this.renderDiscoverRepoLine(panel, entry);
    if (entry.subpath) {
      panel.createDiv({ cls: "skillmanager-detail-path", text: entry.subpath });
    }
    if (entry.tags.length > 0) {
      const tags = panel.createDiv({ cls: "skillmanager-card-tags skillmanager-discover-rail-tags" });
      for (const tag of entry.tags) {
        tags.createSpan({ text: tag, cls: `skillmanager-chip skillmanager-tag-c${tagColorIndex(tag)}` });
      }
    }

    const body = panel.createDiv({ cls: "skillmanager-detail-body" });
    const readingView = body.createDiv({
      cls: "markdown-preview-view markdown-rendered node-insert-event is-readable-line-width allow-fold-headings allow-fold-lists show-indentation-guide skillmanager-markdown-preview",
    });
    const sizer = readingView.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
    void MarkdownRenderer.render(this.app, stripFrontmatter(entry.manifestText), sizer, entry.name, this.markdownComponent);
  }

  // ---------- Installed plugin bundles ----------

  private pluginBundleTool(plugin: PluginSource): ToolConfig | undefined {
    return this.getSettings().tools.find((tool) => tool.id === plugin.toolId);
  }

  private pluginBundleTags(plugin: PluginSource): string[] {
    return Array.from(
      new Set(
        this.items
          .filter((item) => item.pluginId === plugin.id)
          .flatMap((item) => item.tags)
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b));
  }

  private pluginBundleItemCount(plugin: PluginSource): number {
    return this.items.filter((item) => item.pluginId === plugin.id).length;
  }

  private filteredPluginBundles(): PluginSource[] {
    const query = this.pluginBundleSearch.trim().toLowerCase();
    const bundles = this.discoveredPlugins.filter((plugin) => {
      const tool = this.pluginBundleTool(plugin);
      const tags = this.pluginBundleTags(plugin);
      if (this.pluginBundleToolFilter && plugin.toolId !== this.pluginBundleToolFilter) return false;
      if (this.pluginBundleGroupFilter && (plugin.group ?? "Other") !== this.pluginBundleGroupFilter) return false;
      if (this.pluginBundleTagFilter && !tags.includes(this.pluginBundleTagFilter)) return false;
      if (query) {
        const haystack = `${plugin.name} ${plugin.group ?? ""} ${tool?.name ?? ""} ${tags.join(" ")}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
    return bundles.sort((a, b) => {
      if (this.pluginBundleSortOrder === "name-desc") return b.name.localeCompare(a.name);
      if (this.pluginBundleSortOrder === "items-desc") return this.pluginBundleItemCount(b) - this.pluginBundleItemCount(a) || a.name.localeCompare(b.name);
      if (this.pluginBundleSortOrder === "items-asc") return this.pluginBundleItemCount(a) - this.pluginBundleItemCount(b) || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name);
    });
  }

  private renderPluginBundlesContent(content: HTMLElement) {
    const bundles = this.filteredPluginBundles();
    const header = content.createDiv({ cls: "skillmanager-content-header" });
    const titleRow = header.createDiv({ cls: "skillmanager-title-row" });
    titleRow.createEl("h2", { text: "Plugin bundles", cls: "skillmanager-title" });
    titleRow.createSpan({ text: String(bundles.length), cls: "skillmanager-count-pill" });
    header.createDiv({
      text: "Installed plugin bundles and the skills, agents, commands, and rules they provide. Manage each bundle from its owning tool.",
      cls: "skillmanager-subtitle",
    });

    const toolbar = content.createDiv({ cls: "skillmanager-toolbar" });
    const searchWrap = toolbar.createDiv({ cls: "skillmanager-search-wrap" });
    const searchIcon = searchWrap.createSpan({ cls: "skillmanager-search-icon" });
    setIcon(searchIcon, "search");
    const searchInput = searchWrap.createEl("input", {
      type: "text",
      placeholder: "Search plugin bundles…",
      cls: "skillmanager-search",
    });
    searchInput.value = this.pluginBundleSearch;
    const clearBtn = searchWrap.createEl("button", {
      cls: "skillmanager-icon-btn skillmanager-search-clear",
      attr: { "aria-label": "Clear search" },
    });
    setIcon(clearBtn, "x");
    clearBtn.toggle(searchInput.value.length > 0);
    clearBtn.addEventListener("click", () => {
      this.pluginBundleSearch = "";
      this.render();
    });

    this.renderPluginBundleFilterButton(toolbar, "tool");
    this.renderPluginBundleFilterButton(toolbar, "group");
    this.renderPluginBundleSortButton(toolbar);

    const allTags = Array.from(new Set(this.discoveredPlugins.flatMap((plugin) => this.pluginBundleTags(plugin)))).sort((a, b) => a.localeCompare(b));
    if (allTags.length > 0) {
      const tagbar = content.createDiv({ cls: "skillmanager-tagbar" });
      const allChip = tagbar.createEl("button", { text: "All tags", cls: "skillmanager-chip" });
      if (!this.pluginBundleTagFilter) allChip.addClass("is-active");
      allChip.addEventListener("click", () => {
        this.pluginBundleTagFilter = null;
        this.render();
      });
      for (const tag of allTags) {
        const chip = tagbar.createEl("button", { text: tag, cls: `skillmanager-chip skillmanager-tag-c${tagColorIndex(tag)}` });
        if (this.pluginBundleTagFilter === tag) chip.addClass("is-active");
        chip.addEventListener("click", () => {
          this.pluginBundleTagFilter = this.pluginBundleTagFilter === tag ? null : tag;
          this.render();
        });
      }
    }

    const grid = content.createDiv({ cls: "skillmanager-items" });
    if (bundles.length === 0) {
      grid.createDiv({ text: "No plugin bundles match these filters.", cls: "skillmanager-empty" });
    }
    for (const plugin of bundles) this.renderPluginBundleCard(grid, plugin);

    searchInput.addEventListener("input", () => {
      this.pluginBundleSearch = searchInput.value;
      clearBtn.toggle(searchInput.value.length > 0);
      const next = this.filteredPluginBundles();
      titleRow.querySelector(".skillmanager-count-pill")?.setText(String(next.length));
      grid.empty();
      if (next.length === 0) grid.createDiv({ text: "No plugin bundles match these filters.", cls: "skillmanager-empty" });
      for (const plugin of next) this.renderPluginBundleCard(grid, plugin);
      searchInput.focus();
    });
  }

  private renderPluginBundleFilterButton(toolbar: HTMLElement, kind: "tool" | "group") {
    const values = Array.from(
      new Set(
        this.discoveredPlugins
          .map((plugin) => (kind === "tool" ? this.pluginBundleTool(plugin)?.name : plugin.group ?? "Other"))
          .filter((value): value is string => !!value)
      )
    ).sort((a, b) => a.localeCompare(b));
    if (values.length < 2) return;
    const current = kind === "tool" ? this.pluginBundleToolFilter : this.pluginBundleGroupFilter;
    const currentLabel = kind === "tool" ? this.getSettings().tools.find((tool) => tool.id === current)?.name : current;
    const btn = toolbar.createEl("button", { cls: "skillmanager-sort-btn", attr: { "aria-label": `Filter by ${kind}` } });
    const icon = btn.createSpan({ cls: "skillmanager-sort-btn-icon" });
    setIcon(icon, "filter");
    btn.createSpan({ text: current ? currentLabel ?? current : kind === "tool" ? "All tools" : "All groups", cls: "skillmanager-sort-btn-label" });
    const chevron = btn.createSpan({ cls: "skillmanager-sort-btn-chevron" });
    setIcon(chevron, "chevron-down");
    btn.addEventListener("click", (evt) => {
      const menu = new Menu();
      menu.addItem((item) => item.setTitle(kind === "tool" ? "All tools" : "All groups").setChecked(!current).onClick(() => {
        if (kind === "tool") this.pluginBundleToolFilter = null;
        else this.pluginBundleGroupFilter = null;
        this.render();
      }));
      for (const value of values) {
        menu.addItem((item) => item.setTitle(value).setChecked(current === (kind === "tool" ? this.getSettings().tools.find((tool) => tool.name === value)?.id : value)).onClick(() => {
          if (kind === "tool") this.pluginBundleToolFilter = this.getSettings().tools.find((tool) => tool.name === value)?.id ?? null;
          else this.pluginBundleGroupFilter = value;
          this.render();
        }));
      }
      menu.showAtMouseEvent(evt);
    });
  }

  private renderPluginBundleSortButton(toolbar: HTMLElement) {
    const options: { key: PluginBundleSortOrder; label: string }[] = [
      { key: "name-asc", label: "Name (A to Z)" },
      { key: "name-desc", label: "Name (Z to A)" },
      { key: "items-desc", label: "Items (high to low)" },
      { key: "items-asc", label: "Items (low to high)" },
    ];
    const current = options.find((option) => option.key === this.pluginBundleSortOrder) ?? options[0];
    const btn = toolbar.createEl("button", { cls: "skillmanager-sort-btn", attr: { "aria-label": "Sort by" } });
    const icon = btn.createSpan({ cls: "skillmanager-sort-btn-icon" });
    setIcon(icon, "arrow-up-down");
    btn.createSpan({ text: current.label, cls: "skillmanager-sort-btn-label" });
    const chevron = btn.createSpan({ cls: "skillmanager-sort-btn-chevron" });
    setIcon(chevron, "chevron-down");
    btn.addEventListener("click", (evt) => {
      const menu = new Menu();
      for (const option of options) menu.addItem((item) => item.setTitle(option.label).setChecked(this.pluginBundleSortOrder === option.key).onClick(() => {
        this.pluginBundleSortOrder = option.key;
        this.render();
      }));
      menu.showAtMouseEvent(evt);
    });
  }

  private renderPluginBundleCard(container: HTMLElement, plugin: PluginSource) {
    const tool = this.pluginBundleTool(plugin);
    const tags = this.pluginBundleTags(plugin);
    const typeCounts = (Object.keys(TYPE_LABELS) as ItemType[])
      .map((type) => ({ type, count: this.items.filter((item) => item.pluginId === plugin.id && item.type === type).length }))
      .filter(({ count }) => count > 0);
    const itemSummary = typeCounts.length > 0
      ? typeCounts.map(({ type, count }) => `${count} ${TYPE_LABELS[type].toLowerCase().replace(/s$/, "")}${count === 1 ? "" : "s"}`).join(" • ")
      : "No library items scanned";
    const card = container.createDiv({ cls: "skillmanager-card" });
    if (!plugin.enabled) card.addClass("is-off");
    const head = card.createDiv({ cls: "skillmanager-card-head" });
    head.createSpan({ text: plugin.name, cls: "skillmanager-card-name" });
    head.createSpan({ text: "Plugin", cls: "skillmanager-card-type skillmanager-card-type-sm" });
    const toggle = head.createEl("button", {
      cls: `skillmanager-toggle${plugin.enabled ? " is-on" : ""}`,
      attr: { "aria-label": plugin.enabled ? `Manage ${plugin.name} plugin` : `Manage disabled ${plugin.name} plugin` },
    });
    toggle.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.explainPluginBundleToggle(plugin);
    });
    if (tool) {
      const toolCaption = card.createDiv({ cls: "skillmanager-card-tool" });
      const toolIcon = toolCaption.createSpan({ cls: "skillmanager-card-tool-icon" });
      this.renderIcon(toolIcon, tool.icon, tool.svgIcon);
      toolCaption.createSpan({ text: tool.name });
    }
    card.createDiv({ text: itemSummary, cls: "skillmanager-card-desc" });
    if (tags.length > 0) {
      const tagRow = card.createDiv({ cls: "skillmanager-card-tags" });
      for (const tag of tags) tagRow.createSpan({ text: tag, cls: `skillmanager-chip skillmanager-tag-c${tagColorIndex(tag)}` });
    }
    const footer = card.createDiv({ cls: "skillmanager-card-footer" });
    const source = footer.createDiv({ cls: "skillmanager-card-source" });
    const sourceIcon = source.createSpan({ cls: "skillmanager-card-source-icon" });
    setIcon(sourceIcon, "layers-3");
    source.createSpan({ text: plugin.group ?? "Installed plugin", cls: "skillmanager-card-source-text" });
    const right = footer.createDiv({ cls: "skillmanager-card-footer-right" });
    if (!plugin.enabled) right.createSpan({ text: "Disabled", cls: "skillmanager-card-meta" });
    card.addEventListener("click", () => {
      this.pluginBundlesMode = false;
      this.pluginFilter = plugin.id;
      this.selectedItem = null;
      this.selectedFilePath = null;
      this.pendingDetailAnimation = "forward";
      this.render();
    });
  }

  private renderPluginLibraryBreadcrumb(header: HTMLElement) {
    const plugin = this.discoveredPlugins.find((candidate) => candidate.id === this.pluginFilter);
    if (!plugin) return;
    const crumbs = header.createDiv({ cls: "skillmanager-crumbs" });
    const backBtn = crumbs.createEl("button", { cls: "skillmanager-icon-btn", attr: { "aria-label": "Back to plugin bundles" } });
    setIcon(backBtn, "arrow-left");
    const back = () => {
      this.pluginFilter = null;
      this.pluginBundlesMode = true;
      this.selectedItem = null;
      this.selectedFilePath = null;
      this.pendingDetailAnimation = "back";
      this.render();
    };
    backBtn.addEventListener("click", back);
    const bundlesCrumb = crumbs.createEl("button", { cls: "skillmanager-crumb", text: "Plugin bundles" });
    bundlesCrumb.addEventListener("click", back);
    crumbs.createSpan({ cls: "skillmanager-crumb-sep", text: "/" });
    crumbs.createEl("button", { cls: "skillmanager-crumb is-current", text: plugin.name });
  }

  // ---------- MCP servers ----------

  /** Read-only visibility into every MCP server found in a tool's own config files (see
   *  mcpScanners.ts) — no enable/disable/delete/start: this is an audit view, not a config
   *  editor, since mutating an MCP server from outside its owning tool would be too destructive
   *  to safely support here. Clicking a card opens a read-only preview (renderMcpServerDetailRail);
   *  the only mutating-adjacent actions are "Open config file" (hands off to the OS's own editor)
   *  and "Copy command" — see openMcpServerCardMenu. */
  private renderMcpServersContent(content: HTMLElement) {
    const header = content.createDiv({ cls: "skillmanager-content-header" });
    const titleRow = header.createDiv({ cls: "skillmanager-title-row" });
    titleRow.createEl("h2", { text: "MCP servers", cls: "skillmanager-title" });
    titleRow.createSpan({ text: String(this.mcpServers.length), cls: "skillmanager-count-pill" });
    const showBanner = this.showWorkspaceBanner();
    if (!showBanner) this.renderWorkspaceChip(titleRow);
    const subtitleRow = header.createDiv({ cls: "skillmanager-subtitle-row" });
    subtitleRow.createDiv({
      text: "Every MCP server found in a tool's config files, across your tools and projects. Enable or disable one from its owning tool, not here.",
      cls: "skillmanager-subtitle",
    });
    this.renderMcpToolFilterButton(subtitleRow);
    if (showBanner) this.renderWorkspaceBanner(header);

    const servers = this.mcpToolFilter ? this.mcpServers.filter((s) => s.tool === this.mcpToolFilter) : this.mcpServers;

    const body = content.createDiv({ cls: "skillmanager-body" });
    const animation = this.pendingDetailAnimation;
    this.pendingDetailAnimation = null;

    const grid = body.createDiv({ cls: `skillmanager-items${this.selectedMcpServer ? " is-docked" : ""}` });
    if (servers.length === 0) {
      grid.createDiv({ text: "No MCP servers found in any configured tool.", cls: "skillmanager-empty" });
    }
    for (const server of servers) this.renderMcpServerCard(grid, server);

    if (this.selectedMcpServer) {
      const rail = body.createDiv({ cls: `skillmanager-detail${animation ? ` skillmanager-panel-enter-${animation}` : ""}` });
      this.renderMcpServerDetailRail(rail, this.selectedMcpServer);
    }
  }

  /** Mirrors renderToolStatusButton's Menu-based dropdown (same classes/shape), scoped to just
   *  the tools that actually have an MCP server rather than every configured tool. */
  private renderMcpToolFilterButton(container: HTMLElement) {
    const tools = this.getSettings().tools.filter((t) => this.mcpServers.some((s) => s.tool === t.id));
    if (tools.length < 2) return;

    const btn = container.createEl("button", { cls: "skillmanager-sort-btn", attr: { "aria-label": "Filter by tool" } });
    const icon = btn.createSpan({ cls: "skillmanager-sort-btn-icon" });
    setIcon(icon, "filter");
    btn.createSpan({
      text: this.mcpToolFilter ? (tools.find((t) => t.id === this.mcpToolFilter)?.name ?? "Tool") : "All tools",
      cls: "skillmanager-sort-btn-label",
    });
    const chevron = btn.createSpan({ cls: "skillmanager-sort-btn-chevron" });
    setIcon(chevron, "chevron-down");
    btn.addEventListener("click", (evt) => {
      const menu = new Menu();
      menu.addItem((menuItem) =>
        menuItem
          .setTitle("All tools")
          .setChecked(this.mcpToolFilter === null)
          .onClick(() => {
            this.mcpToolFilter = null;
            this.render();
          })
      );
      for (const tool of tools) {
        menu.addItem((menuItem) =>
          menuItem
            .setTitle(tool.name)
            .setChecked(this.mcpToolFilter === tool.id)
            .onClick(() => {
              this.mcpToolFilter = tool.id;
              this.render();
            })
        );
      }
      menu.showAtMouseEvent(evt);
    });
  }

  /** Footer-left scope badge, shared verbatim between the card and the detail rail's header so
   *  "Global" vs. "Project: X" reads identically in both — same DOM shape as originLabel's badge
   *  on a real item card (LibraryView.ts's renderCard). */
  private renderMcpScopeBadge(container: HTMLElement, server: McpServerEntry) {
    const badge = container.createDiv({ cls: "skillmanager-card-source" });
    const icon = badge.createSpan({ cls: "skillmanager-card-source-icon" });
    if (server.scope === "global") {
      // Same "globe" icon originLabel uses for a real item's Global badge (sourceLabel.ts) — not
      // "share-2", which is the "Shared" tool's own identity icon (a different concept).
      setIcon(icon, "globe");
      badge.createSpan({ text: "Global", cls: "skillmanager-card-source-text" });
    } else {
      setIcon(icon, projectIcon(server.scope.projectId));
      badge.createSpan({ text: `Project: ${server.scope.projectName}`, cls: "skillmanager-card-source-text" });
    }
  }

  private renderMcpServerCard(container: HTMLElement, server: McpServerEntry) {
    const tool = this.getSettings().tools.find((t) => t.id === server.tool);
    const card = container.createDiv({ cls: "skillmanager-card" });
    if (this.selectedMcpServer?.entryId === server.entryId) card.addClass("is-selected");

    const head = card.createDiv({ cls: "skillmanager-card-head" });
    head.createSpan({ text: server.name, cls: "skillmanager-card-name" });

    if (tool) {
      const toolCaption = card.createDiv({ cls: "skillmanager-card-tool" });
      const toolIcon = toolCaption.createSpan({ cls: "skillmanager-card-tool-icon" });
      this.renderIcon(toolIcon, tool.icon, tool.svgIcon);
      toolCaption.createSpan({ text: tool.name });
    }

    const detail = server.config.command
      ? [server.config.command, ...(server.config.args ?? [])].join(" ")
      : server.config.url ?? "";
    if (detail) card.createDiv({ cls: "skillmanager-card-desc skillmanager-mcp-card-command", text: detail });

    const footer = card.createDiv({ cls: "skillmanager-card-footer" });
    this.renderMcpScopeBadge(footer, server);
    const rightGroup = footer.createDiv({ cls: "skillmanager-card-footer-right" });
    const menuBtn = rightGroup.createEl("button", { cls: "skillmanager-icon-btn", attr: { "aria-label": "More actions" } });
    setIcon(menuBtn, MORE_HORIZONTAL_ICON_ID);
    menuBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.openMcpServerCardMenu(evt, server);
    });

    card.addEventListener("click", () => {
      this.selectedMcpServer = server;
      this.revealedMcpEnvKeys = new Set();
      this.pendingDetailAnimation = "forward";
      this.render();
    });
  }

  private openMcpServerCardMenu(evt: MouseEvent, server: McpServerEntry) {
    const menu = new Menu();
    menu.addItem((menuItem) =>
      menuItem
        .setTitle("Open config file")
        .setIcon("external-link")
        .onClick(() => void this.openMcpConfigFile(server))
    );
    menu.addItem((menuItem) =>
      menuItem
        .setTitle("Open containing folder")
        .setIcon("folder-open")
        .onClick(() => void this.openContainingFolder(server.sourcePath))
    );
    if (server.config.command) {
      menu.addItem((menuItem) =>
        menuItem
          .setTitle("Copy command")
          .setIcon("copy")
          .onClick(() => void this.copyMcpCommand(server))
      );
    }
    menu.showAtMouseEvent(evt);
  }

  /** Obsidian desktop runs on Electron with Node integration enabled for plugins, so its own
   *  `window.require` reaches Electron's `shell` without adding an `electron` devDependency just
   *  for type declarations (the package itself is already external — see esbuild.config.mjs —
   *  but has no types installed). Undefined on a build without Node integration (e.g. mobile).
   *  `trashItem` is included alongside the existing `openPath` here (same object, one call) so
   *  confirmDelete can route a real delete through the OS trash rather than a permanent rm. */
  private electronShell(): { openPath(path: string): Promise<string>; trashItem(path: string): Promise<void> } | null {
    const req = (
      window as unknown as {
        require?: (id: string) => { shell: { openPath(path: string): Promise<string>; trashItem(path: string): Promise<void> } };
      }
    ).require;
    return req ? req("electron").shell : null;
  }

  /** Moves a real file or folder to the OS trash. On macOS this asks Finder to do it, because
   *  only a Finder delete records where the item came from, which is what makes "Put Back" work.
   *  The first call shows macOS's one-time "Obsidian wants to control Finder" prompt; if that's
   *  declined (or Finder fails for any reason) it falls back to Electron's shell.trashItem, which
   *  still trashes the item, just without Put Back. The path is passed to osascript as an
   *  argument, never spliced into the script, so no path can inject AppleScript. */
  private async trashPath(path: string): Promise<void> {
    if (process.platform === "darwin") {
      try {
        const failed = await new Promise<boolean>((resolvePromise) => {
          execFile(
            "osascript",
            ["-e", "on run argv", "-e", 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)', "-e", "end run", path],
            (error) => resolvePromise(error !== null)
          );
        });
        if (!failed) return;
      } catch {
        // Fall through to the Electron trash below.
      }
      // Finder failed or permission was declined. It may still have moved the item.
      if (!existsSync(path)) return;
    }
    const shell = this.electronShell();
    if (!shell) throw new Error("Can't move files to the Recycle Bin/Trash on this device. Try Obsidian's desktop app.");
    await shell.trashItem(path);
  }

  /** Swaps an item's on-disk unit for a freshly fetched copy (Update/Restore). The old real file
   *  or folder goes to the OS trash first instead of being rm'd, so an unwanted update can be
   *  undone by hand. A symlinked folder is still just unlinked (trashing it would only trash the
   *  link anyway), and a symlinked flat file is overwritten in place, same as before. Throws
   *  without touching anything if the trash isn't reachable. */
  private async replaceUnit(source: string, target: string, isDirectory: boolean): Promise<void> {
    if (existsSync(target)) {
      const isLink = lstatSync(target).isSymbolicLink();
      if (isLink && isDirectory) {
        unlinkSync(target);
      } else if (!isLink) {
        await this.trashPath(target);
      }
    }
    cpSync(source, target, isDirectory ? { recursive: true } : undefined);
  }

  private fileManagerLabel(): string {
    if (process.platform === "darwin") return "Reveal in Finder";
    if (process.platform === "win32") return "Show in File Explorer";
    return "Show in file manager";
  }

  /** Opens a directory directly, or reveals a flat file in its containing file manager folder. */
  private async revealItemLocation(item: ItemMetadata) {
    const unit = linkableUnit(item.sourcePath);
    const shell = this.electronShell();
    if (!shell) {
      new Notice("Can't open files from this device, try Obsidian's desktop app.");
      return;
    }
    if (unit.isDirectory) {
      const errorText = await shell.openPath(unit.path);
      if (errorText) new Notice(`Couldn't open ${unit.path}: ${errorText}`);
      return;
    }
    const electron = (window as unknown as { require?: (id: string) => { shell: { showItemInFolder(path: string): void } } }).require;
    if (!electron) {
      new Notice("Can't open files from this device, try Obsidian's desktop app.");
      return;
    }
    try {
      electron("electron").shell.showItemInFolder(unit.path);
    } catch (e) {
      new Notice(`Couldn't reveal ${unit.path}: ${errorMessage(e)}`);
    }
  }

  private async openContainingFolder(filePath: string) {
    const shell = this.electronShell();
    if (!shell) {
      new Notice("Can't open files from this device, try Obsidian's desktop app.");
      return;
    }
    const folderPath = dirname(filePath);
    const errorText = await shell.openPath(folderPath);
    if (errorText) new Notice(`Couldn't open ${folderPath}: ${errorText}`);
  }

  /** Hands off to the OS's own editor rather than writing to the config ourselves — see the plan
   *  notes on why this plugin doesn't parse-and-rewrite a tool's live MCP config. `shell.openPath`
   *  alone uses the OS's default-app association for the file's extension, which for something
   *  like .json or .toml can land on an unexpected app (e.g. Xcode) if the user never set one —
   *  Settings' "Open config file with" lets them force a specific app instead (macOS only, via
   *  `open -a`, the same execFileSync pattern git.ts already uses for shelling out safely). */
  private async openMcpConfigFile(server: McpServerEntry) {
    const preferredApp = this.getSettings().mcpConfigEditorApp.trim();
    if (preferredApp && process.platform === "darwin") {
      try {
        execFileSync("open", ["-a", preferredApp, server.sourcePath]);
      } catch (e) {
        new Notice(`Couldn't open with "${preferredApp}": ${errorMessage(e)}`);
      }
      return;
    }

    const shell = this.electronShell();
    if (!shell) {
      new Notice("Can't open files from this device, try Obsidian's desktop app.");
      return;
    }
    const errorText = await shell.openPath(server.sourcePath);
    if (errorText) new Notice(`Couldn't open ${server.sourcePath}: ${errorText}`);
  }

  private async copyMcpCommand(server: McpServerEntry) {
    if (!server.config.command) return;
    await navigator.clipboard.writeText([server.config.command, ...(server.config.args ?? [])].join(" "));
    new Notice("Command copied to clipboard.");
  }

  private renderMcpServerDetailRail(panel: HTMLElement, server: McpServerEntry) {
    const tool = this.getSettings().tools.find((t) => t.id === server.tool);

    const crumbs = panel.createDiv({ cls: "skillmanager-crumbs" });
    const backBtn = crumbs.createEl("button", { cls: "skillmanager-icon-btn", attr: { "aria-label": "Back" } });
    setIcon(backBtn, "arrow-left");
    const back = () => {
      this.selectedMcpServer = null;
      this.pendingDetailAnimation = "back";
      this.render();
    };
    backBtn.addEventListener("click", back);
    const mcpCrumb = crumbs.createEl("button", { cls: "skillmanager-crumb", text: "MCP servers" });
    mcpCrumb.addEventListener("click", back);
    crumbs.createSpan({ cls: "skillmanager-crumb-sep", text: "/" });
    crumbs.createEl("button", { cls: "skillmanager-crumb is-current", text: server.name });

    const header = panel.createDiv({ cls: "skillmanager-detail-header" });
    if (tool) {
      const headerIcon = header.createSpan({ cls: "skillmanager-tool-card-icon" });
      this.renderIcon(headerIcon, tool.icon, tool.svgIcon);
    }
    header.createEl("h3", { text: server.name, cls: "skillmanager-detail-title" });

    const body = panel.createDiv({ cls: "skillmanager-detail-body" });
    this.renderMcpScopeBadge(body, server);

    const configBox = body.createDiv({ cls: "skillmanager-detail-frontmatter" });
    if (server.config.command) {
      this.renderFrontmatterRow(configBox, "command", [server.config.command, ...(server.config.args ?? [])].join(" "));
    }
    if (server.config.url) this.renderFrontmatterRow(configBox, "url", server.config.url);
    if (server.config.type) this.renderFrontmatterRow(configBox, "type", server.config.type);

    const envEntries = Object.entries(server.config.env ?? {});
    if (envEntries.length > 0) {
      body.createDiv({ cls: "skillmanager-sidebar-heading", text: "Environment variables" });
      const envBox = body.createDiv({ cls: "skillmanager-detail-frontmatter" });
      for (const [key, value] of envEntries) this.renderMcpEnvRow(envBox, key, value);
    }

    body.createDiv({ cls: "skillmanager-sidebar-heading", text: "Config file" });
    body.createDiv({ cls: "skillmanager-card-desc skillmanager-mcp-card-command", text: server.sourcePath });

    const actions = body.createDiv({ cls: "skillmanager-mcp-detail-actions" });
    const openBtn = actions.createEl("button", { cls: "skillmanager-sort-btn" });
    const openIcon = openBtn.createSpan({ cls: "skillmanager-sort-btn-icon" });
    setIcon(openIcon, "external-link");
    openBtn.createSpan({ cls: "skillmanager-sort-btn-label", text: "Open config file" });
    openBtn.addEventListener("click", () => void this.openMcpConfigFile(server));

    if (server.config.command) {
      const copyBtn = actions.createEl("button", { cls: "skillmanager-sort-btn" });
      const copyIcon = copyBtn.createSpan({ cls: "skillmanager-sort-btn-icon" });
      setIcon(copyIcon, "copy");
      copyBtn.createSpan({ cls: "skillmanager-sort-btn-label", text: "Copy command" });
      copyBtn.addEventListener("click", () => void this.copyMcpCommand(server));
    }
  }

  /** Env values are masked by default and revealed one at a time (revealedMcpEnvKeys) — most
   *  MCP servers carry an API key/token in here, so this follows the same "hidden until you ask"
   *  convention as a password field rather than the plaintext frontmatter rows above it.
   *
   *  .skillmanager-fm-row is `display: contents` (its children become direct items of the parent
   *  2-column grid — see renderFrontmatterRow) — so the value and its reveal toggle are wrapped
   *  together in one .skillmanager-mcp-env-value div, kept as the row's single second child,
   *  rather than added as a third direct child that would wrap onto its own grid row. */
  private renderMcpEnvRow(container: HTMLElement, key: string, value: string) {
    const revealed = this.revealedMcpEnvKeys.has(key);
    const row = container.createDiv({ cls: "skillmanager-fm-row" });
    const label = row.createSpan({ cls: "skillmanager-fm-label" });
    label.createSpan({ text: key, cls: "skillmanager-fm-key" });
    label.createSpan({ text: ":", cls: "skillmanager-fm-colon" });

    const valueWrap = row.createDiv({ cls: "skillmanager-mcp-env-value" });
    valueWrap.createSpan({
      text: revealed ? value : "••••••••",
      cls: `skillmanager-fm-value${revealed ? "" : " is-masked"}`,
    });
    const toggle = valueWrap.createEl("button", {
      cls: "skillmanager-icon-btn skillmanager-mcp-reveal-btn",
      attr: { "aria-label": revealed ? `Hide ${key}` : `Reveal ${key}` },
    });
    setIcon(toggle, revealed ? "eye-off" : "eye");
    toggle.addEventListener("click", () => {
      if (revealed) this.revealedMcpEnvKeys.delete(key);
      else this.revealedMcpEnvKeys.add(key);
      this.render();
    });
  }

  // ---------- "All tools" page ----------

  private renderToolsPageContent(content: HTMLElement) {
    const settings = this.getSettings();
    const tools = this.sortedToolsForPage();

    const header = content.createDiv({ cls: "skillmanager-content-header" });
    const titleRow = header.createDiv({ cls: "skillmanager-title-row" });
    titleRow.createEl("h2", { text: "All tools", cls: "skillmanager-title" });
    header.createDiv({
      text: "Every configured tool. Enable or disable one, edit its scanned paths, or add your own.",
      cls: "skillmanager-subtitle",
    });

    const stats = header.createDiv({ cls: "skillmanager-tool-stats" });
    const statValues: [string, number][] = [
      ["Detected", tools.filter((t) => this.toolIsDetected(t)).length],
      ["Enabled", tools.filter((t) => !t.disabled).length],
      ["Custom", tools.filter((t) => t.custom).length],
    ];
    for (const [label, value] of statValues) {
      const stat = stats.createDiv({ cls: "skillmanager-tool-stat" });
      stat.createSpan({ text: String(value), cls: "skillmanager-tool-stat-value" });
      stat.createSpan({ text: label, cls: "skillmanager-tool-stat-label" });
    }
    const actions = stats.createDiv({ cls: "skillmanager-tool-actions" });
    this.renderToolStatusButton(actions);
    const addBtn = actions.createEl("button", { cls: "mod-cta skillmanager-add-tool-btn", text: "+ Add tool" });
    addBtn.addEventListener("click", () => {
      new AddToolModal(this.app, settings, this.saveSettings, () => this.rescan()).open();
    });

    const visibleTools = tools.filter((t) => this.toolMatchesStatusFilter(t));
    const body = content.createDiv({ cls: "skillmanager-body" });
    const grid = body.createDiv({ cls: `skillmanager-items${this.selectedTool ? " is-docked" : ""}` });
    if (visibleTools.length === 0) {
      grid.createDiv({ text: "Nothing matches this filter.", cls: "skillmanager-empty" });
    }
    for (const tool of visibleTools) this.renderToolCard(grid, tool);

    if (this.selectedTool) {
      const rail = body.createDiv({ cls: "skillmanager-detail" });
      this.renderToolDetailRail(rail, this.selectedTool);
    }
  }

  /** "Detected" means at least one of this tool's configured global paths actually resolves to a
   *  real directory on disk right now — independent of enabled state or item count, since a
   *  correctly-configured tool with zero skills yet is still "detected." */
  private toolIsDetected(tool: ToolConfig): boolean {
    return Object.values(tool.paths).some((p) => p && existsSync(expandHome(p)))
      || (tool.ruleAdditionalPaths ?? []).some((e) => e.path.trim() && existsSync(expandHome(e.path.trim())))
      || (tool.mcpConfigPath ? existsSync(expandHome(tool.mcpConfigPath)) : false)
      || (tool.pluginsRegistry ? existsSync(expandHome(tool.pluginsRegistry)) : false)
      || (tool.pluginsPaths ?? []).some((p) => p && existsSync(expandHome(p)))
      || (tool.memoryPath?.trim() ? existsSync(expandHome(tool.memoryPath.trim())) : false);
  }

  private toolMatchesStatusFilter(tool: ToolConfig): boolean {
    switch (this.toolStatusFilter) {
      case "all":
        return true;
      case "detected":
        return this.toolIsDetected(tool);
      case "not-detected":
        return !this.toolIsDetected(tool);
      case "enabled":
        return !tool.disabled;
      case "disabled":
        return !!tool.disabled;
      case "custom":
        return !!tool.custom;
    }
  }

  private renderToolStatusButton(container: HTMLElement) {
    const labels: Record<Exclude<typeof this.toolStatusFilter, "all">, string> = {
      detected: "Detected",
      "not-detected": "Not detected",
      enabled: "Enabled",
      disabled: "Disabled",
      custom: "Custom",
    };
    const btn = container.createEl("button", { cls: "skillmanager-sort-btn", attr: { "aria-label": "Filter tools" } });
    const icon = btn.createSpan({ cls: "skillmanager-sort-btn-icon" });
    setIcon(icon, "filter");
    btn.createSpan({
      text: this.toolStatusFilter === "all" ? "All tools" : labels[this.toolStatusFilter],
      cls: "skillmanager-sort-btn-label",
    });
    const chevron = btn.createSpan({ cls: "skillmanager-sort-btn-chevron" });
    setIcon(chevron, "chevron-down");
    btn.addEventListener("click", (evt) => {
      const menu = new Menu();
      menu.addItem((menuItem) =>
        menuItem
          .setTitle("All tools")
          .setChecked(this.toolStatusFilter === "all")
          .onClick(() => {
            this.toolStatusFilter = "all";
            this.render();
          })
      );
      for (const key of Object.keys(labels) as (keyof typeof labels)[]) {
        menu.addItem((menuItem) =>
          menuItem
            .setTitle(labels[key])
            .setChecked(this.toolStatusFilter === key)
            .onClick(() => {
              this.toolStatusFilter = key;
              this.render();
            })
        );
      }
      menu.showAtMouseEvent(evt);
    });
  }

  /** Enabled-with-content first, then enabled-and-detected-but-empty, then enabled-but-not-even-
   *  detected, then disabled last regardless of anything else — so the tools actually worth
   *  looking at float to the top and a pile of unused/misconfigured/disabled ones sink down
   *  instead of being interleaved alphabetically with the ones that matter. Alphabetical within
   *  each tier for stability. */
  private sortedToolsForPage(): ToolConfig[] {
    const tier = (tool: ToolConfig): number => {
      if (tool.disabled) return 3;
      if (this.items.some((i) => i.tool === tool.id)) return 0;
      if (this.toolIsDetected(tool)) return 1;
      return 2;
    };
    return [...this.getSettings().tools].sort((a, b) => tier(a) - tier(b) || a.name.localeCompare(b.name));
  }

  private async toggleToolDisabled(tool: ToolConfig) {
    tool.disabled = !tool.disabled;
    await this.saveSettings();
    await this.rescan();
  }

  private renderToolCard(container: HTMLElement, tool: ToolConfig) {
    const card = container.createDiv({ cls: "skillmanager-card skillmanager-tool-card" });
    if (tool.disabled) card.addClass("is-off");
    if (this.selectedTool?.id === tool.id) card.addClass("is-selected");

    const head = card.createDiv({ cls: "skillmanager-card-head" });
    const detected = this.toolIsDetected(tool);
    head.createSpan({
      cls: `skillmanager-card-dot${detected ? " is-detected" : ""}`,
      attr: { "aria-label": detected ? "Detected on disk" : "Not detected: check its paths" },
    });
    const icon = head.createSpan({ cls: "skillmanager-tool-card-icon" });
    this.renderIcon(icon, tool.icon, tool.svgIcon);
    head.createSpan({ text: tool.name, cls: "skillmanager-card-name" });
    if (tool.custom) {
      head.createSpan({ text: "Custom", cls: "skillmanager-card-type skillmanager-card-type-sm" });
    }

    const toggle = head.createEl("button", {
      cls: `skillmanager-toggle${!tool.disabled ? " is-on" : ""}`,
      attr: { "aria-label": tool.disabled ? "Enable" : "Disable" },
    });
    toggle.addEventListener("click", (evt) => {
      evt.stopPropagation();
      void this.toggleToolDisabled(tool);
    });

    const count = this.items.filter((i) => i.tool === tool.id).length;
    card.createDiv({
      cls: "skillmanager-card-desc",
      text: `${count} item${count === 1 ? "" : "s"}${tool.disabled ? " (disabled)" : ""}`,
    });

    card.addEventListener("click", () => {
      this.selectedTool = tool;
      this.pendingDetailAnimation = "forward";
      this.render();
    });
  }

  /** One labeled path input with live found/not-found status, in this view's own raw-DOM style
   *  (this file never uses Obsidian's Setting class, unlike every modal) — the in-app replacement
   *  for what used to be Settings' attachPathStatus-driven accordion. `resolve` turns the raw
   *  typed value into the absolute path to check; return null to skip checking. Fires on blur
   *  (the "change" event), not per keystroke — a rescan() follows every edit, and that's real
   *  filesystem work, not something to trigger on every character typed. */
  private renderToolPathField(
    container: HTMLElement,
    label: string,
    value: string,
    placeholder: string,
    resolve: (raw: string) => string | null,
    onChange: (value: string) => void
  ) {
    const row = container.createDiv({ cls: "skillmanager-toolpath-row" });
    row.createSpan({ text: label, cls: "skillmanager-toolpath-label" });
    const input = row.createEl("input", { type: "text", cls: "skillmanager-toolpath-input", attr: { placeholder } });
    input.value = value;
    const status = row.createSpan({ cls: "skillmanager-path-status" });
    const updateStatus = (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) {
        status.setText("");
        status.title = "";
        status.className = "skillmanager-path-status";
        return;
      }
      const resolved = resolve(trimmed);
      const found = resolved !== null && existsSync(resolved);
      status.setText(found ? "found" : "not found");
      status.title = resolved ?? "";
      status.className = `skillmanager-path-status ${found ? "is-found" : "is-missing"}`;
    };
    updateStatus(value);
    input.addEventListener("change", () => {
      onChange(input.value);
      updateStatus(input.value);
    });
  }

  /** Repeatable extra path rows shown right under the Rules field's one renderToolPathField row
   *  (see renderToolDetailRail) — lets a tool that genuinely reads rules from more than one place
   *  list all of them, e.g. Cursor's legacy single ".cursorrules" file alongside its current
   *  ".cursor/rules/" directory. Each row carries its own "Single file" checkbox (RulePathEntry)
   *  rather than inferring the shape from disk, since a toggled-off single file doesn't exist at
   *  its own path any more (see itemToggle.ts) and would be indistinguishable from an
   *  as-yet-uncreated directory. */
  private renderRuleAdditionalPaths(container: HTMLElement, tool: ToolConfig, scope: "global" | "project") {
    const entries = (scope === "global" ? tool.ruleAdditionalPaths : tool.ruleAdditionalProjectPaths) ?? [];
    const vaultPath = this.vaultPath();
    const resolve = (raw: string) => (scope === "global" ? expandHome(raw) : vaultPath ? join(vaultPath, raw) : null);

    // Drops any row left blank (e.g. a "+ Add path" click nobody filled in) rather than
    // persisting a dangling entry — same spirit as renderToolPathField deleting an emptied field.
    const commit = (next: RulePathEntry[]) => {
      const trimmed = next.filter((e) => e.path.trim());
      if (scope === "global") {
        if (trimmed.length) tool.ruleAdditionalPaths = trimmed;
        else delete tool.ruleAdditionalPaths;
      } else {
        if (trimmed.length) tool.ruleAdditionalProjectPaths = trimmed;
        else delete tool.ruleAdditionalProjectPaths;
      }
      void this.saveSettings().then(() => this.rescan());
    };

    entries.forEach((entry, i) => {
      const row = container.createDiv({ cls: "skillmanager-toolpath-row" });
      row.createSpan({ cls: "skillmanager-toolpath-label" });
      const input = row.createEl("input", {
        type: "text",
        cls: "skillmanager-toolpath-input",
        attr: { placeholder: scope === "global" ? "~/.example/extra-rules" : "extra-rules" },
      });
      input.value = entry.path;
      const fileLabel = row.createEl("label", { cls: "skillmanager-toolpath-checkbox" });
      const checkbox = fileLabel.createEl("input", { type: "checkbox" });
      checkbox.checked = entry.singleFile;
      fileLabel.createSpan({ text: "Single file" });
      const status = row.createSpan({ cls: "skillmanager-path-status" });
      const updateStatus = () => {
        const trimmedVal = input.value.trim();
        if (!trimmedVal) {
          status.setText("");
          status.className = "skillmanager-path-status";
          return;
        }
        const resolved = resolve(trimmedVal);
        const found = resolved !== null && existsSync(resolved);
        status.setText(found ? "found" : "not found");
        status.title = resolved ?? "";
        status.className = `skillmanager-path-status ${found ? "is-found" : "is-missing"}`;
      };
      updateStatus();
      input.addEventListener("change", () => {
        entry.path = input.value.trim();
        updateStatus();
        commit(entries);
      });
      checkbox.addEventListener("change", () => {
        entry.singleFile = checkbox.checked;
        commit(entries);
      });
      const removeBtn = row.createEl("button", { cls: "skillmanager-icon-btn", attr: { "aria-label": "Remove path" } });
      setIcon(removeBtn, "x");
      removeBtn.addEventListener("click", () => commit(entries.filter((_, j) => j !== i)));
    });

    const addRow = container.createDiv({ cls: "skillmanager-toolpath-row" });
    addRow.createSpan({ cls: "skillmanager-toolpath-label" });
    const addBtn = addRow.createEl("button", { cls: "skillmanager-toolpath-add-btn", text: "+ Add rule path" });
    addBtn.addEventListener("click", () => {
      const next = [...entries, { path: "", singleFile: false }];
      if (scope === "global") tool.ruleAdditionalPaths = next;
      else tool.ruleAdditionalProjectPaths = next;
      this.render();
    });
  }

  private vaultPath(): string | null {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }

  private renderToolDetailRail(panel: HTMLElement, tool: ToolConfig) {
    const crumbs = panel.createDiv({ cls: "skillmanager-crumbs" });
    const backBtn = crumbs.createEl("button", { cls: "skillmanager-icon-btn", attr: { "aria-label": "Back" } });
    setIcon(backBtn, "arrow-left");
    const back = () => {
      this.selectedTool = null;
      this.pendingDetailAnimation = "back";
      this.render();
    };
    backBtn.addEventListener("click", back);
    const toolsCrumb = crumbs.createEl("button", { cls: "skillmanager-crumb", text: "All tools" });
    toolsCrumb.addEventListener("click", back);
    crumbs.createSpan({ cls: "skillmanager-crumb-sep", text: "/" });
    crumbs.createEl("button", { cls: "skillmanager-crumb is-current", text: tool.name });

    const header = panel.createDiv({ cls: "skillmanager-detail-header" });
    const headerIcon = header.createSpan({ cls: "skillmanager-tool-card-icon" });
    this.renderIcon(headerIcon, tool.icon, tool.svgIcon);
    header.createEl("h3", { text: tool.name, cls: "skillmanager-detail-title" });
    if (tool.custom) {
      const removeBtn = header.createDiv({ cls: "skillmanager-detail-actions" }).createEl("button", {
        cls: "skillmanager-icon-btn",
        attr: { "aria-label": "Remove tool" },
      });
      setIcon(removeBtn, "trash-2");
      removeBtn.addEventListener("click", () => void this.removeCustomTool(tool));
    }

    const body = panel.createDiv({ cls: "skillmanager-detail-body" });

    body.createDiv({ cls: "skillmanager-sidebar-heading", text: "Global paths" });
    for (const type of Object.keys(TYPE_LABELS) as ItemType[]) {
      this.renderToolPathField(
        body,
        TYPE_LABELS[type],
        tool.paths[type] ?? "",
        tool.unconfirmedPaths?.[type] ?? "~/.example/path",
        (raw) => expandHome(raw),
        (value) => {
          if (value.trim()) {
            tool.paths[type] = value.trim();
          } else {
            delete tool.paths[type];
          }
          void this.saveSettings().then(() => this.rescan());
        }
      );
      if (type === "rule") this.renderRuleAdditionalPaths(body, tool, "global");
    }
    // Kept as "" when cleared (not deleted) so a built-in default doesn't come back on reload;
    // see ToolConfig.memoryPath.
    this.renderToolPathField(
      body,
      "Memories",
      tool.memoryPath ?? "",
      "~/.example/memory",
      (raw) => expandHome(raw),
      (value) => {
        tool.memoryPath = value.trim();
        void this.saveSettings().then(() => this.rescan());
      }
    );
    body.createDiv({
      cls: "setting-item-description",
      text: "Folder of memory files the agent writes itself. Per-project subfolders (<project>/memory) are matched to your workspaces. Listed under Memories & Rules.",
    });

    body.createDiv({ cls: "skillmanager-sidebar-heading", text: "Project-scoped paths" });
    body.createDiv({
      cls: "setting-item-description",
      text: "Optional override for this tool's layout inside a project folder. Leave blank to use the global path above with the home directory stripped.",
    });
    const vaultPath = this.vaultPath();
    for (const type of Object.keys(TYPE_LABELS) as ItemType[]) {
      const globalPath = tool.paths[type];
      this.renderToolPathField(
        body,
        TYPE_LABELS[type],
        tool.projectPaths?.[type] ?? "",
        globalPath ? toProjectRelative(globalPath) : "(not scanned globally)",
        (raw) => (vaultPath ? join(vaultPath, raw) : null),
        (value) => {
          if (value.trim()) {
            tool.projectPaths = tool.projectPaths ?? {};
            tool.projectPaths[type] = value.trim();
          } else if (tool.projectPaths) {
            delete tool.projectPaths[type];
            if (Object.keys(tool.projectPaths).length === 0) delete tool.projectPaths;
          }
          void this.saveSettings().then(() => this.rescan());
        }
      );
      if (type === "rule") this.renderRuleAdditionalPaths(body, tool, "project");
    }
    this.renderToolPathField(
      body,
      "Memories",
      tool.projectMemoryPath ?? "",
      ".example/memory",
      (raw) => (vaultPath ? join(vaultPath, raw) : null),
      (value) => {
        if (value.trim()) tool.projectMemoryPath = value.trim();
        else delete tool.projectMemoryPath;
        void this.saveSettings().then(() => this.rescan());
      }
    );

    body.createDiv({ cls: "skillmanager-sidebar-heading", text: "MCP servers" });
    body.createDiv({
      cls: "setting-item-description",
      text: "Optional: point at this tool's MCP server config file(s) so they show up on the MCP servers page. Leave blank if not applicable.",
    });
    this.renderToolPathField(
      body,
      "Global config",
      tool.mcpConfigPath ?? "",
      "~/.example/mcp.json",
      (raw) => expandHome(raw),
      (value) => {
        if (value.trim()) tool.mcpConfigPath = value.trim();
        else delete tool.mcpConfigPath;
        void this.saveSettings().then(() => this.rescan());
      }
    );
    this.renderToolPathField(
      body,
      "Project config",
      tool.projectMcpConfigPath ?? "",
      ".example/mcp.json",
      (raw) => (vaultPath ? join(vaultPath, raw) : null),
      (value) => {
        if (value.trim()) tool.projectMcpConfigPath = value.trim();
        else delete tool.projectMcpConfigPath;
        void this.saveSettings().then(() => this.rescan());
      }
    );
    this.renderToolTextField(
      body,
      "Server list key (advanced)",
      tool.mcpConfigKey ?? "",
      "mcpServers",
      (value) => {
        if (value.trim()) tool.mcpConfigKey = value.trim();
        else delete tool.mcpConfigKey;
        void this.saveSettings().then(() => this.rescan());
      }
    );

    body.createDiv({ cls: "skillmanager-sidebar-heading", text: "Plugin bundles" });
    body.createDiv({
      cls: "setting-item-description",
      text: "Optional: point at this tool's installed plugin registry or cache so bundled skills, agents, and commands show up in the Plugin bundles page.",
    });
    if (tool.pluginsRegistry !== undefined || tool.pluginsSettingsPath !== undefined) {
      this.renderToolPathField(
        body,
        "Installed registry",
        tool.pluginsRegistry ?? "",
        "~/.example/plugins/installed_plugins.json",
        (raw) => expandHome(raw),
        (value) => {
          if (value.trim()) tool.pluginsRegistry = value.trim();
          else delete tool.pluginsRegistry;
          void this.saveSettings().then(() => this.rescan());
        }
      );
    }
    if (tool.pluginsPaths !== undefined || tool.pluginsRegistry === undefined) {
      this.renderToolPathField(
        body,
        "Installed cache",
        tool.pluginsPaths?.[0] ?? "",
        "~/.example/plugins/cache",
        (raw) => expandHome(raw),
        (value) => {
          if (value.trim()) tool.pluginsPaths = [value.trim(), ...(tool.pluginsPaths?.slice(1) ?? [])];
          else if (tool.pluginsPaths) {
            const rest = tool.pluginsPaths.slice(1);
            if (rest.length > 0) tool.pluginsPaths = rest;
            else delete tool.pluginsPaths;
          }
          void this.saveSettings().then(() => this.rescan());
        }
      );
    }
    if (tool.pluginsSettingsPath !== undefined) {
      this.renderToolPathField(
        body,
        "Plugin settings",
        tool.pluginsSettingsPath,
        "~/.example/settings.json",
        (raw) => expandHome(raw),
        (value) => {
          if (value.trim()) tool.pluginsSettingsPath = value.trim();
          else delete tool.pluginsSettingsPath;
          void this.saveSettings().then(() => this.rescan());
        }
      );
    }
  }

  /** Same row shape as renderToolPathField, minus the found/not-found status pill — for a field
   *  that isn't a filesystem path (e.g. the JSON key a tool's MCP config nests its server map
   *  under), where that pill would misleadingly read "not found" for every valid value. */
  private renderToolTextField(container: HTMLElement, label: string, value: string, placeholder: string, onChange: (value: string) => void) {
    const row = container.createDiv({ cls: "skillmanager-toolpath-row" });
    row.createSpan({ text: label, cls: "skillmanager-toolpath-label" });
    const input = row.createEl("input", { type: "text", cls: "skillmanager-toolpath-input", attr: { placeholder } });
    input.value = value;
    input.addEventListener("change", () => onChange(input.value));
  }

  private async removeCustomTool(tool: ToolConfig) {
    const settings = this.getSettings();
    settings.tools = settings.tools.filter((t) => t.id !== tool.id);
    this.selectedTool = null;
    await this.saveSettings();
    await this.rescan();
  }


  /** Three regions: the "All" chip pinned at the start (never scrolls — it's the anchor/clear,
   *  not content), a horizontally-scrolling middle for Untagged + however many tags there are
   *  (wrapping to multiple lines would push the whole toolbar taller as the tag list grows;
   *  scrolling keeps this row a fixed height instead), and the sort/source controls pinned at
   *  the end. Scroll position is tracked (tagbarScrollLeft) and restored after every re-render —
   *  selecting a tag re-renders the whole view, and without this the scroll region would silently
   *  snap back to the start on every click. Only the "All" chip explicitly resets it to 0. */
  private renderTagBar(tagbar: HTMLElement) {
    const allTags = Array.from(new Set(this.items.flatMap((item) => item.tags))).sort((a, b) => a.localeCompare(b));

    // Toggling the active chip back off works, but it's not a visible affordance — this is the
    // dedicated "clear" chip so getting out of a tag filter doesn't mean hunting for whichever
    // chip is currently selected.
    const allChip = tagbar.createEl("button", { text: "All", cls: "skillmanager-chip skillmanager-tagbar-anchor" });
    if (!this.tagFilter && !this.untaggedOnly) allChip.addClass("is-active");
    allChip.addEventListener("click", () => {
      this.tagFilter = null;
      this.untaggedOnly = false;
      this.tagbarScrollLeft = 0;
      this.render();
    });

    const scroll = tagbar.createDiv({ cls: "skillmanager-tagbar-scroll" });
    scroll.scrollLeft = this.tagbarScrollLeft;
    scroll.addEventListener("scroll", () => {
      this.tagbarScrollLeft = scroll.scrollLeft;
    });

    const untagged = scroll.createEl("button", { text: "Untagged", cls: "skillmanager-chip skillmanager-chip-untagged" });
    if (this.untaggedOnly) untagged.addClass("is-active");
    untagged.addEventListener("click", () => {
      this.untaggedOnly = !this.untaggedOnly;
      if (this.untaggedOnly) this.tagFilter = null;
      this.render();
    });

    for (const tag of allTags) {
      const chip = scroll.createEl("button", { text: tag, cls: `skillmanager-chip skillmanager-tag-c${tagColorIndex(tag)}` });
      if (this.tagFilter === tag) chip.addClass("is-active");
      chip.addEventListener("click", () => {
        this.tagFilter = this.tagFilter === tag ? null : tag;
        this.untaggedOnly = false;
        this.render();
      });
    }

    const controls = tagbar.createDiv({ cls: "skillmanager-tagbar-controls" });
    this.renderFilterButton(controls);
    this.renderSortButton(controls);
    this.renderLayoutToggle(controls);
  }

  /** Grid/list switch. The choice is saved, so the library reopens in the same layout. */
  private renderLayoutToggle(container: HTMLElement) {
    const group = container.createDiv({ cls: "skillmanager-layout-toggle" });
    const current = this.getSettings().libraryLayout;
    const option = (layout: LibraryLayout, icon: string, label: string) => {
      const btn = group.createEl("button", {
        cls: `skillmanager-layout-btn${current === layout ? " is-active" : ""}`,
        attr: { "aria-label": label, "aria-pressed": String(current === layout) },
      });
      setIcon(btn, icon);
      btn.addEventListener("click", () => {
        if (this.getSettings().libraryLayout === layout) return;
        this.getSettings().libraryLayout = layout;
        this.wasDocked = false;
        void this.saveSettings();
        this.render();
      });
    };
    option("grid", "layout-grid", "Grid view");
    option("list", "list", "List view");
  }

  /** One Filter button in place of separate per-dimension dropdowns: a single menu with a
   *  section per dimension (source, scope, type, rule kind, tool). A section is left out when the
   *  sidebar scope already fixes that dimension (no Type on a type page, no Scope on a workspace
   *  page), and an option only appears when picking it would show something; each count is what
   *  the list would hold with that option picked and every other filter kept. While anything is
   *  active the button shows the count with an attached x that clears it all in one click; the
   *  menu ends with the same "Clear all" for anyone already in it. */
  private renderFilterButton(container: HTMLElement) {
    const activeLabels = this.activeFilterLabels();
    const group = container.createDiv({ cls: "skillmanager-filter-group" });
    const btn = group.createEl("button", {
      cls: `skillmanager-sort-btn${activeLabels.length > 0 ? " is-active" : ""}`,
      attr: { "aria-label": activeLabels.length > 0 ? `Filters: ${activeLabels.join(", ")}` : "Filter" },
    });
    setIcon(btn.createSpan({ cls: "skillmanager-sort-btn-icon" }), "filter");
    btn.createSpan({ text: activeLabels.length > 0 ? `Filter (${activeLabels.length})` : "Filter", cls: "skillmanager-sort-btn-label" });
    setIcon(btn.createSpan({ cls: "skillmanager-sort-btn-chevron" }), "chevron-down");
    if (activeLabels.length > 0) {
      const clearBtn = group.createEl("button", {
        cls: "skillmanager-filter-clear",
        attr: { "aria-label": `Clear filters: ${activeLabels.join(", ")}` },
      });
      setIcon(clearBtn, "x");
      clearBtn.addEventListener("click", () => {
        this.clearFilters();
        this.render();
      });
    }

    btn.addEventListener("click", (evt) => {
      const menu = new Menu();
      const settings = this.getSettings();
      const countFor = (dim: FilterDimension, match: (item: ItemMetadata) => boolean) =>
        this.items.filter((item) => this.matchesFilters(item, dim) && match(item)).length;
      const section = <K extends string>(
        title: string,
        dim: FilterDimension,
        options: { key: K; label: string; match: (item: ItemMetadata) => boolean }[],
        current: K | null,
        set: (key: K | null) => void
      ) => {
        const shown = options
          .map((option) => ({ ...option, count: countFor(dim, option.match) }))
          .filter((option) => option.count > 0 || option.key === current);
        // A single option can't narrow anything, so the section would only be noise.
        if (shown.length < 2 && current === null) return;
        menu.addItem((item) => item.setTitle(title).setIsLabel(true));
        menu.addItem((item) =>
          item
            .setTitle("All")
            .setChecked(current === null)
            .onClick(() => {
              set(null);
              this.render();
            })
        );
        for (const option of shown) {
          menu.addItem((item) =>
            item
              .setTitle(`${option.label} (${option.count})`)
              .setChecked(current === option.key)
              .onClick(() => {
                set(option.key);
                this.render();
              })
          );
        }
        menu.addSeparator();
      };

      section(
        "Source",
        "source",
        (Object.keys(SOURCE_FILTER_LABELS) as (keyof typeof SOURCE_FILTER_LABELS)[]).map((key) => ({
          key,
          label: SOURCE_FILTER_LABELS[key],
          match: (item: ItemMetadata) =>
            key === "github" ? !!item.sourceRepo : key === "builtin" ? this.isBuiltIn(item) : !item.sourceRepo && !this.isBuiltIn(item),
        })),
        this.sourceFilter,
        (key) => (this.sourceFilter = key)
      );
      if (!this.projectFilter) {
        section(
          "Scope",
          "scope",
          [
            { key: "global", label: "Global", match: (item: ItemMetadata) => item.projectId === null },
            ...this.getAllProjects().map((project) => ({
              key: project.id,
              label: project.name,
              match: (item: ItemMetadata) => item.projectId === project.id,
            })),
          ],
          this.pageScopeFilter,
          (key) => (this.pageScopeFilter = key)
        );
      }
      if (!this.typeFilter) {
        section(
          "Type",
          "type",
          (Object.keys(TYPE_LABELS) as ItemType[]).map((type) => ({
            key: type,
            label: TYPE_CATEGORY_LABELS[type],
            match: (item: ItemMetadata) => item.type === type,
          })),
          this.pageTypeFilter,
          (key) => {
            this.pageTypeFilter = key;
            // Kind only means something for Memories & Rules; drop it once that's not in view.
            if (key !== "rule") this.ruleKindFilter = null;
          }
        );
      }
      if (this.typeFilter === "rule" || this.pageTypeFilter === "rule") {
        section(
          "Kind",
          "kind",
          (Object.keys(RULE_KIND_LABELS) as RuleKind[]).map((kind) => ({
            key: kind,
            label: RULE_KIND_LABELS[kind],
            match: (item: ItemMetadata) => item.type === "rule" && this.ruleKindOf(item) === kind,
          })),
          this.ruleKindFilter,
          (key) => (this.ruleKindFilter = key)
        );
      }
      if (!this.toolFilter) {
        section(
          "Tool",
          "tool",
          settings.tools.map((tool) => ({ key: tool.id, label: tool.name, match: (item: ItemMetadata) => item.tool === tool.id })),
          this.pageToolFilter,
          (key) => (this.pageToolFilter = key)
        );
      }

      menu.addItem((item) =>
        item
          .setTitle("Clear all")
          .setIcon("x")
          .setDisabled(activeLabels.length === 0)
          .onClick(() => {
            this.clearFilters();
            this.render();
          })
      );
      menu.showAtMouseEvent(evt);
    });
  }

  private renderSortButton(tagbar: HTMLElement) {
    const current = SORT_OPTIONS.find((o) => o.key === this.sortOrder) ?? SORT_OPTIONS[0];
    const btn = tagbar.createEl("button", { cls: "skillmanager-sort-btn", attr: { "aria-label": "Sort by" } });
    const icon = btn.createSpan({ cls: "skillmanager-sort-btn-icon" });
    setIcon(icon, "arrow-up-down");
    btn.createSpan({ text: current.label, cls: "skillmanager-sort-btn-label" });
    const chevron = btn.createSpan({ cls: "skillmanager-sort-btn-chevron" });
    setIcon(chevron, "chevron-down");
    btn.addEventListener("click", (evt) => {
      const menu = new Menu();
      for (const option of SORT_OPTIONS) {
        menu.addItem((menuItem) =>
          menuItem
            .setTitle(option.label)
            .setChecked(this.sortOrder === option.key)
            .onClick(() => {
              this.sortOrder = option.key;
              this.render();
            })
        );
      }
      menu.showAtMouseEvent(evt);
    });
  }

  /** Collapses a skill's project-linked instances into its global card wherever both are
   *  visible in the current scope, so linking a skill into 3 projects reads as one card (its
   *  link icon opens the full list) instead of 4 near-identical cards. Only applies outside a
   *  project filter — filtered to one Project Workspace, every row is a distinct physical
   *  file/symlink and stays its own card. A project instance whose global sibling isn't in view
   *  (search/type/tool filtered it out, or it's genuinely project-native with no global
   *  counterpart) falls back to its own standalone card rather than silently disappearing. */
  private groupedRows(items: ItemMetadata[]): ItemMetadata[] {
    // The unscoped All page is an inventory of physical entries, so show the source and every
    // project/tool symlink as its own card. Narrowed views can still collapse linked instances
    // against their global sibling to keep a project link from looking like a duplicate.
    if (this.projectFilter || !this.isScoped()) return items;

    const rows: ItemMetadata[] = [];
    for (const item of items) {
      if (item.projectId !== null) {
        const hasVisibleGlobalSibling = items.some((i) => i.projectId === null && i.realPath === item.realPath);
        if (hasVisibleGlobalSibling) continue;
      }
      rows.push(item);
    }
    return rows;
  }

  private renderItems(container: HTMLElement, items: ItemMetadata[]) {
    container.empty();

    if (items.length === 0) {
      const query = this.search.trim();
      if (query || this.activeFilterLabels().length > 0) {
        this.renderNoMatchesEmptyState(container, query);
        return;
      }
      if (this.favoritesOnly) {
        this.renderFavoritesEmptyState(container);
        return;
      }
      this.renderEmptyScopeState(container);
      return;
    }

    for (const item of this.groupedRows(items)) {
      this.renderCard(container, item);
    }
  }

  /** Zero results because of a search or in-page filters, not because the page is empty. Names
   *  what's narrowing the list so a forgotten filter is obvious, offers to clear it, and, when a
   *  search finds things elsewhere in the library, offers to jump there. */
  private renderNoMatchesEmptyState(container: HTMLElement, query: string) {
    const filters = this.activeFilterLabels();
    const empty = container.createDiv({ cls: "skillmanager-empty-state" });
    setIcon(empty.createDiv({ cls: "skillmanager-empty-state-icon" }), "search-x");
    empty.createEl("h3", {
      text: query ? `No matches for "${query}"` : "No items match these filters",
      cls: "skillmanager-empty-state-title",
    });
    if (filters.length > 0) {
      empty.createEl("p", {
        cls: "skillmanager-empty-state-desc",
        text: `${this.isScoped() ? `In ${this.scopeTitle()}, filtered` : "Filtered"} by: ${filters.join(", ")}.`,
      });
    } else if (this.isScoped()) {
      empty.createEl("p", { cls: "skillmanager-empty-state-desc", text: `Searched in ${this.scopeTitle()} only.` });
    }

    const actions = empty.createDiv({ cls: "skillmanager-empty-state-actions" });
    if (filters.length > 0) {
      actions.createEl("button", { text: "Clear filters", cls: "mod-cta" }).addEventListener("click", () => {
        this.clearFilters();
        this.render();
      });
    }
    if (query) {
      // Same match rule as filteredItems' search, across the whole library with nothing else applied.
      const lower = query.toLowerCase();
      const everywhere = this.items.filter(
        (item) => !this.isToolDisabled(item.tool) && `${item.name} ${item.description}`.toLowerCase().includes(lower)
      ).length;
      if (everywhere > 0 && this.isScoped()) {
        const label = `Show ${everywhere} ${everywhere === 1 ? "match" : "matches"} in all items`;
        actions.createEl("button", { text: label, cls: filters.length > 0 ? "" : "mod-cta" }).addEventListener("click", () => {
          this.clearScopeFilters();
          this.clearFilters();
          this.render();
        });
      }
      actions.createEl("button", { text: "Clear search" }).addEventListener("click", () => {
        this.search = "";
        this.render();
      });
    }
  }

  /** Nothing in this scope at all, with no search or filter involved. Points at the two ways
   *  items get here: installing something new, or rescanning after adding files by hand. */
  private renderEmptyScopeState(container: HTMLElement) {
    const empty = container.createDiv({ cls: "skillmanager-empty-state" });
    setIcon(empty.createDiv({ cls: "skillmanager-empty-state-icon" }), "inbox");
    const scoped = this.isScoped();
    empty.createEl("h3", {
      text: scoped ? `Nothing in ${this.scopeTitle()} yet` : "Nothing found yet",
      cls: "skillmanager-empty-state-title",
    });
    empty.createEl("p", {
      cls: "skillmanager-empty-state-desc",
      text: "Find something to install, or rescan if you've added files yourself. Still missing? Check where each tool looks for files in its settings.",
    });
    const actions = empty.createDiv({ cls: "skillmanager-empty-state-actions" });
    actions.createEl("button", { text: "Find skills to install", cls: "mod-cta" }).addEventListener("click", () => {
      this.clearScopeFilters();
      this.discoverMode = true;
      this.render();
    });
    actions.createEl("button", { text: "Rescan tools" }).addEventListener("click", () => {
      void this.rescan();
    });
  }

  /** Favourites starts empty for every new user, so — unlike the generic "rescan tools" message,
   *  which would be actively wrong advice here (rescanning finds nothing new; starring does) —
   *  this gets its own explanation plus a one-click way back to the full library to go star
   *  something. A search or filter miss inside Favourites goes to renderNoMatchesEmptyState. */
  private renderFavoritesEmptyState(container: HTMLElement) {
    const empty = container.createDiv({ cls: "skillmanager-empty-state" });
    const icon = empty.createDiv({ cls: "skillmanager-empty-state-icon" });
    setIcon(icon, "star");
    empty.createEl("h3", { text: "No favourites yet", cls: "skillmanager-empty-state-title" });
    empty.createEl("p", {
      cls: "skillmanager-empty-state-desc",
      text: "Star the skills, agents, and commands you reach for most and they'll show up here for quick access.",
    });
    const browseBtn = empty.createEl("button", { text: "Browse library", cls: "mod-cta" });
    browseBtn.addEventListener("click", () => {
      this.clearScopeFilters();
      this.render();
    });
  }

  /** List layout: one bordered row per item with Name, Tool, Type, Scope, Sessions and Last used.
   *  Name, Sessions and Last used headers sort. Once an item is open the list docks to the same
   *  narrow rail as the grid and drops to Name + Sessions (the "is-wide" cells hide in CSS). */
  private renderItemList(container: HTMLElement, items: ItemMetadata[]) {
    if (items.length === 0) {
      this.renderItems(container, items);
      return;
    }
    container.empty();
    const rows = this.groupedRows(items);

    const head = container.createDiv({ cls: "skillmanager-list-row skillmanager-list-head" });
    const column = (label: string, cls: string, order?: SortOrder) => {
      const cell = head.createDiv({ cls: `skillmanager-list-cell ${cls}` });
      cell.createSpan({ text: label });
      if (!order) return;
      cell.addClass("is-sortable");
      if (this.sortOrder === order) setIcon(cell.createSpan({ cls: "skillmanager-list-icon" }), "arrow-down");
      cell.addEventListener("click", () => {
        this.sortOrder = order;
        this.render();
      });
    };
    column("Name", "col-name", "name-asc");
    column("Tool", "col-tool is-wide");
    column("Type", "col-type is-wide");
    column("Scope", "col-scope is-wide");
    column("Sessions", "col-sessions", "usage-desc");
    column("Last used", "col-last is-wide", "last-used-desc");
    head.createDiv({ cls: "skillmanager-list-cell col-actions is-wide" });

    const maxSessions = Math.max(0, ...rows.map((i) => this.sessionCount(i) ?? 0));
    for (const item of rows) this.renderListRow(container, item, maxSessions);
  }

  private renderListRow(container: HTMLElement, item: ItemMetadata, maxSessions: number) {
    const row = container.createDiv({ cls: "skillmanager-list-row" });
    if (!item.enabled) row.addClass("is-off");
    if (this.selectedItem?.entryId === item.entryId) row.addClass("is-selected");

    const name = row.createDiv({ cls: "skillmanager-list-cell col-name" });
    name.createSpan({ text: item.name, cls: "skillmanager-list-name", attr: { title: item.name } });
    if (item.favorite) setIcon(name.createSpan({ cls: "skillmanager-list-icon skillmanager-list-star" }), "star");

    const toolCell = row.createDiv({ cls: "skillmanager-list-cell col-tool is-wide" });
    const tool = this.toolLabel(item);
    this.renderIcon(toolCell.createSpan({ cls: "skillmanager-list-icon" }), tool.icon, tool.svgIcon);
    toolCell.createSpan({ text: tool.text, cls: "skillmanager-list-ellipsis", attr: { title: tool.text } });

    row.createDiv({ cls: "skillmanager-list-cell col-type is-wide" }).createSpan({
      text: this.itemTypeLabel(item),
      cls: "skillmanager-card-type skillmanager-card-type-sm",
    });

    const scopeCell = row.createDiv({ cls: "skillmanager-list-cell col-scope is-wide" });
    const origin = this.originLabel(item);
    this.renderIcon(scopeCell.createSpan({ cls: "skillmanager-list-icon" }), origin.icon);
    scopeCell.createSpan({ text: origin.text, cls: "skillmanager-list-ellipsis" });
    if (this.isSymlinkedItem(item)) {
      const link = scopeCell.createSpan({ cls: "skillmanager-list-icon", attr: { "aria-label": `Symlinked from ${item.realPath}` } });
      setIcon(link, "link");
    }

    // Sessions: accent shades scaled to the busiest item shown, same as the heatmap.
    const sessions = this.sessionCount(item);
    const sessionsCell = row.createDiv({ cls: "skillmanager-list-cell col-sessions" });
    if (sessions === null) {
      sessionsCell.createSpan({ text: "–", cls: "skillmanager-list-none", attr: { "aria-label": "No usage data for this tool or type" } });
    } else {
      sessionsCell.createSpan({
        text: String(sessions),
        cls: `skillmanager-list-pill is-heat-${heatLevel(sessions, maxSessions)}`,
        attr: { "aria-label": `${sessions} session${sessions === 1 ? "" : "s"} in the last ${HEATMAP_WEEKS} weeks` },
      });
    }

    // Last used: green within a week, yellow within the prune window, orange past it, red if never.
    const lastUsed = this.lastUsedMs(item);
    const lastCell = row.createDiv({ cls: "skillmanager-list-cell col-last is-wide" });
    if (lastUsed === null) {
      lastCell.createSpan({ text: "–", cls: "skillmanager-list-none", attr: { "aria-label": "No usage data for this tool or type" } });
    } else {
      const days = lastUsed === 0 ? Infinity : (Date.now() - lastUsed) / (24 * 60 * 60 * 1000);
      const tone = lastUsed === 0 ? "never" : days <= 7 ? "fresh" : days <= USAGE_STALE_DAYS ? "recent" : "stale";
      lastCell.createSpan({
        text: formatRelativeDay(lastUsed),
        cls: `skillmanager-list-pill is-${tone}`,
        attr: { "aria-label": lastUsed === 0 ? "Never used" : `Last used ${formatDate(lastUsed)}` },
      });
    }

    const actions = row.createDiv({ cls: "skillmanager-list-cell col-actions is-wide" });
    const toggle = actions.createEl("button", {
      cls: `skillmanager-toggle${item.enabled ? " is-on" : ""}`,
      attr: { "aria-label": item.enabled ? "Disable" : "Enable" },
    });
    toggle.addEventListener("click", (evt) => {
      evt.stopPropagation();
      if (item.pluginId !== null) this.explainPluginToggle(item);
      else this.confirmToggle(item, () => this.toggleEnabled(item));
    });
    const menuBtn = actions.createEl("button", { cls: "skillmanager-icon-btn", attr: { "aria-label": "More actions" } });
    setIcon(menuBtn, MORE_HORIZONTAL_ICON_ID);
    menuBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.openCardMenu(evt, item);
    });

    row.addEventListener("click", () => this.selectItem(item));
  }

  private renderCard(container: HTMLElement, item: ItemMetadata) {
    const card = container.createDiv({ cls: "skillmanager-card" });
    if (!item.enabled) card.addClass("is-off");
    if (this.selectedItem?.entryId === item.entryId) card.addClass("is-selected");

    const head = card.createDiv({ cls: "skillmanager-card-head" });
    const syncStatus = this.syncStatusFor(item);
    const dotLabel =
      syncStatus === "current"
        ? `Up to date with ${item.sourceRepo}`
        : syncStatus === "stale"
          ? "Update available: click the sync icon to review"
          : item.sourceRepo
            ? 'Not checked yet this session: click "Check for updates"'
            : "Not tracked from GitHub: install via Discover to enable update checks";
    head.createSpan({
      cls: `skillmanager-card-dot${syncStatus === "current" ? " is-current" : syncStatus === "stale" ? " is-stale" : ""}`,
      attr: { "aria-label": dotLabel },
    });
    head.createSpan({ text: item.name, cls: "skillmanager-card-name" });
    head.createSpan({ text: this.itemTypeLabel(item), cls: "skillmanager-card-type skillmanager-card-type-sm" });

    // Surfaced in the footer-right as the link icon — same slot whether the card is global or a
    // Linked project instance, so both states read from the same place on the card.
    const isBroken = this.isBrokenSymlink(item);
    const isLinked = item.projectId !== null && this.isSymlinkedItem(item);

    if (item.sourceRepo) {
      const syncBtn = head.createEl("button", {
        cls: "skillmanager-icon-btn skillmanager-card-sync-btn",
        attr: { "aria-label": "Check for updates" },
      });
      setIcon(syncBtn, "refresh-cw");
      // Keep the card shortcut completely isolated from the card's selection click. Obsidian
      // can synthesize/retarget clicks around icon buttons, so stopping only the final click is
      // not sufficient in every host version.
      syncBtn.addEventListener("pointerdown", (evt) => evt.stopPropagation());
      syncBtn.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        void this.quickCheckForUpdate(item, syncBtn);
      });
    }

    const toggle = head.createEl("button", {
      cls: `skillmanager-toggle${item.enabled ? " is-on" : ""}`,
      attr: { "aria-label": item.enabled ? "Disable" : "Enable" },
    });
    toggle.addEventListener("click", (evt) => {
      evt.stopPropagation();
      // A plugin-bundled item has no individual on/off — the tool only supports enabling or
      // disabling the whole plugin. Explain that instead of pretending the click did anything.
      if (item.pluginId !== null) {
        this.explainPluginToggle(item);
      } else {
        this.confirmToggle(item, () => this.toggleEnabled(item));
      }
    });

    // What this is for (tool, and the plugin it's bundled with, if any) — lives under the title,
    // small and muted. Type moved up into the head row, next to the name (see above); where it's
    // scoped (Global vs. this one project/vault) lives in the footer instead, next to the link
    // icon that actually answers "where's it linked" on click. See the footer-left block below.
    const toolInfo = this.toolLabel(item);
    const toolCaption = card.createDiv({ cls: "skillmanager-card-tool" });
    const toolIcon = toolCaption.createSpan({ cls: "skillmanager-card-tool-icon" });
    this.renderIcon(toolIcon, toolInfo.icon, toolInfo.svgIcon);
    toolCaption.createSpan({ text: toolInfo.text });

    if (item.description) {
      card.createDiv({ text: item.description, cls: "skillmanager-card-desc" });
    }

    if (item.tags.length > 0) {
      const tags = card.createDiv({ cls: "skillmanager-card-tags" });
      for (const tag of item.tags) {
        tags.createSpan({ text: tag, cls: `skillmanager-chip skillmanager-tag-c${tagColorIndex(tag)}` });
      }
    }

    const footer = card.createDiv({ cls: "skillmanager-card-footer" });
    const originInfo = this.originLabel(item);
    const origin = footer.createDiv({ cls: "skillmanager-card-source" });
    const originIcon = origin.createSpan({ cls: "skillmanager-card-source-icon" });
    this.renderIcon(originIcon, originInfo.icon);
    origin.createSpan({
      text: `${this.isSymlinkedItem(item) ? "Symlink" : "Source"} · ${originInfo.text}`,
      cls: "skillmanager-card-source-text",
      attr: { title: `${this.isSymlinkedItem(item) ? "Symlink" : "Source"} · ${originInfo.text}` },
    });

    const rightGroup = footer.createDiv({ cls: "skillmanager-card-footer-right" });
    if (item.projectId === null) {
      this.renderProjectLinkButton(rightGroup, item);
    } else if (isLinked || isBroken) {
      // Same button as the global card, opening the same picker — clicking a project-scoped
      // card's link icon is no longer a one-click destroy, just the same deliberate "manage
      // links" action, scoped back to the underlying global item so an add here always
      // symlinks from the true source rather than from another project's own symlink.
      const globalItem = this.resolveGlobalItem(item);
      if (globalItem) {
        this.renderProjectLinkButton(rightGroup, globalItem);
      } else {
        // Rare fallback: this instance is a real symlink, but its global source isn't itself
        // being scanned (e.g. sitting outside any configured tool path), so there's nothing to
        // open a picker on. Offer a direct unlink instead, previewed on hover.
        const unlinkBtn = rightGroup.createEl("button", {
          cls: `skillmanager-icon-btn skillmanager-card-link-btn${isBroken ? " is-broken" : ""}`,
          attr: { "aria-label": "Linked, but its library source can't be found. Click to unlink from this project" },
        });
        setIcon(unlinkBtn, isBroken ? "unlink" : "link");
        if (!isBroken) {
          unlinkBtn.addEventListener("mouseenter", () => setIcon(unlinkBtn, "unlink"));
          unlinkBtn.addEventListener("mouseleave", () => setIcon(unlinkBtn, "link"));
        }
        unlinkBtn.addEventListener("click", (evt) => {
          evt.stopPropagation();
        void this.unlinkFromProject(item);
        });
      }
    } else {
      // Project-native items are valid sources too. They can be linked into another project even
      // though they do not themselves point at a shared global source.
      this.renderProjectLinkButton(rightGroup, item);
    }
    if (item.favorite) {
      const star = rightGroup.createSpan({ cls: "skillmanager-card-star" });
      setIcon(star, "star");
    }

    const menuBtn = rightGroup.createEl("button", { cls: "skillmanager-icon-btn", attr: { "aria-label": "More actions" } });
    setIcon(menuBtn, MORE_HORIZONTAL_ICON_ID);
    menuBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.openCardMenu(evt, item);
    });

    card.addEventListener("click", () => this.selectItem(item));
  }

  /** Fast path for a git-tracked card's sync icon: check inline and, if there's something new,
   *  jump straight into the diff instead of the detail rail's staged "badge, then review" flow —
   *  a direct click here already signals "just show me," so there's no reason to interpose an
   *  extra confirmation step. */
  private async quickCheckForUpdate(item: ItemMetadata, btn: HTMLButtonElement) {
    btn.disabled = true;
    btn.addClass("is-syncing");
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    try {
      const latest = remoteHeadCommit(item.sourceRepo as string, item.sourceRef || undefined);
      if (latest === item.sourceCommit) {
        this.syncStatus.set(item.entryId, "current");
        new Notice(`"${item.name}" is up to date.`);
        btn.disabled = false;
        btn.removeClass("is-syncing");
      } else {
        this.syncStatus.set(item.entryId, "stale");
        // startReview re-renders the whole view (including this card), so there's no button left
        // here to reset on the success path.
        await this.startReview(item, "update");
      }
    } catch (e) {
      new Notice(`Couldn't check for updates: ` + errorMessage(e));
      btn.disabled = false;
      btn.removeClass("is-syncing");
    }
  }

  private openCardMenu(evt: MouseEvent, item: ItemMetadata) {
    const isSymlink = this.isSymlinkedItem(item);
    const isProjectLinked = isSymlink && item.projectId !== null;
    const menu = new Menu();
    if (item.pluginId === null) {
      menu.addItem((menuItem) =>
        menuItem
          .setTitle(this.fileManagerLabel())
          .setIcon("folder-open")
          .onClick(() => void this.revealItemLocation(item))
      );
    }
    menu.addItem((menuItem) =>
      menuItem
        .setTitle(item.favorite ? "Remove from favourites" : "Add to favourites")
        .setIcon(item.favorite ? "star-off" : "star")
        .onClick(() => {
          void this.applyItemUpdate(item.entryId, { favorite: !item.favorite });
        })
    );
    menu.addItem((menuItem) =>
      menuItem
        .setTitle("Add to collection")
        .setIcon("bookmark-plus")
        .onClick(() => this.openAddToCollection(item))
    );
    if (item.sourceRepo) {
      menu.addItem((menuItem) =>
        menuItem
          .setTitle("Add to another tool…")
          .setIcon("copy-plus")
          .onClick(() => this.addItemToAnotherTool(item))
      );
    }
    // A plugin-bundled item has no delete/uninstall here — its file lives inside the tool's own
    // plugin manager (for Claude Code, a git-tracked cache directory), which already has its own
    // supported way to remove a plugin. See deleteItem's guard for why this isn't just hidden UI.
    if (item.pluginId === null) {
      menu.addSeparator();
      menu.addItem((menuItem) =>
        menuItem
          .setTitle(isSymlink ? (isProjectLinked ? "Unlink from project" : "Unlink") : "Delete")
          .setIcon(isSymlink ? "unlink" : "trash-2")
          .setWarning(true)
          .onClick(() => this.confirmDelete(item))
      );
    }
    menu.showAtMouseEvent(evt);
  }

  /** Re-runs the same install pipeline InstallFromGitHubModal.install() already owns, prefilled
   *  from this item's own recorded source, and always landing at the new tool's global scope
   *  (lockToGlobal) — never a specific project. Only offered for a sourceRepo item (openCardMenu
   *  already checks): a raw copy of something with no known origin can never be checked for
   *  updates or reconciled with where it came from, so there's no safe fallback for that case —
   *  see the plan notes for the reasoning. Landing at global (not a project) keeps the new copy
   *  linkable afterward through the existing "Manage project links" picker, rather than creating
   *  a project-scoped duplicate that can't later become a link. */
  private addItemToAnotherTool(item: ItemMetadata) {
    if (!item.sourceRepo) return;
    new InstallFromGitHubModal(
      this.app,
      this.getSettings(),
      this.getAllProjects(),
      this.store,
      () => this.rescan(),
      { repoUrl: item.sourceRepo, ref: item.sourceRef ?? "", subpath: item.sourceSubpath ?? "", type: item.type },
      undefined,
      item.tool,
      true
    ).open();
  }

  private openAddToCollection(item: ItemMetadata) {
    new AddToCollectionModal(
      this.app,
      this.getSettings(),
      item,
      async (collection, add) => {
        const updated: Collection = {
          ...collection,
          itemIds: add ? [...collection.itemIds, item.entryId] : collection.itemIds.filter((id) => id !== item.entryId),
        };
        await this.upsertCollection(updated);
      },
      async (name) => {
        await this.upsertCollection({ id: `col-${Date.now()}`, name, itemIds: [item.entryId] });
      }
    ).open();
  }

  /** deleteItem only ever removes what's at sourcePath — for a symlink, that's the link itself,
   *  never the real file it resolves to (see deleteItem's own comment). That's true whether the
   *  symlink is a project's local link into the shared library (isProjectLinked below) or a
   *  tool's own global symlink out to some other store (e.g. a skill kept outside the library and
   *  symlinked into ~/.claude/skills) — so both get the safe "unlink" wording, not the "moved to
   *  the trash" one, which previously only applied to the project case even though the global
   *  case is equally non-destructive.
   *
   *  A real (non-symlink) delete now moves the item to the OS Recycle Bin/Trash via
   *  trashPath (Finder on macOS, so Put Back works) instead of permanently removing it, so the
   *  copy here says so rather than "can't be undone." */
  private confirmDelete(item: ItemMetadata) {
    const unitPath = linkableUnit(item.sourcePath).path;
    const isSymlink = this.isSymlinkedItem(item);
    const isProjectLinked = isSymlink && item.projectId !== null;
    new ConfirmModal(
      this.app,
      isSymlink ? (isProjectLinked ? "Unlink from project?" : "Unlink?") : `Delete "${item.name}"?`,
      isSymlink
        ? isProjectLinked
          ? `This removes the project's symlink to "${item.name}". The skill itself stays in your library.`
          : `This removes the symlink to "${item.name}" at ${unitPath}. The file it points to, at ${item.realPath}, isn't touched.`
        : `This moves "${item.name}" to the Recycle Bin/Trash from ${unitPath}. You can restore it from there if this was a mistake.`,
      isSymlink ? "Unlink" : "Delete",
      async () => {
        try {
          await deleteItem(item, (path) => this.trashPath(path));
          if (this.isMemory(item)) forgetMemoryIndexEntry(item);
          await this.rescan();
        } catch (e) {
          new Notice(`Couldn't delete "${item.name}": ` + errorMessage(e));
        }
      }
    ).open();
  }

  // ---------- Dashboard: source/context estimates, ranked, plus prune/overlap flags ----------

  /** realPath !== sourcePath is exactly what fs.realpathSync resolving through a symlink looks
   *  like (same check the detail pane uses for "→ symlinked from ..."), so it doubles as "is this
   *  actually a symlink" — regardless of scope, unlike the project-card's isLinked which also
   *  requires projectId !== null. A global item can be a symlink too (e.g. a tool's skills folder
   *  symlinked to an external store), and that's exactly the case the dashboard needs to flag. */
  private isSymlinkedItem(item: ItemMetadata): boolean {
    return item.realPath !== item.sourcePath;
  }

  /** A retained project-link card whose target disappeared (usually because its shared source
   *  was disabled). Its unlink control removes the dangling link and the card then disappears on
   *  the next rescan. */
  private isBrokenSymlink(item: ItemMetadata): boolean {
    if (item.projectId === null) return false;
    return this.brokenSymlinks.some((link) => link.path === item.sourcePath || link.path === dirname(item.sourcePath));
  }

  /** A small inline "link" icon for a dashboard row's name, only rendered when the item is a
   *  symlink — lets Prune/Overlap rows (and an overlap's open panel) tell two identically-named
   *  items apart instead of looking like plain duplicates. */
  private renderSymlinkIcon(parent: HTMLElement, item: ItemMetadata) {
    if (!this.isSymlinkedItem(item)) return;
    const icon = parent.createSpan({
      cls: "skillmanager-dash-row-icon",
      attr: { "aria-label": `Symlinked from ${item.realPath}` },
    });
    setIcon(icon, "link");
  }

  /** "A ↔ B" for an overlap row's name, with a link icon in front of either side that's a
   *  symlink — otherwise two rows can read as plain duplicates of each other when they're
   *  actually distinct files (e.g. a plugin's bundled copy vs. the user's own, symlinked one). */
  private renderOverlapPairName(parent: HTMLElement, a: ItemMetadata, b: ItemMetadata) {
    this.renderSymlinkIcon(parent, a);
    parent.createSpan({ text: a.name });
    parent.createSpan({ text: " ↔ " });
    this.renderSymlinkIcon(parent, b);
    parent.createSpan({ text: b.name });
  }

  private getDashboardMetrics(): DashboardMetric[] {
    if (!this.dashboardMetrics) {
      this.dashboardMetrics = computeDashboardMetrics(this.items.filter((i) => i.enabled));
    }
    return this.dashboardMetrics;
  }

  /** Cached counts behind the sidebar's Health and Cleanup badges — see insightsCounts. Excludes
   *  anything the user has already disregarded, same as the pages' own lists. Reads whatever
   *  Claude Code usage happens to already be cached but never triggers a load itself
   *  (`triggerUsageLoad: false`) — renderSidebar calls this on every render, so it must not be
   *  what kicks off the transcript-directory scan. */
  private getInsightsCounts(): { health: number; cleanup: number } {
    if (this.insightsCounts === null) {
      const metrics = this.getDashboardMetrics();
      const { usagePrune, mtimePrune } = this.getDashboardPruneSplit(metrics, false);
      const overlapPairs = this.overlapPairsFor(metrics.map((m) => m.item));
      this.insightsCounts = {
        health: this.getBrokenSymlinkRows().length + this.getIntegrityRows().length,
        cleanup: usagePrune.length + mtimePrune.length + overlapPairs.length,
      };
    }
    return this.insightsCounts;
  }

  private getIntegrityIssues(): Map<string, string[]> {
    if (!this.integrityIssues) {
      const issuesById = new Map<string, string[]>();
      for (const item of this.items) {
        if (!item.enabled) continue;
        let raw: string;
        try {
          raw = readFileSync(item.sourcePath, "utf-8");
        } catch {
          continue;
        }
        const issues = checkIntegrity(item, raw, parseYaml);
        if (this.isMemory(item)) issues.push(...checkMemoryIndexed(item));
        if (issues.length > 0) issuesById.set(item.entryId, issues);
      }
      this.integrityIssues = issuesById;
    }
    return this.integrityIssues;
  }

  /** Includes the issue text, so disregarding an item's current problems doesn't also hide a
   *  different problem that shows up in it later. */
  /** Keyed on the target too, so re-pointing a disregarded link at a new missing path flags it again. */
  private brokenSymlinkDisregardKey(link: BrokenSymlink): string {
    return `broken:${link.path}->${link.targetPath}`;
  }

  private getBrokenSymlinkRows(wantDisregarded = false): BrokenSymlink[] {
    const disregarded = this.getSettings().dashboardDisregarded;
    return this.brokenSymlinks.filter((link) => !!disregarded[this.brokenSymlinkDisregardKey(link)] === wantDisregarded);
  }

  /** The library item a broken link row opens: the disabled source it points at, else the
   *  project card retained for the dangling link itself (see rescan's retainedBrokenIds). */
  private itemForBrokenLink(link: BrokenSymlink, disabledSource: ItemMetadata | null): ItemMetadata | null {
    return disabledSource
      ?? this.items.find((item) => item.sourcePath === link.path || dirname(item.sourcePath) === link.path)
      ?? null;
  }

  private integrityDisregardKey(item: ItemMetadata, issues: string[]): string {
    return `integrity:${item.entryId}:${issues.join("|")}`;
  }

  /** `wantDisregarded` flips the filter to return only the rows the user has disregarded. */
  private getIntegrityRows(wantDisregarded = false): { item: ItemMetadata; issues: string[] }[] {
    const issuesById = this.getIntegrityIssues();
    const disregarded = this.getSettings().dashboardDisregarded;
    return this.items
      .filter((item) => issuesById.has(item.entryId))
      .map((item) => ({ item, issues: issuesById.get(item.entryId) as string[] }))
      .filter(({ item, issues }) => !!disregarded[this.integrityDisregardKey(item, issues)] === wantDisregarded)
      .sort((a, b) => a.item.name.localeCompare(b.item.name));
  }

  /** The Prune candidates section's actual split — Claude Code skills/agents by real invocation
   *  history once it's loaded (falling back to mtime while still loading), everything else by
   *  mtime. Single source of truth for the header "Prune" stat, the sidebar attention badge, and
   *  the section itself, so all three always agree (findPruneCandidates alone undercounts, since
   *  it knows nothing about the usage-based candidates that replace part of its own output).
   *  `triggerUsageLoad` defaults to true (the Dashboard section itself, where selecting the
   *  Claude Code tile is exactly what should start the scan); the sidebar badge passes false so
   *  it only ever reflects usage that's already loaded, never starts loading it. */
  private getDashboardPruneSplit(
    metrics: DashboardMetric[],
    triggerUsageLoad = true
  ): {
    usagePrune: { item: ItemMetadata; stats: ClaudeUsageStats }[];
    mtimePrune: DashboardMetric[];
    /** Items that would be flagged by either method but the user disregarded. */
    disregardedPrune: ItemMetadata[];
  } {
    const disregarded = this.getSettings().dashboardDisregarded;
    // A plugin-bundled item can't be disabled individually from here any more than from its own
    // card (see renderCard) — Prune candidates only lists things its own "Disable" button can
    // actually act on.
    const allCandidates = findPruneCandidates(metrics).filter((m) => m.item.pluginId === null);
    const pruneCandidates = allCandidates.filter((m) => !disregarded[m.item.entryId]);
    const usage = triggerUsageLoad ? this.getClaudeUsage() : this.claudeUsage;
    const isClaudeSkillOrAgent = (m: DashboardMetric) =>
      m.item.tool === "claude-code" && (m.item.type === "skill" || m.item.type === "agent");
    const claudeSkillAgentItems = metrics.filter(isClaudeSkillOrAgent).filter((m) => m.item.pluginId === null).map((m) => m.item);
    const allUsagePrune = usage ? findUsagePruneCandidates(claudeSkillAgentItems, usage) : [];
    const usagePrune = allUsagePrune.filter((u) => !disregarded[u.item.entryId]);
    const mtimePrune = pruneCandidates.filter((m) => !usage || !isClaudeSkillOrAgent(m));
    const disregardedPrune = [
      ...allUsagePrune.map((u) => u.item),
      ...allCandidates.filter((m) => !usage || !isClaudeSkillOrAgent(m)).map((m) => m.item),
    ].filter((item) => disregarded[item.entryId]);
    return { usagePrune, mtimePrune, disregardedPrune };
  }

  /** Stable, order-independent key for an overlap pair, used as its dashboardDisregarded entry —
   *  entryId order out of findOverlapPairs isn't guaranteed to stay a/b vs b/a across rescans. */
  private overlapPairKey(a: ItemMetadata, b: ItemMetadata): string {
    return [a.entryId, b.entryId].sort().join("::");
  }

  /** findOverlapPairs, with instructions files (ToolConfig.singleFileRule) excluded first. A
   *  CLAUDE.md-style file has no frontmatter name/description of its own (see scanSingleFile),
   *  so every scope of it falls back to the same filename and would otherwise score 100%
   *  "overlap" against its own project-scoped copies — but a global instructions file and a
   *  project one are meant to coexist, not compete, so instructions files never enter this
   *  comparison at all. */
  private overlapPairsFor(items: ItemMetadata[], wantDisregarded = false): OverlapPair[] {
    // Memory index files are excluded for the same reason: every project's MEMORY.md shares a name.
    const eligible = items.filter(
      (item) => !(item.type === "rule" && (this.isSingleFileRuleTool(item.tool) || (this.isMemory(item) && isMemoryIndex(item))))
    );
    const disregarded = this.getSettings().dashboardDisregarded;
    return findOverlapPairs(eligible).filter((p) => !!disregarded[this.overlapPairKey(p.a, p.b)] === wantDisregarded);
  }

  /** Marks a specific Prune candidate (entryId) or Possible overlap (overlapPairKey) as "not
   *  relevant" — unlike disableFromDashboard this never touches the item itself and never
   *  expires, since disregarding is a deliberate call, not something to auto-undo. */
  private async disregardDashboardRecommendation(key: string) {
    const settings = this.getSettings();
    settings.dashboardDisregarded = { ...settings.dashboardDisregarded, [key]: Date.now() };
    await this.saveSettings();
    this.insightsCounts = null;
    this.render();
  }

  private async undisregardDashboardRecommendation(key: string) {
    const settings = this.getSettings();
    const { [key]: _removed, ...rest } = settings.dashboardDisregarded;
    settings.dashboardDisregarded = rest;
    await this.saveSettings();
    this.insightsCounts = null;
    this.render();
  }

  /** Adds a "Show disregarded (N)" toggle to a section's head and, while it's on, lists those
   *  rows dimmed at the bottom of the section, each with a "Show again" button that undoes the
   *  disregard. Nothing renders when the section has none. */
  private renderDashboardDisregarded(
    section: HTMLElement,
    sectionId: string,
    entries: { key: string; renderName: (nameRow: HTMLElement) => void; meta: string }[]
  ) {
    if (entries.length === 0) return;
    const head = section.querySelector<HTMLElement>(".skillmanager-dash-section-head");
    if (!head) return;
    const right = head.querySelector<HTMLElement>(".skillmanager-dash-section-right") ?? head.createDiv({ cls: "skillmanager-dash-section-right" });
    const shown = this.dashboardShowDisregarded.has(sectionId);
    const toggle = right.createEl("button", {
      text: shown ? "Hide disregarded" : `Show disregarded (${entries.length})`,
      cls: "skillmanager-dash-disregarded-toggle",
    });
    toggle.addEventListener("click", () => {
      if (shown) this.dashboardShowDisregarded.delete(sectionId);
      else this.dashboardShowDisregarded.add(sectionId);
      this.render();
    });
    if (!shown) return;

    const disregarded = this.getSettings().dashboardDisregarded;
    const now = Date.now();
    const block = section.createDiv({ cls: "skillmanager-dash-disregarded" });
    block.createDiv({ text: "Disregarded", cls: "skillmanager-dash-disregarded-label" });
    const box = block.createDiv({ cls: "skillmanager-insight-box" });
    for (const entry of entries) {
      const at = disregarded[entry.key];
      this.renderInsightStaticRow(box, {
        renderName: entry.renderName,
        problem: at ? `${entry.meta} · disregarded ${dashboardRelativeAge(now - at)} ago` : entry.meta,
        action: { label: "Show again", run: () => void this.undisregardDashboardRecommendation(entry.key) },
        dimmed: true,
      });
    }
  }

  private renderInsightsContent(content: HTMLElement) {
    const body = (() => {
      switch (this.insightsPage) {
        case "usage":
          return this.renderInsightsUsage(content);
        case "health":
          return this.renderInsightsHealth(content);
        case "cleanup":
          return this.renderInsightsCleanup(content);
        default:
          return this.renderInsightsContext(content);
      }
    })();
    // Restores wherever the user was (e.g. returning here via a row's "Back") and keeps tracking
    // live, same pattern as libraryScrollTop for the main grid. Reset on every page switch.
    body.scrollTop = this.dashboardScrollTop;
    body.addEventListener("scroll", () => {
      this.dashboardScrollTop = body.scrollTop;
    });
  }

  /** Title, subtitle and an optional stat cluster, then the page's scrollable body. */
  private renderInsightsShell(
    content: HTMLElement,
    title: string,
    subtitle: string,
    buildStats?: (stats: HTMLElement) => void
  ): HTMLElement {
    const header = content.createDiv({ cls: "skillmanager-content-header" });
    const headerTop = header.createDiv({ cls: "skillmanager-dash-header-top" });
    const headerLeft = headerTop.createDiv({ cls: "skillmanager-dash-header-left" });
    const titleRow = headerLeft.createDiv({ cls: "skillmanager-title-row" });
    titleRow.createEl("h2", { text: title, cls: "skillmanager-title" });
    headerLeft.createDiv({ text: subtitle, cls: "skillmanager-subtitle" });
    if (buildStats) buildStats(headerTop.createDiv({ cls: "skillmanager-dash-header-stats" }));
    header.createDiv({ cls: "skillmanager-dash-divider" });
    return content.createDiv({ cls: "skillmanager-body skillmanager-dash-body" });
  }

  /** Recently disabled-from-Insights items, still disabled, inside the restore window. */
  private getDashboardRestoreRows(): { item: ItemMetadata; disabledAt: number }[] {
    return Object.entries(this.pruneExpiredDashboardRestores())
      .map(([entryId, disabledAt]) => ({ item: this.items.find((i) => i.entryId === entryId), disabledAt }))
      .filter((r): r is { item: ItemMetadata; disabledAt: number } => !!r.item && !r.item.enabled);
  }

  /** Tools on the Usage page's switcher: only those with at least one skill or agent. */
  private usageToolsPresent() {
    return USAGE_TOOLS.filter((t) => this.items.some((i) => i.tool === t.id && (i.type === "skill" || i.type === "agent")));
  }

  private renderInsightsContext(content: HTMLElement): HTMLElement {
    const metrics = this.getDashboardMetrics();
    const body = this.renderInsightsShell(
      content,
      "Context",
      "Source size and estimated context usage across enabled items. Commands and rules are tool-dependent for now.",
      (stats) => {
        const totalChars = metrics.reduce((sum, m) => sum + m.charCount, 0);
        const availableChars = metrics.reduce((sum, m) => sum + (m.alwaysAvailableCharCount ?? 0), 0);
        const invocationChars = metrics.reduce((sum, m) => sum + (m.invocationCharCount ?? 0), 0);
        this.renderDashboardStat(stats, "Enabled", String(metrics.length));
        this.renderDashboardStat(
          stats,
          "Source tokens",
          formatTokens(totalChars).replace("~", ""),
          "",
          "Estimated tokens in each representative source file. This is a file-size estimate, not necessarily per-turn context."
        );
        this.renderDashboardStat(
          stats,
          "Available",
          formatTokens(availableChars).replace("~", ""),
          "skillmanager-dash-stat-accent",
          "Estimated name-and-description metadata exposed while a skill or agent is available. For tools that preload this metadata, it can add to the model's context on every turn even when never invoked. Actual behavior varies by tool; commands and rules are not included until their loading policies are modeled."
        );
        this.renderDashboardStat(
          stats,
          "On invoke",
          formatTokens(invocationChars).replace("~", ""),
          "",
          "Estimated instruction-body tokens loaded when a skill or agent is invoked. Companion files are loaded on demand and are not included here."
        );
      }
    );
    if (metrics.length === 0) {
      body.createDiv({ text: "No enabled items yet.", cls: "skillmanager-empty" });
      return body;
    }
    this.renderDashboardToolCards(body, metrics);
    this.renderDashboardRanked(body, metrics);
    return body;
  }

  /** Per-tool, since each tool's history comes from its own transcripts: a switcher up top
   *  instead of the old Dashboard's "click the tool card first" gate. */
  private renderInsightsUsage(content: HTMLElement): HTMLElement {
    const tools = this.usageToolsPresent();
    if (tools.length > 0 && !tools.some((t) => t.id === this.insightsUsageTool)) this.insightsUsageTool = tools[0].id;
    const tool = USAGE_TOOLS.find((t) => t.id === this.insightsUsageTool)!;
    const usage = tools.length > 0 ? (tool.id === "claude-code" ? this.getClaudeUsage() : this.getCodexUsage()) : null;
    const items = this.items.filter((i) => i.tool === tool.id && (i.type === "skill" || i.type === "agent"));
    const ranked = usage ? rankTopUsedItems(items, usage) : [];
    const enabledItems = items.filter((i) => i.enabled);
    const neverUsed = usage ? enabledItems.filter((i) => (usage.get(i.entryId)?.lastUsedMs ?? 0) === 0 && this.lastHistoryDayMs(i) === 0).length : 0;

    const body = this.renderInsightsShell(
      content,
      "Usage",
      "Which skills and agents you actually use, from each tool's own session history.",
      tools.length === 0
        ? undefined
        : (stats) => {
            const dash = (n: number) => (usage ? String(n) : "…");
            this.renderDashboardStat(stats, `Runs (${TOP_USED_WINDOW_DAYS}d)`, dash(ranked.reduce((sum, r) => sum + r.stats.count, 0)));
            this.renderDashboardStat(stats, "Items used", dash(ranked.length));
            this.renderDashboardStat(
              stats,
              "Never used",
              dash(neverUsed),
              neverUsed ? "skillmanager-dash-stat-accent" : "",
              "Enabled skills and agents with no recorded invocation. See Cleanup to review them."
            );
          }
    );
    if (tools.length === 0) {
      body.createDiv({
        text: "Usage history is available for Claude Code and Codex skills and agents. None are installed yet.",
        cls: "skillmanager-empty",
      });
      return body;
    }

    if (tools.length > 1) {
      const segmented = body.createDiv({ cls: "skillmanager-segmented skillmanager-insights-switcher" });
      for (const t of tools) {
        this.renderSegment(segmented, t.name, t.id === tool.id, () => {
          this.insightsUsageTool = t.id;
          this.render();
        });
      }
    }

    this.renderInsightsActivity(body, tool.id, tool.name, !usage);
    this.renderDashboardTopUsed(body, ranked, !usage, tool.name);
    return body;
  }

  /** Weekly sessions across every skill and agent of one tool, from the saved history — same
   *  source and window as an item's own Activity bars in the detail rail, just summed. */
  private renderInsightsActivity(body: HTMLElement, toolId: string, toolName: string, loading: boolean) {
    const section = body.createDiv({ cls: "skillmanager-insights-block" });
    this.renderDashboardSectionHead(section, "Activity");
    const history = this.getSettings().usageHistory ?? {};
    const merged: DayCounts = {};
    for (const [key, days] of Object.entries(history)) {
      if (!key.startsWith(`${toolId}|`)) continue;
      for (const [day, count] of Object.entries(days)) merged[day] = (merged[day] ?? 0) + count;
    }
    const { columns, total } = buildHeatmap(merged);
    section.createDiv({
      text: `Skill and agent sessions per week in ${toolName}, last ${HEATMAP_WEEKS} weeks.`,
      cls: "skillmanager-subtitle",
    });
    if (total === 0) {
      section.createDiv({
        text: loading ? `Scanning ${toolName} history…` : "No activity recorded yet.",
        cls: "skillmanager-empty",
      });
      return;
    }
    const weeks = columns.map((column) => column.reduce((sum, cell) => sum + cell.count, 0));
    const max = Math.max(...weeks);
    const bars = section.createDiv({ cls: "skillmanager-detail-usage-bars skillmanager-insights-activity" });
    columns.forEach((column, i) => {
      const bar = bars.createDiv({ cls: `skillmanager-detail-usage-bar${weeks[i] > 0 ? " is-used" : ""}` });
      bar.style.height = `${Math.max(4, (weeks[i] / max) * 100)}%`;
      const week = new Date(column[0].ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      setTooltip(bar, `Week of ${week}: ${weeks[i]} session${weeks[i] === 1 ? "" : "s"}`, { placement: "top" });
    });
  }

  private renderInsightsHealth(content: HTMLElement): HTMLElement {
    const integrityRows = this.getIntegrityRows();
    const brokenRows = this.getBrokenSymlinkRows();
    const body = this.renderInsightsShell(
      content,
      "Health",
      "Problems that stop a tool from seeing or loading an item. These are worth fixing.",
      (stats) => {
        this.renderDashboardStat(stats, "Broken links", String(brokenRows.length), brokenRows.length ? "skillmanager-dash-stat-danger" : "");
        this.renderDashboardStat(stats, "Issues", String(integrityRows.length), integrityRows.length ? "skillmanager-dash-stat-danger" : "");
      }
    );
    const brokenSection = this.renderDashboardBrokenSymlinks(body, brokenRows);
    this.renderDashboardDisregarded(
      brokenSection,
      "broken",
      this.getBrokenSymlinkRows(true).map((link) => ({
        key: this.brokenSymlinkDisregardKey(link),
        renderName: (nameRow) => {
          setIcon(nameRow.createSpan({ cls: "skillmanager-dash-row-icon" }), TYPE_ICONS[link.type]);
          nameRow.createSpan({ text: basename(link.path).replace(/\.md$/i, "") });
        },
        meta: `→ ${tildePath(link.targetPath)}`,
      }))
    );
    const integritySection = this.renderDashboardIntegrity(body, integrityRows);
    this.renderDashboardDisregarded(
      integritySection,
      "integrity",
      this.getIntegrityRows(true).map(({ item, issues }) => ({
        key: this.integrityDisregardKey(item, issues),
        renderName: (nameRow) => {
          setIcon(nameRow.createSpan({ cls: "skillmanager-dash-row-icon" }), TYPE_ICONS[item.type]);
          nameRow.createSpan({ text: item.name });
        },
        meta: issues.length === 1 ? issues[0] : `${issues.length} issues`,
      }))
    );
    return body;
  }

  private renderInsightsCleanup(content: HTMLElement): HTMLElement {
    const metrics = this.getDashboardMetrics();
    // Claude Code's skills and agents get judged by real invocation history (the only tool this
    // plugin can read one for, see claude-usage.ts) instead of the mtime heuristic everything
    // else uses, with each row tagged "Usage" or "File age" so the mixed methodology is never
    // ambiguous (see renderDashboardPruneCandidates). getDashboardPruneSplit is the single source of
    // truth for this count so the header stat can't drift from what the section renders.
    const { usagePrune, mtimePrune, disregardedPrune } = this.getDashboardPruneSplit(metrics);
    const overlapPairs = this.overlapPairsFor(metrics.map((m) => m.item));
    const pruneCount = usagePrune.length + mtimePrune.length;
    const restoreCount = this.getDashboardRestoreRows().length;
    const body = this.renderInsightsShell(
      content,
      "Cleanup",
      "Suggestions, not problems: items that may not be earning their keep, and items that may be doing the same job.",
      (stats) => {
        this.renderDashboardStat(stats, "Prune", String(pruneCount), pruneCount ? "skillmanager-dash-stat-accent" : "");
        this.renderDashboardStat(stats, "Overlaps", String(overlapPairs.length), overlapPairs.length ? "skillmanager-dash-stat-accent" : "");
        if (restoreCount) this.renderDashboardStat(stats, "Recently disabled", String(restoreCount));
      }
    );
    if (metrics.length === 0 && restoreCount === 0) {
      body.createDiv({ text: "No enabled items yet.", cls: "skillmanager-empty" });
      return body;
    }
    const pruneSection = this.renderDashboardPruneCandidates(body, usagePrune, mtimePrune, metrics);
    this.renderDashboardDisregarded(
      pruneSection,
      "prune",
      disregardedPrune.map((item) => ({
        key: item.entryId,
        renderName: (nameRow) => {
          this.renderSymlinkIcon(nameRow, item);
          nameRow.createSpan({ text: item.name });
        },
        meta: `${this.toolLabel(item).text} · ${TYPE_LABELS[item.type]}`,
      }))
    );
    const overlapSection = this.renderDashboardOverlaps(body, overlapPairs, metrics.map((m) => m.item));
    this.renderDashboardDisregarded(
      overlapSection,
      "overlaps",
      this.overlapPairsFor(metrics.map((m) => m.item), true).map((pair) => ({
        key: this.overlapPairKey(pair.a, pair.b),
        renderName: (nameRow) => this.renderOverlapPairName(nameRow, pair.a, pair.b),
        meta: pair.sameName ? "Same name" : `${Math.round(pair.score * 100)}% description overlap`,
      }))
    );
    return body;
  }

  /** Hover tooltip plus the same text on click, so an info icon always answers when poked. */
  private attachInfoTooltip(el: HTMLElement, tooltip: string) {
    setTooltip(el, tooltip, { placement: "top" });
    el.addEventListener("click", (evt) => {
      evt.stopPropagation();
      displayTooltip(el, tooltip, { placement: "top" });
    });
  }

  private renderDashboardStat(parent: HTMLElement, label: string, value: string, accentCls = "", tooltip?: string) {
    const stat = parent.createDiv({ cls: "skillmanager-dash-stat" });
    const labelEl = stat.createDiv({ cls: "skillmanager-dash-stat-label" });
    labelEl.createSpan({ text: label });
    if (tooltip) {
      const infoIcon = labelEl.createSpan({ cls: "skillmanager-dash-stat-info" });
      setIcon(infoIcon, "info");
      this.attachInfoTooltip(labelEl, tooltip);
    }
    stat.createDiv({ text: value, cls: `skillmanager-dash-stat-value ${accentCls}`.trim() });
  }

  private renderDashboardSectionHead(parent: HTMLElement, title: string, buildRight?: (right: HTMLElement) => void) {
    const head = parent.createDiv({ cls: "skillmanager-dash-section-head" });
    head.createDiv({ text: title, cls: "skillmanager-dash-section-title" });
    if (buildRight) buildRight(head.createDiv({ cls: "skillmanager-dash-section-right" }));
  }

  private renderDashboardTypeLegend(parent: HTMLElement) {
    const legend = parent.createDiv({ cls: "skillmanager-dash-legend" });
    for (const type of Object.keys(DASHBOARD_TYPE_COLORS) as ItemType[]) {
      const entry = legend.createDiv({ cls: "skillmanager-dash-legend-entry" });
      const swatch = entry.createSpan({ cls: "skillmanager-dash-legend-swatch" });
      swatch.style.background = DASHBOARD_TYPE_COLORS[type];
      entry.createSpan({ text: TYPE_LABEL_SINGULAR[type] });
    }
  }

  /** Clickable "All / Skill / Agent / Command / Rule" pills above Ranked by cost — same type
   *  vocabulary as renderDashboardTypeLegend, but selectable rather than just a color key. */
  private renderDashboardTypeFilter(parent: HTMLElement) {
    const setType = (type: ItemType | null) => {
      this.dashboardTypeFilter = type;
        this.render();
    };

    const filter = parent.createDiv({ cls: "skillmanager-dash-type-filter" });
    const allPill = filter.createSpan({ text: "All", cls: "skillmanager-dash-type-pill" });
    if (!this.dashboardTypeFilter) allPill.addClass("is-active");
    allPill.addEventListener("click", () => setType(null));

    for (const type of Object.keys(DASHBOARD_TYPE_COLORS) as ItemType[]) {
      const pill = filter.createSpan({ text: TYPE_CATEGORY_LABELS[type], cls: "skillmanager-dash-type-pill" });
      if (this.dashboardTypeFilter === type) pill.addClass("is-active");
      pill.addEventListener("click", () => setType(type));
    }
  }

  /** A stacked bar of colored segments, one per type (skill/agent/command/rule) rather than one
   *  per item — a tool with dozens of items would otherwise render an unreadable sliver per item.
   *  Each segment carries a native title tooltip with its type's item count and combined cost. */
  private renderDashboardStackedBar(track: HTMLElement, list: DashboardMetric[], maxTotal: number) {
    const totals = new Map<ItemType, { charCount: number; count: number }>();
    for (const m of list) {
      const entry = totals.get(m.item.type) ?? { charCount: 0, count: 0 };
      entry.charCount += m.charCount;
      entry.count += 1;
      totals.set(m.item.type, entry);
    }
    let offset = 0;
    for (const type of Object.keys(DASHBOARD_TYPE_COLORS) as ItemType[]) {
      const entry = totals.get(type);
      if (!entry) continue;
      const seg = track.createDiv({ cls: "skillmanager-dash-stack-seg" });
      seg.style.width = `${(entry.charCount / maxTotal) * 100}%`;
      seg.style.left = `${(offset / maxTotal) * 100}%`;
      seg.style.background = DASHBOARD_TYPE_COLORS[type];
      const countLabel = entry.count === 1 ? "1 item" : `${entry.count} items`;
      setTooltip(seg, `${TYPE_LABEL_SINGULAR[type]} · ${countLabel} · ${formatTokens(entry.charCount)}`, { placement: "top" });
      offset += entry.charCount;
    }
  }

  private dashboardDominantType(list: DashboardMetric[]): ItemType {
    const totals = new Map<ItemType, number>();
    for (const m of list) totals.set(m.item.type, (totals.get(m.item.type) ?? 0) + m.charCount);
    return [...totals.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  /** Clickable, one per tool, scaled against the grand total (not the biggest single tool) so
   *  each card's bar reads as "this much of the whole pie" — clicking one filters Ranked below,
   *  since the ranking alone doesn't make each item's tool obvious. Grows to fill the row when
   *  there's room; falls back to horizontal scroll once there are too many tools to fit. */
  private renderDashboardToolCards(body: HTMLElement, metrics: DashboardMetric[]) {
    const section = body.createDiv({ cls: "skillmanager-insights-block" });
    this.renderDashboardSectionHead(section, "Source size by tool", (right) => this.renderDashboardTypeLegend(right));
    const tileGrid = section.createDiv({ cls: "skillmanager-dash-tiles" });

    const byType = (list: DashboardMetric[]) => [...list].sort((a, b) => a.item.type.localeCompare(b.item.type));
    const groups = new Map<string, DashboardMetric[]>();
    for (const m of metrics) {
      const list = groups.get(m.item.tool) ?? [];
      list.push(m);
      groups.set(m.item.tool, list);
    }
    const grandTotal = metrics.reduce((s, m) => s + m.charCount, 0);

    const selectTool = (tool: string | null) => {
      this.dashboardActiveTool = tool;
      this.render();
    };

    const allTile = tileGrid.createDiv({ cls: "skillmanager-dash-tile" });
    if (!this.dashboardActiveTool) allTile.addClass("is-active");
    allTile.createDiv({ text: "All tools", cls: "skillmanager-dash-tile-name" });
    allTile.createDiv({ text: formatTokens(grandTotal), cls: "skillmanager-dash-tile-value" });
    this.renderDashboardTileContext(allTile, metrics);
    this.renderDashboardStackedBar(allTile.createDiv({ cls: "skillmanager-dash-tile-bar" }), byType(metrics), grandTotal);
    allTile.addEventListener("click", () => selectTool(null));

    const toolName = (toolId: string) => this.getSettings().tools.find((t) => t.id === toolId)?.name ?? toolId;
    for (const [tool, list] of groups) {
      const total = list.reduce((s, m) => s + m.charCount, 0);
      const tile = tileGrid.createDiv({ cls: "skillmanager-dash-tile" });
      if (this.dashboardActiveTool === tool) tile.addClass("is-active");
      const tileHead = tile.createDiv({ cls: "skillmanager-dash-tile-head" });
      tileHead.createDiv({ text: toolName(tool), cls: "skillmanager-dash-tile-name" });
      tileHead.createSpan({ cls: "skillmanager-dash-tile-dot" }).style.background = DASHBOARD_TYPE_COLORS[this.dashboardDominantType(list)];
      tile.createDiv({ text: formatTokens(total), cls: "skillmanager-dash-tile-value" });
      this.renderDashboardTileContext(tile, list);
      this.renderDashboardStackedBar(tile.createDiv({ cls: "skillmanager-dash-tile-bar" }), byType(list), grandTotal);
      tile.addEventListener("click", () => selectTool(tool));
    }
  }

  /** Adds the context split to each source-size card. Null metrics are deliberately ignored in
   *  the totals: commands and rules remain tool-dependent until their loading policies are known. */
  private renderDashboardTileContext(tile: HTMLElement, list: DashboardMetric[]) {
    const known = list.some((m) => m.alwaysAvailableCharCount !== null || m.invocationCharCount !== null);
    const context = tile.createDiv({ cls: "skillmanager-dash-tile-context" });
    if (!known) {
      context.createSpan({ text: "Context: tool-dependent" });
      return;
    }
    const available = list.reduce((sum, m) => sum + (m.alwaysAvailableCharCount ?? 0), 0);
    const invocation = list.reduce((sum, m) => sum + (m.invocationCharCount ?? 0), 0);
    context.createSpan({ text: `Available ${formatTokens(available)}` });
    context.createSpan({ text: `On invoke ${formatTokens(invocation)}` });
  }

  /** Every item, filtered by whichever tool card is active and/or type pill is selected (the two
   *  AND together — e.g. "Claude Code" + "Command"). Last thing on the Context page, so there's
   *  nothing below it worth collapsing for. */
  private renderDashboardRanked(body: HTMLElement, metrics: DashboardMetric[]) {
    const section = body.createDiv({ cls: "skillmanager-insights-block" });
    this.renderDashboardSectionHead(section, "Ranked by cost", (right) => this.renderDashboardTypeFilter(right));

    const filtered = metrics.filter(
      (m) =>
        (!this.dashboardActiveTool || m.item.tool === this.dashboardActiveTool) &&
        (!this.dashboardTypeFilter || m.item.type === this.dashboardTypeFilter)
    );
    const sorted = [...filtered].sort((a, b) => b.charCount - a.charCount);
    // Scaled to the filtered set, so filtering to e.g. Rules doesn't leave every bar a sliver.
    const maxCharCount = Math.max(...sorted.map((m) => m.charCount), 1);
    const total = sorted.reduce((sum, m) => sum + m.charCount, 0);

    if (sorted.length > DASHBOARD_COST_SUMMARY_COUNT && total > 0) {
      const topSum = sorted.slice(0, DASHBOARD_COST_SUMMARY_COUNT).reduce((sum, m) => sum + m.charCount, 0);
      section.createDiv({
        text: `Top ${DASHBOARD_COST_SUMMARY_COUNT} account for ${Math.round((topSum / total) * 100)}% of ${formatTokens(total)} across ${sorted.length} items.`,
        cls: "skillmanager-subtitle",
      });
    }

    const list = section.createDiv({ cls: "skillmanager-dash-ranked-list skillmanager-dash-bar-list" });
    if (sorted.length === 0) {
      list.createDiv({ text: "Nothing matches this filter.", cls: "skillmanager-empty" });
    }
    const shown = this.dashboardRankedExpanded ? sorted : sorted.slice(0, DASHBOARD_COST_COLLAPSED_COUNT);
    for (const metric of shown) this.renderDashboardRow(list, metric, maxCharCount, total);
    if (sorted.length > DASHBOARD_COST_COLLAPSED_COUNT) {
      const toggleBtn = section.createEl("button", {
        text: this.dashboardRankedExpanded ? "Show fewer" : `Show all (${sorted.length})`,
        cls: "skillmanager-dash-toggle",
      });
      toggleBtn.addEventListener("click", () => {
        this.dashboardRankedExpanded = !this.dashboardRankedExpanded;
        this.render();
      });
    }
  }

  private renderDashboardRow(container: HTMLElement, metric: DashboardMetric, maxCharCount: number, total: number) {
    const { item, charCount } = metric;
    const row = container.createDiv({ cls: "skillmanager-dash-row" });
    row.addEventListener("click", () => this.openItemFromDashboard(item));

    const info = row.createDiv({ cls: "skillmanager-dash-row-info" });
    const nameRow = info.createDiv({ cls: "skillmanager-dash-row-name" });
    const iconEl = nameRow.createSpan({ cls: "skillmanager-dash-row-icon" });
    setIcon(iconEl, TYPE_ICONS[item.type]);
    nameRow.createSpan({ text: item.name });
    info.createDiv({ text: `${this.toolLabel(item).text} · ${TYPE_LABELS[item.type]}`, cls: "skillmanager-dash-row-meta" });

    const barTrack = row.createDiv({ cls: "skillmanager-dash-bar-track" });
    const barFill = barTrack.createDiv({ cls: "skillmanager-dash-bar-fill" });
    barFill.style.width = `${Math.max(2, (charCount / maxCharCount) * 100)}%`;
    barFill.style.background = DASHBOARD_TYPE_COLORS[item.type];

    const cost = row.createDiv({ cls: "skillmanager-dash-row-cost" });
    cost.createSpan({ text: formatTokens(charCount) });
    const pct = total > 0 ? (charCount / total) * 100 : 0;
    cost.createSpan({ text: pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`, cls: "skillmanager-dash-row-pct" });
  }

  private renderDashboardBrokenSymlinks(body: HTMLElement, links: BrokenSymlink[]): HTMLElement {
    const section = body.createDiv({ cls: "skillmanager-insights-block skillmanager-insight-section" });
    const rows: InsightRow[] = links.map((link) => {
      const disabledSource = this.disabledSourceForBrokenLink(link);
      const linkedItem = this.itemForBrokenLink(link, disabledSource);
      const reveal: InsightAction = { label: this.fileManagerLabel(), run: () => void this.openContainingFolder(link.path) };
      return {
        key: `broken:${this.brokenSymlinkDisregardKey(link)}`,
        renderName: (el) => {
          setIcon(el.createSpan({ cls: "skillmanager-dash-row-icon" }), TYPE_ICONS[link.type]);
          el.createSpan({ text: basename(link.path).replace(/\.md$/i, "") });
        },
        problem: disabledSource
          ? "Points to an item you disabled. Enable it and the link works again."
          : "Points to a file or folder that no longer exists.",
        tone: disabledSource ? "warn" : "danger",
        group: disabledSource ? "source disabled" : "source missing",
        facts: [
          { label: "Tool", value: this.getSettings().tools.find((tool) => tool.id === link.tool)?.name ?? link.tool },
          { label: "Type", value: TYPE_LABEL_SINGULAR[link.type] },
          { label: "Link", value: tildePath(link.path), path: true, tooltip: link.path },
          { label: "Target", value: tildePath(link.targetPath), path: true, missing: true, tooltip: link.targetPath },
        ],
        primary: disabledSource
          ? { label: "Enable source", run: () => this.confirmToggle(disabledSource, () => this.toggleEnabled(disabledSource)) }
          : reveal,
        open: linkedItem ? () => this.openItemFromDashboard(linkedItem) : undefined,
        extra: disabledSource ? [reveal] : [],
        disregardKey: this.brokenSymlinkDisregardKey(link),
      };
    });
    this.renderInsightSectionHead(section, "Broken symlinks", rows);
    section.createDiv({
      text: "Links a tool can't follow, so the item behind them never loads. Enable the source when it's disabled, or reveal the link to inspect or remove it.",
      cls: "skillmanager-subtitle",
    });
    this.renderInsightRows(section, rows, "No broken symlinks found.", this.dashboardBrokenSymlinksExpanded, () => {
      this.dashboardBrokenSymlinksExpanded = !this.dashboardBrokenSymlinksExpanded;
    });
    return section;
  }

  /** Items whose manifest would make the tool skip them or never pick them up (see
   *  integrity.ts). "Open" lands on the manifest itself, where the same issues are listed and
   *  Edit is one click away; a plugin or built-in item says who to fix it upstream instead. */
  private renderDashboardIntegrity(body: HTMLElement, list: { item: ItemMetadata; issues: string[] }[]): HTMLElement {
    const section = body.createDiv({ cls: "skillmanager-insights-block skillmanager-insight-section" });
    const metricById = new Map(this.getDashboardMetrics().map((m) => [m.item.entryId, m]));
    const rows: InsightRow[] = list.map(({ item, issues }) => {
      const managed = this.managedBy(item);
      return {
        key: `integrity:${this.integrityDisregardKey(item, issues)}`,
        renderName: (el) => {
          setIcon(el.createSpan({ cls: "skillmanager-dash-row-icon" }), TYPE_ICONS[item.type]);
          el.createSpan({ text: item.name });
        },
        problem: issues.length > 1 ? `${issues[0]} (+${issues.length - 1} more)` : issues[0],
        tone: "warn",
        group: this.toolLabel(item).text,
        facts: (() => {
          const extra = this.insightItemFacts(item, metricById.get(item.entryId));
          return [
            { label: "Tool", value: this.toolLabel(item).text },
            { label: "Type", value: this.itemTypeLabel(item) },
            { label: "Managed by", value: managed.label },
            { label: "Status", value: item.enabled ? "Enabled" : "Disabled" },
            ...(issues.length > 1 ? [{ label: "Issues", value: issues.join("\n"), multiline: true }] : []),
            extra.description,
            extra.edited,
            extra.path,
          ];
        })(),
        primary: { label: "Open", run: () => this.openItemFromDashboard(item, true) },
        disregardKey: this.integrityDisregardKey(item, issues),
      };
    });
    this.renderInsightSectionHead(section, "Integrity issues", rows, false);
    section.createDiv({
      text: "Items a tool may skip or never pick up because of a problem in their file. Open one to see and fix it.",
      cls: "skillmanager-subtitle",
    });
    this.renderInsightRows(section, rows, "No integrity issues found.", this.dashboardIntegrityExpanded, () => {
      this.dashboardIntegrityExpanded = !this.dashboardIntegrityExpanded;
    });
    return section;
  }

  private disabledSourceForBrokenLink(link: BrokenSymlink): ItemMetadata | null {
    // The target may be a folder or a flat file; accept either disabled location.
    const candidates = new Set([disabledLocation(link.targetPath, true), disabledLocation(link.targetPath, false)]);
    return this.items.find(
      (item) => !item.enabled && item.projectId === null && candidates.has(linkableUnit(item.sourcePath).path)
    ) ?? null;
  }

  /** entryId -> the moment it was disabled from this list, dropped once the item's been enabled
   *  again or DASHBOARD_RESTORE_WINDOW_MS has passed since. */
  private pruneExpiredDashboardRestores(): Record<string, number> {
    const settings = this.getSettings();
    const now = Date.now();
    const kept: Record<string, number> = {};
    for (const [entryId, disabledAt] of Object.entries(settings.dashboardRecentlyDisabled)) {
      if (now - disabledAt < DASHBOARD_RESTORE_WINDOW_MS) kept[entryId] = disabledAt;
    }
    return kept;
  }

  /** Disabling from anywhere in the Dashboard (Prune candidates' own button, or the overlap
   *  modal's) goes through here, so every entry point gets the same restore window. */
  private async disableFromDashboard(item: ItemMetadata) {
    const settings = this.getSettings();
    settings.dashboardRecentlyDisabled = { ...this.pruneExpiredDashboardRestores(), [item.entryId]: Date.now() };
    await this.saveSettings();
    this.dashboardMetrics = null;
    this.insightsCounts = null;
    this.claudeUsage = null;
    this.codexUsage = null;
    await this.toggleEnabled(item);
  }

  private async restoreFromDashboard(item: ItemMetadata) {
    const settings = this.getSettings();
    const kept = this.pruneExpiredDashboardRestores();
    delete kept[item.entryId];
    settings.dashboardRecentlyDisabled = kept;
    await this.saveSettings();
    this.dashboardMetrics = null;
    this.insightsCounts = null;
    this.claudeUsage = null;
    this.codexUsage = null;
    await this.toggleEnabled(item);
  }

  /** Opens an item's file preview from anywhere in the Dashboard (a Ranked card, a Prune
   *  candidate row, the overlap modal's name), marking that the eventual "Back" should land on
   *  the Dashboard again rather than the plain Library. */
  private openItemFromDashboard(item: ItemMetadata, openManifest = false) {
    this.detailReturnsToDashboard = true;
    this.dashboardMode = false;
    // clearScopeFilters ran when Dashboard was entered, but it only resets the "scope" group
    // (tool/project/type/plugin/collection) — a stray search query, tag filter, or Enabled/
    // Disabled tab left over from browsing before Dashboard was opened can still exclude the
    // clicked item from the docked grid underneath the detail rail, leaving no card to highlight
    // even though the preview on the right correctly shows it. Clear those too so the item is
    // always present (and selected) in the grid it's opened into.
    this.search = "";
    this.enabledFilter = "all";
    this.tagFilter = null;
    this.untaggedOnly = false;
    this.sourceFilter = null;
    this.ruleKindFilter = null;
    this.pageScopeFilter = null;
    // Dashboard's own content branch never touches the grid, so wasDocked is left at whatever it
    // was the last time the plain Library was rendered — if that happened to be true, renderContent
    // would think the grid is "already docked" and restore the old dockedScrollTop instead of
    // scrolling the newly selected card into view, leaving it selected but off-screen. Forcing
    // false here always takes the "just became docked" branch, which does scroll it into view.
    this.wasDocked = false;
    this.selectItem(item, openManifest);
  }

  /** Description, last edit and location for an item's open panel. The metric is passed when
   *  the caller has one; otherwise the file is stat'd directly (integrity rows can be disabled
   *  items, which getDashboardMetrics leaves out). */
  private insightItemFacts(item: ItemMetadata, metric?: DashboardMetric): { description: InsightFact; edited: InsightFact; path: InsightFact } {
    let mtimeMs = metric?.mtimeMs ?? 0;
    if (!metric) {
      try {
        mtimeMs = statSync(item.sourcePath).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
    }
    return {
      description: { label: "Description", value: item.description || "None", clamp: true, tooltip: item.description || undefined },
      edited: { label: "Last edited", value: mtimeMs ? `${formatDate(mtimeMs)} (${dashboardRelativeAge(Date.now() - mtimeMs)} ago)` : "Unknown" },
      path: { label: "Location", value: tildePath(item.sourcePath), path: true, tooltip: item.sourcePath },
    };
  }

  /** Section title with a per-group count summary ("2 source missing · 1 source disabled") on
   *  the right, where renderDashboardDisregarded later adds its toggle. */
  private renderInsightSectionHead(section: HTMLElement, title: string, rows: InsightRow[], summarize = true) {
    this.renderDashboardSectionHead(section, title, (right) => {
      if (!summarize || rows.length === 0) return;
      const counts = new Map<string, number>();
      for (const row of rows) counts.set(row.group, (counts.get(row.group) ?? 0) + 1);
      right.createSpan({
        text: [...counts].map(([group, n]) => `${n} ${group}`).join(" · "),
        cls: "skillmanager-insight-summary",
      });
    });
  }

  /** One bordered box of expandable rows, collapsed to DASHBOARD_RANKED_COLLAPSED_COUNT with a
   *  Show all toggle when `onToggleAll` is given. Returns the box so callers can append restore
   *  rows to it. */
  private renderInsightRows(
    section: HTMLElement,
    rows: InsightRow[],
    emptyText: string,
    showAll = true,
    onToggleAll?: () => void,
    hasTrailingRows = false
  ): HTMLElement | null {
    if (rows.length === 0 && !hasTrailingRows) {
      section.createDiv({ text: emptyText, cls: "skillmanager-empty" });
      return null;
    }
    const box = section.createDiv({ cls: "skillmanager-insight-box" });
    const shown = onToggleAll && !showAll ? rows.slice(0, DASHBOARD_RANKED_COLLAPSED_COUNT) : rows;
    for (const row of shown) this.renderInsightRow(box, row);
    if (onToggleAll && rows.length > DASHBOARD_RANKED_COLLAPSED_COUNT) {
      const toggleBtn = section.createEl("button", {
        text: showAll ? "Show fewer" : `Show all (${rows.length})`,
        cls: "skillmanager-dash-toggle",
      });
      toggleBtn.addEventListener("click", () => {
        onToggleAll();
        this.render();
      });
    }
    return box;
  }

  /** Name with the problem under it; figure, severity dot and chevron on the right. Clicking
   *  opens a tinted panel with the facts and the actions, always in the same order: the fix,
   *  Open, any extras, Disregard last. */
  private renderInsightRow(box: HTMLElement, row: InsightRow) {
    const isOpen = this.dashboardOpenRows.has(row.key);
    const item = box.createDiv({ cls: `skillmanager-insight-row${isOpen ? " is-open" : ""}` });
    const line = item.createDiv({ cls: "skillmanager-insight-line" });
    line.addEventListener("click", () => {
      if (isOpen) this.dashboardOpenRows.delete(row.key);
      else this.dashboardOpenRows.add(row.key);
      this.render();
    });
    const info = line.createDiv({ cls: "skillmanager-insight-info" });
    const nameRow = info.createDiv({ cls: "skillmanager-dash-row-name skillmanager-insight-name" });
    row.renderName(nameRow);
    nameRow.createSpan({
      text: row.group.charAt(0).toUpperCase() + row.group.slice(1),
      cls: `skillmanager-insight-pill is-${row.tone}`,
    });
    info.createDiv({ text: row.problem, cls: "skillmanager-insight-problem" });
    const control = line.createDiv({ cls: "skillmanager-insight-control" });
    if (row.figure) control.createSpan({ text: row.figure, cls: "skillmanager-insight-figure" });
    setIcon(control.createSpan({ cls: "skillmanager-insight-chevron" }), isOpen ? "chevron-down" : "chevron-right");
    if (!isOpen) return;

    const panel = item.createDiv({ cls: "skillmanager-insight-panel" });
    if (row.pair) {
      const pair = panel.createDiv({ cls: "skillmanager-insight-pair" });
      for (const side of row.pair) {
        const col = pair.createDiv({ cls: "skillmanager-insight-side" });
        // Open is the button below; the name also opens it for anyone who clicks it by habit.
        const name = col.createDiv({ text: side.name, cls: "skillmanager-insight-side-name" });
        name.addEventListener("click", () => this.openItemFromDashboard(side));
        col.createDiv({ text: `${this.toolLabel(side).text} · ${TYPE_LABEL_SINGULAR[side.type]}`, cls: "skillmanager-insight-label" });
        if (this.isSymlinkedItem(side)) {
          const linked = col.createDiv({ cls: "skillmanager-insight-value is-path skillmanager-insight-side-path" });
          linked.createSpan({ text: `Symlinked from ${tildePath(side.realPath)}` });
          setTooltip(linked, side.realPath, { placement: "top" });
        }
        col.createDiv({ text: side.description || "No description", cls: "skillmanager-insight-side-desc" });
        const sideActions = col.createDiv({ cls: "skillmanager-insight-actions" });
        const disable = sideActions.createEl("button", { text: "Disable", cls: "mod-warning" });
        disable.addEventListener("click", () => this.confirmToggle(side, () => this.disableFromDashboard(side)));
        const open = sideActions.createEl("button", { text: "Open", cls: "skillmanager-insight-text-btn" });
        open.addEventListener("click", () => this.openItemFromDashboard(side));
        const del = sideActions.createEl("button", { text: "Delete", cls: "skillmanager-insight-text-btn" });
        del.addEventListener("click", () => this.confirmDelete(side));
      }
    }
    if (row.facts.length > 0) {
      const facts = panel.createDiv({ cls: "skillmanager-insight-facts" });
      for (const fact of row.facts) {
        facts.createDiv({ text: fact.label, cls: "skillmanager-insight-label" });
        const value = facts.createDiv({
          cls: `skillmanager-insight-value${fact.path ? " is-path" : ""}${fact.missing ? " is-missing" : ""}${fact.multiline ? " is-multiline" : ""}${fact.clamp ? " is-clamped" : ""}`,
        });
        value.createSpan({ text: fact.value });
        if (fact.tooltip) setTooltip(value, fact.tooltip, { placement: "top" });
      }
    }
    const actions = panel.createDiv({ cls: "skillmanager-insight-actions" });
    if (row.primary) {
      const { label, warning, run } = row.primary;
      const primary = actions.createEl("button", { text: label, cls: warning ? "mod-warning" : "mod-cta" });
      primary.addEventListener("click", () => run());
    }
    const quiet = (action: InsightAction) => {
      const btn = actions.createEl("button", { text: action.label, cls: "skillmanager-insight-text-btn" });
      btn.addEventListener("click", () => action.run());
    };
    if (row.open) quiet({ label: "Open", run: row.open });
    for (const action of row.extra ?? []) quiet(action);
    quiet({ label: "Disregard", run: () => void this.disregardDashboardRecommendation(row.disregardKey) });
  }

  /** A non-expanding row in the same box: recently disabled items (Restore) and disregarded
   *  ones (Show again). */
  private renderInsightStaticRow(
    box: HTMLElement,
    row: { renderName: (el: HTMLElement) => void; problem: string; action: InsightAction; dimmed?: boolean }
  ) {
    const item = box.createDiv({ cls: `skillmanager-insight-row is-static${row.dimmed ? " is-dimmed" : ""}` });
    const line = item.createDiv({ cls: "skillmanager-insight-line" });
    const info = line.createDiv({ cls: "skillmanager-insight-info" });
    row.renderName(info.createDiv({ cls: "skillmanager-dash-row-name skillmanager-insight-name" }));
    info.createDiv({ text: row.problem, cls: "skillmanager-insight-problem" });
    const btn = line.createEl("button", { text: row.action.label, cls: "skillmanager-dash-action-btn" });
    btn.addEventListener("click", () => row.action.run());
  }

  /** For a recently-disabled item, finds the still-enabled item it used to overlap with (that
   *  pair no longer comes out of findOverlapPairs once one side is disabled) so the "Possible
   *  overlaps" list can keep showing a restore row instead of the pair just vanishing. */
  private findDashboardOverlapRestoreMatch(disabledItem: ItemMetadata, enabledItems: ItemMetadata[]): ItemMetadata | null {
    if (this.isSingleFileRuleTool(disabledItem.tool)) return null;
    let best: ItemMetadata | null = null;
    let bestSameName = false;
    let bestScore = OVERLAP_THRESHOLD;
    for (const candidate of enabledItems) {
      if (candidate.realPath === disabledItem.realPath) continue;
      const sameName = isSameName(disabledItem, candidate);
      const score = pairSimilarity(disabledItem, candidate);
      if (!sameName && score < OVERLAP_THRESHOLD) continue;
      // A name match always outranks a description-only match; within the same kind, prefer the
      // higher score.
      if (!best || (sameName && !bestSameName) || (sameName === bestSameName && score > bestScore)) {
        best = candidate;
        bestSameName = sameName;
        bestScore = score;
      }
    }
    return best;
  }

  private renderDashboardOverlaps(body: HTMLElement, pairs: OverlapPair[], enabledItems: ItemMetadata[]): HTMLElement {
    const section = body.createDiv({ cls: "skillmanager-insights-block skillmanager-insight-section" });
    const headSlot = section.createDiv();
    section.createDiv({
      text: "Not usage-based: enabled items that share an identical name, or have near-duplicate descriptions, likely fighting over the same trigger conditions.",
      cls: "skillmanager-subtitle",
    });
    const introRow = section.createDiv({ cls: "skillmanager-subtitle" });
    introRow.createSpan({ text: "Overlapping items compete for the same requests, so the wrong one may run. " });
    const whyLink = introRow.createEl("a", { text: "Why this matters", cls: "skillmanager-subtitle-link" });
    whyLink.addEventListener("click", (evt) => {
      evt.preventDefault();
      new InfoModal(
        this.app,
        "Why this matters",
        "A tool decides which skill or agent to use by matching your request against each one's name and description. When two enabled items share a name or describe the same job, the tool has no reliable way to tell them apart. It may pick the older or less complete version, switch between them from one session to the next, or load both and spend context twice. Keeping one clear owner per job makes results more predictable. Open the pair to compare them and decide which to keep, or disregard it if they really do different things."
      ).open();
    });

    const now = Date.now();
    const restoreRows = this.getDashboardRestoreRows()
      .map((r) => ({ ...r, match: this.findDashboardOverlapRestoreMatch(r.item, enabledItems) }))
      .filter((r): r is { item: ItemMetadata; disabledAt: number; match: ItemMetadata } => !!r.match);

    const rows: InsightRow[] = pairs.map((pair) => {
      const pct = Math.round(pair.score * 100);
      return {
        key: `overlap:${this.overlapPairKey(pair.a, pair.b)}`,
        renderName: (el) => this.renderOverlapPairName(el, pair.a, pair.b),
        problem: pair.sameName
          ? "Both are enabled under the same name, so a tool may pick either one."
          : "Their descriptions nearly match, so both may answer the same requests.",
        tone: pair.sameName ? "warn" : "muted",
        group: pair.sameName ? "same name" : "similar",
        figure: pair.sameName ? undefined : `${pct}%`,
        facts: [],
        pair: [pair.a, pair.b],
        disregardKey: this.overlapPairKey(pair.a, pair.b),
      };
    });
    this.renderInsightSectionHead(headSlot, "Possible overlaps", rows);
    headSlot.replaceWith(...Array.from(headSlot.childNodes));
    const box = this.renderInsightRows(section, rows, "No overlapping descriptions found.", this.dashboardOverlapsExpanded, () => {
      this.dashboardOverlapsExpanded = !this.dashboardOverlapsExpanded;
    }, restoreRows.length > 0);
    if (box) {
      for (const { item, disabledAt, match } of restoreRows) {
        this.renderInsightStaticRow(box, {
          renderName: (el) => this.renderOverlapPairName(el, item, match),
          problem: `"${item.name}" disabled ${dashboardRelativeAge(now - disabledAt)} ago`,
          action: { label: "Restore", run: () => this.confirmToggle(item, () => this.restoreFromDashboard(item)) },
        });
      }
    }
    return section;
  }

  /** Ranked-by-activity sibling to renderDashboardRanked — rendered for tools with usage data.
   *  Skills and agents are combined into one list. */
  private renderDashboardTopUsed(
    body: HTMLElement,
    ranked: { item: ItemMetadata; stats: ClaudeUsageStats }[],
    loading: boolean,
    toolName: string
  ) {
    const section = body.createDiv({ cls: "skillmanager-insights-block" });
    this.renderDashboardSectionHead(section, "Top Skills & Agents");
    section.createDiv({
      text: `Based on recorded ${toolName} activity, last ${TOP_USED_WINDOW_DAYS} days.`,
      cls: "skillmanager-subtitle",
    });

    const list = section.createDiv({ cls: "skillmanager-dash-ranked-list skillmanager-dash-bar-list" });
    if (loading) {
      list.createDiv({ text: `Scanning ${toolName} history…`, cls: "skillmanager-empty" });
      return;
    }
    if (ranked.length === 0) {
      list.createDiv({ text: "No skill or agent invocations recorded yet.", cls: "skillmanager-empty" });
      return;
    }
    const maxCount = Math.max(...ranked.map((r) => r.stats.count), 1);
    for (const { item, stats } of ranked) this.renderDashboardUsageRow(list, item, stats, maxCount);
  }

  /** Mirrors renderDashboardRow's chrome (icon, name, meta line, bar, right-hand value) — reuses
   *  every skillmanager-dash-row* class as-is, just driven by invocation count instead of cost. */
  private renderDashboardUsageRow(container: HTMLElement, item: ItemMetadata, stats: ClaudeUsageStats, maxCount: number) {
    const row = container.createDiv({ cls: "skillmanager-dash-row" });
    row.addEventListener("click", () => this.openItemFromDashboard(item));

    const info = row.createDiv({ cls: "skillmanager-dash-row-info" });
    const nameRow = info.createDiv({ cls: "skillmanager-dash-row-name" });
    const iconEl = nameRow.createSpan({ cls: "skillmanager-dash-row-icon" });
    setIcon(iconEl, TYPE_ICONS[item.type]);
    this.renderSymlinkIcon(nameRow, item);
    nameRow.createSpan({ text: item.name });
    const lastUsedText = stats.lastUsedMs ? `Last used ${dashboardRelativeAge(Date.now() - stats.lastUsedMs)} ago` : "Never invoked";
    info.createDiv({
      text: item.enabled ? lastUsedText : `${lastUsedText} · disabled`,
      cls: "skillmanager-dash-row-meta",
    });

    const barTrack = row.createDiv({ cls: "skillmanager-dash-bar-track" });
    const barFill = barTrack.createDiv({ cls: "skillmanager-dash-bar-fill" });
    barFill.style.width = `${Math.max(2, (stats.count / maxCount) * 100)}%`;
    barFill.style.background = DASHBOARD_TYPE_COLORS[item.type];

    row.createDiv({ text: stats.count === 1 ? "1 run" : `${stats.count} runs`, cls: "skillmanager-dash-row-cost" });
  }

  /** The Dashboard's one Prune candidates section, always visible (not gated behind selecting the
   *  Claude Code tool card) — mixes two methods in one list, per product decision: Claude Code
   *  skills/agents by real invocation data (usageCandidates, the only tool this plugin can read
   *  one for — see claude-usage.ts), everything else by the mtime heuristic (mtimeCandidates:
   *  other tools' items, plus Claude Code's own commands/rules, which have no usage signal — and,
   *  transiently, Claude Code skills/agents themselves while usage history is still loading, so
   *  the list isn't empty on first open). Each row is tagged "Usage" or "File age" with which
   *  method produced it so the mix is never ambiguous. */
  private renderDashboardPruneCandidates(
    body: HTMLElement,
    usageCandidates: { item: ItemMetadata; stats: ClaudeUsageStats }[],
    mtimeCandidates: DashboardMetric[],
    metrics: DashboardMetric[]
  ): HTMLElement {
    const section = body.createDiv({ cls: "skillmanager-insights-block skillmanager-insight-section" });
    const headSlot = section.createDiv();
    section.createDiv({
      text: `Claude Code skills and agents flagged by real usage (never invoked, or idle ${USAGE_STALE_DAYS}+ days). Everything else flagged by file edit history, since there's no usage signal for those.`,
      cls: "skillmanager-subtitle",
    });
    const introRow = section.createDiv({ cls: "skillmanager-subtitle" });
    introRow.createSpan({ text: "Unused skills and agents still expose metadata every turn. " });
    const whyLink = introRow.createEl("a", { text: "Why this matters", cls: "skillmanager-subtitle-link" });
    whyLink.addEventListener("click", (evt) => {
      evt.preventDefault();
      new InfoModal(
        this.app,
        "Why this matters",
        "An enabled skill or agent may create recurring context overhead before it is ever used. Its name and description can be exposed to the model on each turn so the model knows the capability exists. The instruction body is separate: it is loaded only when the skill or agent is invoked. Unused items may therefore add a small recurring metadata cost, while large instruction bodies mainly affect turns where they are loaded. Actual behavior varies by tool, and commands and rules remain tool-dependent until their loading policies are modeled."
      ).open();
    });

    const now = Date.now();
    const metricById = new Map(metrics.map((m) => [m.item.entryId, m]));
    const pruneRow = (item: ItemMetadata, problem: string, group: string, method: string, stats?: ClaudeUsageStats): InsightRow => {
      const metric = metricById.get(item.entryId);
      const cost = metric?.charCount;
      const extra = this.insightItemFacts(item, metric);
      return {
        key: `prune:${item.entryId}`,
        renderName: (el) => {
          setIcon(el.createSpan({ cls: "skillmanager-dash-row-icon" }), TYPE_ICONS[item.type]);
          this.renderSymlinkIcon(el, item);
          el.createSpan({ text: item.name });
        },
        problem,
        tone: "muted",
        group,
        figure: cost !== undefined ? formatTokens(cost) : undefined,
        facts: [
          { label: "Tool", value: this.toolLabel(item).text },
          { label: "Type", value: TYPE_LABEL_SINGULAR[item.type] },
          extra.description,
          { label: "Flagged by", value: method },
          ...(stats
            ? [
                {
                  label: "Last invoked",
                  value: stats.lastUsedMs ? `${formatDate(stats.lastUsedMs)} (${dashboardRelativeAge(now - stats.lastUsedMs)} ago)` : "Never",
                },
                { label: `Runs (${TOP_USED_WINDOW_DAYS} days)`, value: String(stats.count) },
              ]
            : []),
          extra.edited,
          ...(metric?.alwaysAvailableCharCount != null
            ? [{ label: "Every turn", value: formatTokens(metric.alwaysAvailableCharCount) }]
            : []),
          ...(metric?.invocationCharCount != null ? [{ label: "On invoke", value: formatTokens(metric.invocationCharCount) }] : []),
          extra.path,
        ],
        primary: { label: "Disable", warning: true, run: () => this.confirmToggle(item, () => this.disableFromDashboard(item)) },
        open: () => this.openItemFromDashboard(item),
        disregardKey: item.entryId,
      };
    };
    const rows: InsightRow[] = [
      ...usageCandidates.map(({ item, stats }) =>
        stats.lastUsedMs === 0
          ? pruneRow(item, "Never invoked, but its description is still offered to the model every turn.", "never invoked", "Usage", stats)
          : pruneRow(item, `Last invoked ${dashboardRelativeAge(now - stats.lastUsedMs)} ago.`, "idle", "Usage", stats)
      ),
      ...mtimeCandidates.map(({ item, mtimeMs }) =>
        pruneRow(item, `Not edited since ${mtimeMs ? formatDate(mtimeMs) : "an unknown date"}. No usage data for this tool.`, "old files", "File age")
      ),
    ];
    this.renderInsightSectionHead(headSlot, "Prune candidates", rows);
    headSlot.replaceWith(...Array.from(headSlot.childNodes));

    const restoreRows = this.getDashboardRestoreRows();
    const box = this.renderInsightRows(section, rows, "Nothing flagged. Nice.", this.dashboardPruneExpanded, () => {
      this.dashboardPruneExpanded = !this.dashboardPruneExpanded;
    }, restoreRows.length > 0);
    if (box) {
      for (const { item, disabledAt } of restoreRows) {
        this.renderInsightStaticRow(box, {
          renderName: (el) => {
            setIcon(el.createSpan({ cls: "skillmanager-dash-row-icon" }), TYPE_ICONS[item.type]);
            this.renderSymlinkIcon(el, item);
            el.createSpan({ text: item.name });
          },
          problem: `Disabled ${dashboardRelativeAge(now - disabledAt)} ago`,
          action: { label: "Restore", run: () => this.confirmToggle(item, () => this.restoreFromDashboard(item)) },
        });
      }
    }
    return section;
  }

  // ---------- selection: one detail rail, breadcrumbed between the file list and a file ----------

  /** A folder-based skill with more than one file gets a tree; everything else (a flat
   *  agent/command/rule .md file, or a skill folder with nothing but its own manifest) has
   *  nothing worth browsing, so there's no tree to show. */
  private treeForItem(item: ItemMetadata): TreeNode[] | null {
    if (!isFolderItem(item)) return null;
    const tree = buildFileTree(item);
    return countFiles(tree) > 1 ? tree : null;
  }

  /** `openManifest` skips a multi-file item's file tree and opens its manifest directly. */
  private selectItem(item: ItemMetadata, openManifest = false) {
    const hasTree = !!this.treeForItem(item);
    this.cleanupReview();
    this.selectedItem = item;
    this.detailEditing = false;
    this.addingTagFor = null;
    this.collapsedTreeFolders = new Set();
    this.selectedFilePath = hasTree && !openManifest ? null : item.sourcePath;
    this.pendingDetailAnimation = "forward";
    this.render();
  }

  private selectFile(filePath: string) {
    this.cleanupReview();
    this.selectedFilePath = filePath;
    this.detailEditing = false;
    this.addingTagFor = null;
    this.pendingDetailAnimation = "forward";
    this.render();
  }

  private backToLibrary() {
    this.cleanupReview();
    const returnToDashboard = this.detailReturnsToDashboard;
    this.detailReturnsToDashboard = false;
    this.selectedItem = null;
    this.selectedFilePath = null;
    this.detailLoadedFor = null;
    this.addingTagFor = null;
    this.pendingDetailAnimation = "back";
    if (returnToDashboard) this.dashboardMode = true;
    this.render();
  }

  private backToTree() {
    this.cleanupReview();
    this.selectedFilePath = null;
    this.detailLoadedFor = null;
    this.addingTagFor = null;
    this.pendingDetailAnimation = "back";
    this.render();
  }

  /** The single rail beside the grid: a breadcrumb trail (Library / skill / file) that's always
   *  showing every level up to the current depth, plus whichever body matches that depth — a
   *  file list for a multi-file skill with nothing open yet, or the file itself. Unlike the old
   *  docked-tree-then-docked-file layout, only one thing is ever "deep" at a time, so every level
   *  is one breadcrumb click away rather than a chain of "back" presses whose length depended on
   *  whether the skill happened to have a tree. */
  private renderDetailRail(panel: HTMLElement, item: ItemMetadata) {
    const tree = this.treeForItem(item);
    this.renderBreadcrumbs(panel, item, tree);

    const filePath = tree && !this.selectedFilePath ? null : this.selectedFilePath;
    if (filePath) this.loadFileContent(item, filePath);
    const review = this.review?.entryId === item.entryId ? this.review : null;

    this.renderDetailHeader(panel, item, filePath, review);
    if (review?.status === "ready") {
      this.renderDiffReview(panel, review);
    } else if (tree && !this.selectedFilePath) {
      const list = panel.createDiv({ cls: "skillmanager-tree" });
      this.renderTreeNodes(list, tree, 0);
      panel.createDiv({ cls: "skillmanager-tree-hint", text: "Click a file to open it." });
    } else if (filePath) {
      this.renderFileBody(panel, item, filePath);
    }
    if (review && review.status !== "ready") this.renderReviewStatus(panel, review, item);
  }

  /** A plain, unstyled trail — no button chrome, just text — plus a leading back icon that
   *  always steps up exactly one level (list/single file -> library, a tree's open file -> its
   *  list). "Library" itself is always clickable, the one jump that costs the same regardless of
   *  depth; the skill segment only becomes clickable once a file from its tree is open. */
  private renderBreadcrumbs(panel: HTMLElement, item: ItemMetadata, tree: TreeNode[] | null) {
    const row = panel.createDiv({ cls: "skillmanager-crumbs" });
    const fileOpenFromTree = !!tree && !!this.selectedFilePath;
    const stepBack = () => (fileOpenFromTree ? this.backToTree() : this.backToLibrary());

    const backBtn = row.createEl("button", { cls: "skillmanager-icon-btn", attr: { "aria-label": "Back" } });
    setIcon(backBtn, "arrow-left");
    backBtn.addEventListener("click", stepBack);

    const crumb = (label: string, current: boolean, onClick?: () => void) => {
      const btn = row.createEl("button", { cls: `skillmanager-crumb${current ? " is-current" : ""}`, text: label });
      if (onClick) btn.addEventListener("click", onClick);
      return btn;
    };
    const sep = () => row.createSpan({ cls: "skillmanager-crumb-sep", text: "/" });

    crumb(this.detailReturnsToDashboard ? INSIGHTS_PAGES.find((p) => p.page === this.insightsPage)!.label : "Library", false, () => this.backToLibrary());
    sep();
    crumb(item.name, !fileOpenFromTree, fileOpenFromTree ? () => this.backToTree() : undefined);

    if (fileOpenFromTree && this.selectedFilePath) {
      sep();
      crumb(basename(this.selectedFilePath), true);
    }
  }

  /** Title + type pill + edit action, the tool line under it, then (once a file is open) the
   *  description, a row of callout stats, weekly usage bars and a tinted properties panel whose
   *  footer carries the source repo's actions. Browsing a multi-file skill's tree with nothing
   *  open shows just the header plus the source row, since everything else is file-scoped.
   *  Favourite/add-to-collection/project-link all live on the card (see renderCard/openCardMenu);
   *  Edit is the only action here, since it's file-scoped and works for any file in the tree. */
  private renderDetailHeader(panel: HTMLElement, item: ItemMetadata, filePath: string | null, review: ReviewState | null) {
    const isManifest = !!filePath && filePath === item.sourcePath;
    // Loading/error states stay layered over the normal preview. Only a ready review replaces
    // the file body with diff content.
    const isReviewing = review?.status === "ready";
    const section = panel.createDiv({ cls: "skillmanager-detail-head" });

    const header = section.createDiv({ cls: "skillmanager-detail-header" });
    header.createEl("h3", {
      text: isReviewing
        ? `${review?.mode === "restore" ? "Restore" : "Update"} "${item.name}"`
        : filePath && !isManifest
          ? basename(filePath)
          : item.name,
      cls: "skillmanager-detail-title",
    });
    header.createSpan({ text: this.itemTypeLabel(item), cls: "skillmanager-detail-type-pill" });
    if (filePath && !isReviewing) this.renderDetailActions(header.createDiv({ cls: "skillmanager-detail-actions" }));

    const toolInfo = this.toolLabel(item);
    const toolLine = section.createDiv({ cls: "skillmanager-detail-tool" });
    this.renderIcon(toolLine.createSpan({ cls: "skillmanager-detail-tool-icon" }), toolInfo.icon, toolInfo.svgIcon);
    toolLine.createSpan({ text: this.sourceLabel(item) });

    // A review replaces the file view with a diff (see renderDiffReview); the file-scoped stuff
    // below would either duplicate or fight with that diff, so it's suppressed while it's open.
    if (!filePath || isReviewing) {
      if (item.sourceRepo) this.renderSourceStatusInline(section, item);
      return;
    }

    const fields = isManifest ? parseFrontmatter(this.detailContent).filter((f) => f.value) : [];
    // The raw frontmatter is already editable via the textarea below in edit mode, so the parsed
    // description/extra fields are suppressed while editing to avoid showing the same thing twice.
    if (!this.detailEditing) {
      const description = fields.find((f) => f.key === "description");
      if (description) section.createDiv({ cls: "skillmanager-detail-desc", text: description.value });
    }

    const issues = isManifest ? checkIntegrity(item, this.detailContent, parseYaml) : [];
    if (issues.length > 0) {
      const list = section.createDiv({ cls: "skillmanager-detail-issues" });
      setTooltip(list, "Checks frontmatter, name, description, symlink and links to bundled files. Rechecked every time this opens.", { placement: "top" });
      for (const issue of issues) {
        const row = list.createDiv({ cls: "skillmanager-detail-issue" });
        setIcon(row.createSpan({ cls: "skillmanager-detail-issue-icon" }), "alert-triangle");
        row.createSpan({ text: issue });
      }
    }

    this.renderDetailCallouts(section, item, filePath, isManifest);
    this.renderDetailProperties(section, item, filePath, isManifest, fields);
  }

  /** The big-number row: context cost for the open file, plus sessions/last used for a manifest
   *  whose tool logs usage, followed by a daily heatmap once there's any use to chart. */
  private renderDetailCallouts(container: HTMLElement, item: ItemMetadata, filePath: string, isManifest: boolean) {
    const row = container.createDiv({ cls: "skillmanager-detail-callouts" });
    const callout = (value: string, label: string, tooltip?: string) => {
      const c = row.createDiv({ cls: "skillmanager-detail-callout" });
      c.createDiv({ text: value, cls: "skillmanager-detail-callout-value" });
      const labelEl = c.createDiv({ cls: "skillmanager-detail-callout-label" });
      labelEl.createSpan({ text: label });
      // The label itself is the hover target so the icon reads as a cue, not decoration.
      if (tooltip) {
        setIcon(labelEl.createSpan({ cls: "skillmanager-detail-info" }), "info");
        this.attachInfoTooltip(labelEl, tooltip);
      }
    };

    if (isManifest && (item.type === "skill" || item.type === "agent")) {
      callout(
        formatTokens(`${item.name}\n${item.description}`.length),
        "Available",
        "Estimated name-and-description metadata exposed while this skill or agent is available. For tools that preload it, this can add to the model's context on every turn even when never invoked. Actual behavior varies by tool."
      );
      callout(formatTokens(stripFrontmatter(this.detailContent).length), "On invoke", "Estimated instruction-body tokens loaded when this skill or agent is invoked.");
    } else if (isManifest) {
      callout("Tool-dependent", "Context", "Commands and rules have tool-specific loading behavior. Their context cost is not estimated yet.");
    } else {
      callout(formatTokens(this.detailContent.length), "File tokens", "Estimated tokens in this file. This is a source-size estimate, not necessarily per-turn context.");
    }

    const key = isManifest ? this.usageHistoryKey(item) : null;
    if (!key) return;
    const usage = item.tool === "codex" ? this.getCodexUsage() : this.getClaudeUsage();
    if (!usage) {
      callout("…", "Reading usage");
      return;
    }
    const { columns, total } = buildHeatmap(this.getSettings().usageHistory?.[key] ?? {});
    callout(
      String(total),
      `Sessions (${HEATMAP_WEEKS}w)`,
      item.tool === "codex" ? "Codex doesn't log skill calls by name, so these are matched from file paths in its sessions and may be approximate." : undefined
    );
    callout(formatRelativeDay(this.lastUsedMs(item) ?? 0), "Last used");
    if (total === 0) return;

    // Weeks as columns, Mon to Sun as rows, stretched to the rail's width. No axis labels: each
    // cell's tooltip carries its date, which keeps it small enough to sit under the callouts.
    const max = Math.max(0, ...columns.flat().map((c) => c.count));
    const grid = container.createDiv({ cls: "skillmanager-heatmap" });
    grid.style.gridTemplateColumns = `repeat(${columns.length}, minmax(0, 1fr))`;
    for (let d = 0; d < 7; d++) {
      for (const column of columns) {
        const cell = column[d];
        const el = grid.createDiv({
          cls: `skillmanager-heatmap-cell${cell.future ? " is-future" : ` is-level-${heatLevel(cell.count, max)}`}`,
        });
        if (cell.future) continue;
        const date = new Date(cell.ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
        setTooltip(el, `${cell.count} session${cell.count === 1 ? "" : "s"} on ${date}`, { placement: "top" });
      }
    }
  }

  /** One aligned key/value table on a tinted panel: the skill's own metadata (manifest only),
   *  then file facts, then the source repo and its actions as a footer with real button chrome. */
  private renderDetailProperties(container: HTMLElement, item: ItemMetadata, filePath: string, isManifest: boolean, fields: FrontmatterField[]) {
    const panel = container.createDiv({ cls: "skillmanager-detail-props-panel" });
    const props = panel.createDiv({ cls: "skillmanager-detail-props" });
    const prop = (label: string, fill: (value: HTMLElement) => void, tooltip?: string, valueCls = "") => {
      const key = props.createDiv({ cls: "skillmanager-detail-prop-key" });
      key.createSpan({ text: label });
      if (tooltip) {
        setIcon(key.createSpan({ cls: "skillmanager-detail-info" }), "info");
        setTooltip(key, tooltip, { placement: "top" });
      }
      fill(props.createDiv({ cls: `skillmanager-detail-prop-value${valueCls ? ` ${valueCls}` : ""}` }));
    };
    const text = (value: string) => (el: HTMLElement) => el.setText(value);

    let modified = Date.now();
    let fileSize = 0;
    try {
      const stat = statSync(filePath);
      fileSize = stat.size;
      modified = stat.mtimeMs;
    } catch {
      // file may have moved since the last scan; stats just show defaults
    }

    if (isManifest) {
      const field = (key: string) => fields.find((f) => f.key === key)?.value.trim() ?? "";
      prop("Tags", (el) => this.renderTagChips(el, item));
      if (item.type === "skill") {
        const manualOnly = field("disable-model-invocation") === "true";
        prop(
          "Invocation",
          text(manualOnly ? "Manual only" : "Auto"),
          manualOnly ? "Runs only when you call it by name." : "The model can pick this up on its own when the description matches."
        );
      }
      const managed = this.managedBy(item);
      prop("Managed by", text(managed.label), managed.tooltip);
      const version = field("version") || (item.pluginId ? this.discoveredPlugins.find((p) => p.id === item.pluginId)?.version : "");
      if (version) prop("Version", text(version));
      // name is the title and description is shown as prose above, so neither repeats here.
      if (!this.detailEditing) {
        for (const f of fields) {
          if (f.key !== "name" && f.key !== "description" && f.key !== "version") prop(f.key, text(f.value));
        }
      }
    }
    prop("File", text(`${formatBytes(fileSize)} · ${this.detailContent.length.toLocaleString()} chars · modified ${formatDate(modified)}`));
    prop("Path", text(filePath), undefined, "is-mono");
    if (isManifest && item.realPath !== item.sourcePath) prop("Symlinked from", text(item.realPath), undefined, "is-mono");

    if (item.sourceRepo) {
      const footer = panel.createDiv({ cls: "skillmanager-detail-props-source" });
      const left = footer.createDiv({ cls: "skillmanager-detail-props-source-repo" });
      left.createSpan({ text: "Source", cls: "skillmanager-detail-prop-key" });
      this.renderSourceRepoLine(left, item);
      this.renderSourceButtons(footer.createDiv({ cls: "skillmanager-detail-source-actions" }), item);
    }
  }

  private renderDetailActions(actions: HTMLElement) {
    const editBtn = actions.createEl("button", {
      cls: "skillmanager-icon-btn",
      attr: { "aria-label": this.detailEditing ? "Preview" : "Edit" },
    });
    setIcon(editBtn, this.detailEditing ? "eye" : "pencil");
    editBtn.addEventListener("click", () => {
      this.detailEditing = !this.detailEditing;
      this.render();
    });
  }

  /** Who owns this item's files and how it gets updated: a plugin or the tool itself (both
   *  replace local edits on their own schedule), a tracked GitHub install (updated only through
   *  this plugin's own review flow), or the user alone. */
  private managedBy(item: ItemMetadata): { label: string; tooltip: string } {
    const settings = this.getSettings();
    const toolName = settings.tools.find((t) => t.id === item.tool)?.name ?? item.tool;
    if (item.pluginId) {
      const pluginName = this.discoveredPlugins.find((p) => p.id === item.pluginId)?.name ?? item.pluginId;
      return {
        label: "Plugin",
        tooltip: `Installed by the ${pluginName} plugin. ${toolName} updates it with the plugin, and edits made here are replaced when that happens.`,
      };
    }
    if (isBuiltInPath(item.sourcePath, settings.tools.find((t) => t.id === item.tool))) {
      return { label: "Built-in", tooltip: `Ships with ${toolName}, which updates it. Edits made here may be replaced when it does.` };
    }
    if (item.sourceRepo) {
      const parsed = parseOwnerRepo(item.sourceRepo);
      const repo = parsed ? `${parsed.owner}/${parsed.repo}` : item.sourceRepo;
      const minutes = settings.autoUpdateCheckMinutes;
      const checking = minutes > 0
        ? `New commits are checked for every ${minutes} minutes, but never applied on their own.`
        : "New commits aren't pulled automatically.";
      return {
        label: "GitHub",
        tooltip: `Installed from ${repo}. ${checking} Use Check for updates to pull them; you review the changes before anything is replaced.`,
      };
    }
    return { label: "You", tooltip: "Added by you, with no tracked source. Nothing updates it, so edits here are safe." };
  }

  /** Only Claude Code and Codex write session logs this plugin can read, and only skills and
   *  agents show up in them as discrete invocations (see claude-usage.ts). */
  private usageHistoryKey(item: ItemMetadata): string | null {
    if (item.type !== "skill" && item.type !== "agent") return null;
    if (item.tool === "claude-code") return historyKey(item.tool, usageKey(item.type, invocationName(item)));
    if (item.tool === "codex") return historyKey(item.tool, usageKey(item.type, item.name));
    return null;
  }

  /** Repo line + update actions as one row, for when no file is open (browsing a multi-file
   *  skill's tree, or an active review). With a file open they sit in the properties panel's
   *  footer instead (see renderDetailProperties). Only items installed through "Install from
   *  GitHub" have a sourceRepo; the check itself is on-demand only (a network call). */
  private renderSourceStatusInline(panel: HTMLElement, item: ItemMetadata) {
    const row = panel.createDiv({ cls: "skillmanager-detail-source-inline" });
    this.renderSourceRepoLine(row, item);
    this.renderSourceButtons(row.createDiv({ cls: "skillmanager-detail-source-actions" }), item);
  }

  /** Repo avatar + a link straight to the exact tracked folder/file on GitHub — same avatar
   *  convention (github.com/{owner}.png) and same URL-building (githubSourceUrl) a Discover
   *  card's repo line uses, so an installed item and a not-yet-installed one show provenance the
   *  same way. Doesn't touch the tool pill (Claude Code · Global) up in the header — that answers
   *  "which tool sees this," which has nothing to do with where it came from, and every installed
   *  item has one regardless of whether it happens to also have a sourceRepo. */
  private renderSourceRepoLine(container: HTMLElement, item: ItemMetadata) {
    const repoUrl = item.sourceRepo as string;
    // Keeps the existing skillmanager-detail-source-repo class (and everything the surrounding
    // .skillmanager-detail-source/-inline layouts already key off it for) — just turns its single
    // text node into a small flex row with an avatar in front and a link instead of plain text.
    const row = container.createDiv({ cls: "skillmanager-detail-source-repo" });
    const parsed = parseOwnerRepo(repoUrl);
    if (parsed) {
      row.createEl("img", { cls: "skillmanager-detail-source-avatar", attr: { src: `https://github.com/${parsed.owner}.png?size=32` } });
    }
    row.createEl("a", {
      text: parsed ? `${parsed.owner}/${parsed.repo}` : repoUrl,
      attr: {
        href: githubSourceUrl(repoUrl, item.sourceRef ?? "", item.sourceSubpath ?? "", item.sourceCommit ?? ""),
        target: "_blank",
        rel: "noopener",
        title: repoUrl,
      },
    });
  }

  private renderSourceButtons(actions: HTMLElement, item: ItemMetadata) {
    const checkBtn = actions.createEl("button", { cls: "skillmanager-detail-source-btn" });
    this.setSourceBtnContent(checkBtn, "refresh-cw", "Check for updates");
    this.isolateReviewAction(checkBtn, () => void this.checkForUpdate(item, checkBtn));

    // No ls-remote check needed first — the restore target is already known (whatever commit
    // was recorded at install/last-update time), unlike "Check for updates" which has to ask
    // the remote what's changed.
    const restoreBtn = actions.createEl("button", { cls: "skillmanager-detail-source-btn" });
    this.setSourceBtnContent(restoreBtn, "history", "Restore installed");
    this.isolateReviewAction(restoreBtn, () => void this.startReview(item, "restore"));
  }

  /** Review actions live inside the selected item's detail rail. Keep their pointer/click events
   * from reaching any surrounding navigation or preview controls, which otherwise makes a
   * review request look like a normal file-preview/edit action in some Obsidian versions. */
  private isolateReviewAction(button: HTMLButtonElement, action: () => void) {
    button.addEventListener("pointerdown", (evt) => evt.stopPropagation());
    button.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      action();
    });
  }

  /** Rebuilds a source button's icon + label together — setText()/setIcon() alone would each
   *  wipe out the other's content, since both replace the whole element. */
  private setSourceBtnContent(btn: HTMLButtonElement, icon: string, text: string) {
    btn.empty();
    setIcon(btn.createSpan({ cls: "skillmanager-detail-source-btn-icon" }), icon);
    btn.createSpan({ text });
  }

  private async checkForUpdate(item: ItemMetadata, checkBtn: HTMLButtonElement) {
    checkBtn.disabled = true;
    this.setSourceBtnContent(checkBtn, "loader-2", "Checking…");
    checkBtn.addClass("is-syncing");
    // Give the label a chance to paint before the blocking git call below.
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    try {
      const latest = remoteHeadCommit(item.sourceRepo as string, item.sourceRef || undefined);
      if (latest === item.sourceCommit) {
        this.syncStatus.set(item.entryId, "current");
        new Notice(`"${item.name}" is up to date.`);
        checkBtn.disabled = false;
        checkBtn.removeClass("is-syncing");
        this.setSourceBtnContent(checkBtn, "refresh-cw", "Check for updates");
        return;
      }
      this.syncStatus.set(item.entryId, "stale");
      // Found something — startReview re-renders the whole rail (including this button), so
      // there's nothing left to reset here on the success path.
      await this.startReview(item, "update");
    } catch (e) {
      new Notice(`Couldn't check for updates: ` + errorMessage(e));
      checkBtn.disabled = false;
      checkBtn.removeClass("is-syncing");
      this.setSourceBtnContent(checkBtn, "refresh-cw", "Check for updates");
    }
  }

  /** Starts (or replaces) an inline update/restore review: jumps the rail straight to the item's
   *  manifest file, fetches whichever commit the mode calls for, and diffs it against what's on
   *  disk right now. Shown in place of the normal file preview (see renderDetailRail/
   *  renderDiffReview) rather than a separate view — the point is to review and save right where
   *  you're already looking, not navigate elsewhere. */
  private async startReview(item: ItemMetadata, mode: UpdateMode) {
    const sourceRepo = item.sourceRepo;
    if (!sourceRepo) return;

    this.cleanupReview();
    this.selectedItem = item;
    this.selectedFilePath = item.sourcePath;
    this.detailEditing = false;
    this.pendingDetailAnimation = "forward";
    this.review = { status: "loading", entryId: item.entryId, mode };
    this.render();

    let clone: ClonedRepo | null = null;
    try {
      clone = mode === "restore" ? shallowCloneAtCommit(sourceRepo, item.sourceCommit as string) : shallowCloneRepo(sourceRepo, item.sourceRef || undefined);
      rmSync(join(clone.dir, ".git"), { recursive: true, force: true });

      const subpath = item.sourceSubpath ?? "";
      const newRoot = subpath ? join(clone.dir, subpath) : clone.dir;
      if (!existsSync(newRoot)) {
        throw new Error(`"${subpath}" no longer exists in this repo.`);
      }

      const unit = linkableUnit(item.sourcePath);
      const oldPrimary = unit.isDirectory ? join(unit.path, "SKILL.md") : unit.path;
      const newPrimary = unit.isDirectory ? join(newRoot, "SKILL.md") : newRoot;
      const oldText = existsSync(oldPrimary) ? readFileSync(oldPrimary, "utf-8") : "";
      const newText = existsSync(newPrimary) ? readFileSync(newPrimary, "utf-8") : "";
      const companions = unit.isDirectory ? computeCompanionChanges(unit.path, newRoot) : [];

      // The lightweight update check compares repository commits, so a repo can be newer even
      // when this particular flat command/file (and any companion files) is unchanged. Do not
      // show a context-only "diff" in that case; it is misleading and makes the update look
      // broken. Advancing the tracked commit is safe because there is nothing from this item to
      // apply.
      if (oldText === newText && companions.length === 0) {
        const newCommit = clone.commit;
        clone.cleanup();
        this.render();
        new UnchangedUpdateModal(this.app, item.name, async () => {
          if (mode === "update") {
            await this.store.update(item.entryId, { sourceCommit: newCommit });
            this.syncStatus.set(item.entryId, "current");
          }
          this.render();
        }).open();
        return;
      }

      this.review = {
        status: "ready",
        entryId: item.entryId,
        mode,
        oldText,
        newText,
        companions,
        unitPath: unit.path,
        isDirectory: unit.isDirectory,
        newRoot,
        newCommit: clone.commit,
        clone,
      };
    } catch (e) {
      clone?.cleanup();
      this.review = { status: "error", entryId: item.entryId, mode, message: errorMessage(e) };
    }
    this.render();
  }

  private renderDiffReview(panel: HTMLElement, review: Extract<ReviewState, { status: "ready" }>) {
    const verb = review.mode === "restore" ? "Restore" : "Update";

    renderDiffBody(panel.createDiv(), review.oldText, review.newText);

    if (review.companions.length > 0) {
      const list = panel.createDiv({ cls: "skillmanager-diff-companion-list" });
      list.createDiv({ cls: "skillmanager-modal-meta", text: "Other files in this skill that also changed:" });
      for (const row of review.companions) {
        const rowEl = list.createDiv({ cls: "skillmanager-diff-companion-row" });
        rowEl.createSpan({ cls: `skillmanager-diff-companion-badge is-${row.status}`, text: row.status });
        rowEl.createSpan({ text: row.file });
      }
    }

    const actions = panel.createDiv({ cls: "skillmanager-modal-actions skillmanager-diff-review-actions" });
    actions.createEl("button", { text: "Cancel", cls: "skillmanager-btn-neutral" }).addEventListener("click", () => {
      this.cleanupReview();
      this.render();
    });
    actions.createEl("button", { text: verb, cls: "mod-cta" }).addEventListener("click", () => void this.applyReview());
  }

  private renderReviewStatus(
    panel: HTMLElement,
    review: Extract<ReviewState, { status: "loading" | "error" }>,
    item: ItemMetadata
  ) {
    const status = panel.createDiv({ cls: "skillmanager-review-status" });
    status.createDiv({
      cls: "skillmanager-modal-meta",
      text: review.status === "loading"
        ? review.mode === "restore" ? "Fetching the installed version…" : "Fetching upstream changes…"
        : `Couldn't fetch ${review.mode === "restore" ? "the installed version" : "the update"}: ${review.message}`,
    });
    if (review.status === "error") {
      const actions = status.createDiv({ cls: "skillmanager-modal-actions" });
      actions.createEl("button", { text: "Retry", cls: "mod-cta" }).addEventListener("click", () => {
        void this.startReview(item, review.mode);
      });
      actions.createEl("button", { text: "Dismiss", cls: "skillmanager-btn-neutral" }).addEventListener("click", () => {
        this.cleanupReview();
        this.render();
      });
    }
  }

  private async applyReview() {
    if (this.review?.status !== "ready") return;
    const { mode, unitPath, isDirectory, newRoot, newCommit, entryId, clone } = this.review;
    try {
      await this.replaceUnit(newRoot, unitPath, isDirectory);
      await this.store.update(entryId, { sourceCommit: newCommit });
      if (mode === "update") this.syncStatus.set(entryId, "current");
      clone.cleanup();
      this.review = null;
      // rescan() re-reads the store and, crucially, invalidates the cached file preview so the
      // freshly-written content actually shows instead of what was there before applying.
      await this.rescan();
      new Notice(mode === "restore" ? "Restored." : "Updated.");
    } catch (e) {
      new Notice(`${mode === "restore" ? "Restore" : "Update"} failed: ` + errorMessage(e));
    }
  }

  /** Silent counterpart to startReview("update") + applyReview() — fetches and overwrites, same
   *  as those two, but with no diff computed and no this.review involvement at all. Kept
   *  deliberately independent of the interactive review's state machine (rather than sharing
   *  code with it) so a bulk run can never collide with a review the user has open elsewhere.
   *  Used only by bulkUpdateAll; throws on failure so the caller can keep the batch going. */
  private async silentUpdateItem(item: ItemMetadata): Promise<boolean> {
    const sourceRepo = item.sourceRepo;
    if (!sourceRepo) throw new Error("no source repo");
    let clone: ClonedRepo | null = null;
    try {
      clone = shallowCloneRepo(sourceRepo, item.sourceRef || undefined);
      rmSync(join(clone.dir, ".git"), { recursive: true, force: true });

      const subpath = item.sourceSubpath ?? "";
      const newRoot = subpath ? join(clone.dir, subpath) : clone.dir;
      if (!existsSync(newRoot)) {
        throw new Error(`"${subpath}" no longer exists in this repo.`);
      }

      const unit = linkableUnit(item.sourcePath);
      const oldPrimary = unit.isDirectory ? join(unit.path, "SKILL.md") : unit.path;
      const newPrimary = unit.isDirectory ? join(newRoot, "SKILL.md") : newRoot;
      const primaryChanged = !existsSync(oldPrimary) || !existsSync(newPrimary)
        ? existsSync(oldPrimary) !== existsSync(newPrimary)
        : !readFileSync(oldPrimary).equals(readFileSync(newPrimary));
      const companions = unit.isDirectory ? computeCompanionChanges(unit.path, newRoot) : [];
      const changed = primaryChanged || companions.length > 0;
      // Skip the swap when nothing changed, so a bulk run doesn't fill the trash with identical copies.
      if (changed) await this.replaceUnit(newRoot, unit.path, unit.isDirectory);
      await this.store.update(item.entryId, { sourceCommit: clone.commit });
      return changed;
    } finally {
      clone?.cleanup();
    }
  }

  /** Bulk-checks every sourceRepo item in the whole library (not just what's currently filtered/
   *  searched — matches what "the whole library" means on the unscoped "All" page these buttons
   *  live on) against its remote. Sequential, same as every other git call in this codebase
   *  (remoteHeadCommit/shallowCloneRepo are blocking execFileSync calls) — yields between calls
   *  so the button's progress label actually paints. */
  private async bulkCheckForUpdates(btn: HTMLButtonElement) {
    if (this.bulkCheckInProgress) return;
    this.bulkCheckInProgress = true;
    btn.disabled = true;
    const tracked = this.items.filter((i) => i.sourceRepo);
    let errors = 0;
    for (let i = 0; i < tracked.length; i++) {
      const item = tracked[i];
      btn.setText(`Checking ${i + 1}/${tracked.length}…`);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      try {
        const latest = remoteHeadCommit(item.sourceRepo as string, item.sourceRef || undefined);
        this.syncStatus.set(item.entryId, latest === item.sourceCommit ? "current" : "stale");
      } catch {
        errors++;
      }
    }
    this.bulkCheckInProgress = false;
    new Notice(
      errors > 0
        ? `Checked ${tracked.length}: ${errors} couldn't be reached.`
        : `Checked ${tracked.length} skill${tracked.length === 1 ? "" : "s"}.`
    );
    this.render();
  }

  /** Same remote check as bulkCheckForUpdates, minus the button/progress UI — used by the
   *  plugin's auto-update-check interval. Quiet on a clean check; only surfaces a Notice when it
   *  actually finds something stale (or unreachable), so a background tick doesn't interrupt with
   *  a "you're all good" popup every time it runs. */
  async backgroundCheckForUpdates(): Promise<void> {
    if (this.bulkCheckInProgress) return;
    this.bulkCheckInProgress = true;
    const tracked = this.items.filter((i) => i.sourceRepo);
    let stale = 0;
    let errors = 0;
    for (const item of tracked) {
      try {
        const latest = remoteHeadCommit(item.sourceRepo as string, item.sourceRef || undefined);
        const status = latest === item.sourceCommit ? "current" : "stale";
        this.syncStatus.set(item.entryId, status);
        if (status === "stale") stale++;
      } catch {
        errors++;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    this.bulkCheckInProgress = false;
    if (stale > 0) {
      new Notice(`${stale} skill${stale === 1 ? "" : "s"} ${stale === 1 ? "has" : "have"} an update available.`);
    } else if (errors > 0 && tracked.length === errors) {
      new Notice(`Auto update check: couldn't reach ${errors} source${errors === 1 ? "" : "s"}.`);
    }
    this.render();
  }

  /** Silently applies every item bulkCheckForUpdates found stale. cleanupReview() first is
   *  defensive — these buttons live on the always-visible "All" page toolbar, so a review could
   *  in principle still be open when this runs. */
  private async bulkUpdateAll(btn: HTMLButtonElement) {
    if (this.bulkUpdateInProgress) return;
    this.bulkUpdateInProgress = true;
    btn.disabled = true;
    this.cleanupReview();
    const stale = this.items.filter((i) => this.syncStatus.get(i.entryId) === "stale");
    let updated = 0;
    let unchanged = 0;
    let errors = 0;
    for (let i = 0; i < stale.length; i++) {
      const item = stale[i];
      btn.setText(`Updating ${i + 1}/${stale.length}…`);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      try {
        const changed = await this.silentUpdateItem(item);
        this.syncStatus.set(item.entryId, "current");
        if (changed) updated++;
        else unchanged++;
      } catch {
        errors++;
      }
    }
    this.bulkUpdateInProgress = false;
    await this.rescan();
    new Notice(
      errors > 0
        ? `Updated ${updated}, accepted ${unchanged} unchanged, ${errors} failed.`
        : unchanged > 0
          ? `Updated ${updated}; accepted ${unchanged} unchanged.`
          : `Updated ${updated} skill${updated === 1 ? "" : "s"}.`
    );
  }

  private renderTreeNodes(container: HTMLElement, nodes: TreeNode[], depth: number) {
    for (const node of nodes) {
      const collapsed = node.isDir && this.collapsedTreeFolders.has(node.relPath);
      const isActiveFile = !node.isDir && node.absPath === this.selectedFilePath;
      const row = container.createDiv({
        cls: `skillmanager-tree-item${node.isDir ? " is-dir" : ""}${isActiveFile ? " is-active" : ""}`,
      });
      row.style.setProperty("--skillmanager-tree-depth", String(depth));

      const chevron = row.createSpan({ cls: "skillmanager-tree-chevron" });
      if (node.isDir) setIcon(chevron, collapsed ? "chevron-right" : "chevron-down");

      const icon = row.createSpan({ cls: "skillmanager-tree-icon" });
      setIcon(icon, node.isDir ? (collapsed ? "folder" : "folder-open") : "file-text");
      row.createSpan({ text: node.name, cls: "skillmanager-tree-label" });

      if (node.isDir) {
        row.addEventListener("click", () => {
          if (collapsed) this.collapsedTreeFolders.delete(node.relPath);
          else this.collapsedTreeFolders.add(node.relPath);
          this.render();
        });
      } else {
        row.addEventListener("click", () => this.selectFile(node.absPath));
      }

      if (node.isDir && node.children && !collapsed) {
        this.renderTreeNodes(container, node.children, depth + 1);
      }
    }
  }

  // ---------- file content (rendered inside the detail rail, below the identity band) ----------

  /** Reads (and caches) the open file's content — shared by renderDetailHeader (stats, parsed
   *  frontmatter) and renderFileBody (the textarea/reading view), so both see the same content
   *  without reading the file twice per render. */
  private loadFileContent(item: ItemMetadata, filePath: string) {
    const loadKey = `${item.entryId}:${filePath}`;
    if (this.detailLoadedFor === loadKey) return;
    try {
      this.detailContent = readFileSync(filePath, "utf-8");
    } catch (e) {
      this.detailContent = "";
      new Notice("Could not read file: " + errorMessage(e));
    }
    this.detailLoadedFor = loadKey;
    this.detailEditing = false;
  }

  private renderFileBody(panel: HTMLElement, item: ItemMetadata, filePath: string) {
    const isManifest = filePath === item.sourcePath;
    const body = panel.createDiv({ cls: "skillmanager-detail-body" });
    if (this.detailEditing) {
      // Styled and behaved like Obsidian's own source-mode editor rather than a form field:
      // no input-box chrome, grows with its content instead of scrolling in a box, Tab indents
      // instead of leaving the field, and Cmd/Ctrl+S saves without reaching for the mouse.
      const editWrap = body.createDiv({ cls: "skillmanager-edit-wrap" });
      const textarea = editWrap.createEl("textarea", {
        cls: "skillmanager-edit-textarea",
        attr: { spellcheck: "true" },
      });
      textarea.value = this.detailContent;

      const autoGrow = () => {
        textarea.setCssProps({ height: "auto" });
        textarea.setCssProps({ height: `${textarea.scrollHeight}px` });
      };
      textarea.addEventListener("input", autoGrow);
      window.requestAnimationFrame(autoGrow);

      const save = () => {
        void (async () => {
          try {
            writeFileSync(filePath, textarea.value, "utf-8");
            this.detailContent = textarea.value;
            // The saved frontmatter may have changed name/description — re-derive them
            // rather than leaving the shadow note (and card) showing stale values. Only the
            // manifest carries this frontmatter; a sibling file has nothing to re-derive.
            if (isManifest) {
              const meta = parseSourceMeta(textarea.value);
              const updated = await this.store.ensureItem({
                entryId: item.entryId,
                sourcePath: item.sourcePath,
                realPath: item.realPath,
                tool: item.tool,
                type: item.type,
                projectId: item.projectId,
                pluginId: item.pluginId,
                name: meta.name || item.name,
                description: meta.description,
                enabled: item.enabled,
              });
              this.items = this.items.map((i) => (i.entryId === item.entryId ? updated : i));
              this.selectedItem = updated;
            }
            this.detailEditing = false;
            this.integrityIssues = null;
            this.insightsCounts = null;
            new Notice("Saved.");
            this.render();
          } catch (e) {
            new Notice("Save failed: " + errorMessage(e));
          }
        })();
      };

      const cancel = () => {
        this.detailEditing = false;
        this.render();
      };

      textarea.addEventListener("keydown", (evt) => {
        if (evt.key === "Tab") {
          evt.preventDefault();
          const { selectionStart, selectionEnd } = textarea;
          textarea.setRangeText("\t", selectionStart, selectionEnd, "end");
          autoGrow();
        } else if ((evt.metaKey || evt.ctrlKey) && evt.key === "s") {
          evt.preventDefault();
          save();
        } else if (evt.key === "Escape") {
          evt.preventDefault();
          cancel();
        }
      });

      const saveRow = body.createDiv({ cls: "skillmanager-detail-save-row" });
      const cancelBtn = saveRow.createEl("button", { text: "Cancel", cls: "skillmanager-btn-neutral" });
      cancelBtn.addEventListener("click", cancel);
      const saveBtn = saveRow.createEl("button", { text: "Save", cls: "mod-cta" });
      saveBtn.addEventListener("click", save);

      window.setTimeout(() => textarea.focus(), 0);
    } else {
      // Mirrors the DOM Obsidian's own reading view builds (markdown-preview-view >
      // markdown-preview-sizer/-section) so the active theme's note styling — code fences,
      // headings, callouts, tables — applies here exactly as it would in a real note.
      const readingView = body.createDiv({
        cls: "markdown-preview-view markdown-rendered node-insert-event is-readable-line-width allow-fold-headings allow-fold-lists show-indentation-guide skillmanager-markdown-preview",
      });
      const sizer = readingView.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
      void MarkdownRenderer.render(
        this.app,
        stripFrontmatter(this.detailContent),
        sizer,
        filePath,
        this.markdownComponent
      );
    }
  }

  /** Renders one "key: value" row styled like a syntax-highlighted YAML block. Values across
   *  rows share a fixed-width label column so they left-align with each other regardless of
   *  the key's length (e.g. "name" vs "description"). */
  private renderFrontmatterRow(container: HTMLElement, key: string, value: string) {
    const row = container.createDiv({ cls: "skillmanager-fm-row" });
    const label = row.createSpan({ cls: "skillmanager-fm-label" });
    label.createSpan({ text: key, cls: "skillmanager-fm-key" });
    label.createSpan({ text: ":", cls: "skillmanager-fm-colon" });
    row.createSpan({ text: value, cls: "skillmanager-fm-value" });
  }

  /** Tag chips, each with its own remove button, plus a "+ tag" affordance that swaps itself for
   *  an inline input. Shown in the properties panel (see renderDetailProperties) rather than the old
   *  comma-separated text field at the very bottom of the panel. */
  private renderTagChips(container: HTMLElement, item: ItemMetadata) {
    const row = container.createDiv({ cls: "skillmanager-detail-tags-row" });

    for (const tag of item.tags) {
      const chip = row.createDiv({ cls: "skillmanager-tag-chip" });
      chip.createSpan({ text: tag });
      const removeBtn = chip.createEl("button", {
        cls: "skillmanager-tag-chip-remove",
        text: "×",
        attr: { "aria-label": `Remove tag "${tag}"` },
      });
      removeBtn.addEventListener("click", () => {
        void this.applyItemUpdate(item.entryId, { tags: item.tags.filter((t) => t !== tag) });
      });
    }

    if (this.addingTagFor !== item.entryId) {
      const addBtn = row.createEl("button", { cls: "skillmanager-tag-add-btn", text: "+ tag" });
      addBtn.addEventListener("click", () => {
        this.addingTagFor = item.entryId;
        this.render();
      });
      return;
    }

    const input = row.createEl("input", {
      type: "text",
      cls: "skillmanager-tag-add-input",
      attr: { placeholder: "Tag name" },
    });
    // Enter, Escape, and blur (clicking away) can all end the input, but only one of them
    // should actually act — re-rendering on the first one detaches this element, which fires a
    // trailing "blur" the others didn't ask for.
    let settled = false;
    const finish = (save: boolean) => {
      if (settled) return;
      settled = true;
      this.addingTagFor = null;
      const value = input.value.trim();
      if (save && value && !item.tags.includes(value)) {
        void this.applyItemUpdate(item.entryId, { tags: [...item.tags, value] });
      } else {
        this.render();
      }
    };
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") {
        evt.preventDefault();
        finish(true);
      } else if (evt.key === "Escape") {
        evt.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    window.setTimeout(() => input.focus(), 0);
  }
}
