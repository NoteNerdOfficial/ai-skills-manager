import { Component, ItemView, Menu, MarkdownRenderer, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import { cpSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { basename, join } from "path";
import {
  Collection,
  DiscoverEntry,
  EnabledFilter,
  ItemMetadata,
  ItemType,
  PLUGIN_ICON_ID,
  PluginSource,
  SkillSpacePluginSettings,
  SortOrder,
  TYPE_LABEL_SINGULAR,
  TYPE_LABELS,
} from "../types";
import { parseFrontmatter, parseSourceMeta, FrontmatterField } from "../scanners";
import { addToProject, removeFromProject } from "../projectLink";
import { deleteItem, toggleItemEnabled } from "../itemToggle";
import { linkableUnit } from "../fsUnit";
import { ShadowNoteStore } from "../store";
import { upsertCollectionAndSync } from "../collections";
import { CollectionEditModal } from "../modals/CollectionEditModal";
import { AddToCollectionModal } from "../modals/AddToCollectionModal";
import { ProjectPresenceModal } from "../modals/ProjectPresenceModal";
import { InstallFromGitHubModal } from "../modals/InstallFromGitHubModal";
import { AddDiscoverSourceModal } from "../modals/AddDiscoverSourceModal";
import { ConfirmModal } from "../modals/ConfirmModal";
import {
  dedupeDiscoverCatalog,
  discoverGitSkills,
  discoverSourceId,
  fetchGithubStars,
  githubSourceUrl,
  parseOwnerRepo,
  refetchDiscoverEntry,
} from "../discover";
import { errorMessage } from "../errors";
import { formatBytes, formatDate, formatTokens, stripFrontmatter } from "../format";
import { buildFileTree, countFiles, isFolderItem, TreeNode } from "../fileTree";
import { getAllProjects as computeAllProjects, performRescan, RescanResult, VAULT_PROJECT_ID } from "../rescan";
import { sourceLabel as resolveSourceLabel } from "../sourceLabel";
import { ClonedRepo, remoteHeadCommit, shallowCloneAtCommit, shallowCloneRepo } from "../git";
import { renderDiffBody } from "../diff/renderDiff";
import { computeCompanionChanges, CompanionRow } from "../diff/companions";

export const LIBRARY_VIEW_TYPE = "skillspace-library-view";

export type UpdateMode = "update" | "restore";

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
];

type DiscoverSortOrder = "recent-desc" | "name-asc" | "name-desc" | "stars-desc" | "source";

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

const TAG_COLORS = 8;

function tagColorIndex(tag: string): number {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = (hash * 31 + tag.charCodeAt(i)) >>> 0;
  }
  return hash % TAG_COLORS;
}

export class LibraryView extends ItemView {
  private items: ItemMetadata[] = [];
  private search = "";
  private enabledFilter: EnabledFilter = "all";
  private sortOrder: SortOrder = "name-asc";
  private typeFilter: ItemType | null = null;
  private toolFilter: string | null = null;
  private collectionFilter: string | null = null;
  private projectFilter: string | null = null;
  private pluginFilter: string | null = null;
  private favoritesOnly = false;
  /** True while the sidebar's "Discover" row is active — swaps the whole content pane for the
   *  catalog grid (see renderContent/renderDiscoverContent) instead of the normal filtered
   *  library grid. Not one of the scope filters below since it isn't a way of narrowing
   *  this.items — Discover browses settings.discoverCatalog instead. */
  private discoverMode = false;
  private discoverSearch = "";
  private discoverSortOrder: DiscoverSortOrder = "recent-desc";
  private discoverTypeFilter: ItemType | null = null;
  /** The catalog entry currently open in the Discover rail (see renderDiscoverRail) — mirrors
   *  selectedItem's role for the real library, but stays entirely separate: a DiscoverEntry has
   *  no tree/file/edit state to track. */
  private selectedDiscoverEntry: DiscoverEntry | null = null;
  private refreshingAllDiscover = false;
  private rescanningManually = false;
  private tagFilter: string | null = null;
  private untaggedOnly = false;
  private collapsedSections = new Set<string>();
  private draggedSectionKey: string | null = null;
  private dragHighlightEl: HTMLElement | null = null;
  private discoveredPlugins: PluginSource[] = [];

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
  private moreFieldsExpanded = false;

  constructor(
    leaf: WorkspaceLeaf,
    private getSettings: () => SkillSpacePluginSettings,
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
    this.items = result.items;
    if (this.selectedItem) {
      this.selectedItem = this.items.find((i) => i.entryId === this.selectedItem?.entryId) ?? null;
    }
    // Whatever file is open in the rail may have just changed on disk out from under it (a
    // restore/update, an external edit) — invalidate the cached preview so renderFileContent
    // re-reads it instead of showing what was there before this rescan.
    this.detailLoadedFor = null;
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
      new Notice(`Rescan complete — ${result.items.length} item${result.items.length === 1 ? "" : "s"} found.`);
    } finally {
      this.rescanningManually = false;
      this.render();
    }
  }

  /** Actually enables/disables an item by moving its file — the tool only ever sees whatever
   *  files sit in its configured directories, so anything less than a real move has no effect
   *  on it. This changes the item's path, so a rescan (not an optimistic patch) follows. */
  private async toggleEnabled(item: ItemMetadata) {
    try {
      toggleItemEnabled(item);
    } catch (e) {
      new Notice(`Couldn't toggle "${item.name}": ` + errorMessage(e));
      return;
    }
    await this.rescan();
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
    const linkedSomewhere = this.items.some((i) => i.projectId && i.realPath === globalItem.realPath);
    const btn = container.createEl("button", {
      cls: `skillspace-icon-btn${linkedSomewhere ? " is-present" : ""}`,
      attr: { "aria-label": linkedSomewhere ? "Manage project links" : "Link into a project workspace" },
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

  private openInstallFromGitHub() {
    new InstallFromGitHubModal(this.app, this.getSettings(), this.getAllProjects(), this.store, () => this.rescan()).open();
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

  /** The one choke point every sidebar nav row calls before setting its own filter (see
   *  renderSidebar/renderTypesSection/renderToolsSection/renderProjectsSection/
   *  renderPluginsSection/renderCollectionsSection) — so jumping to a different scope from the
   *  sidebar always lands on that scope's fresh list, closing out whatever card + file preview
   *  happened to be docked open rather than leaving it stuck there until the user manually clicks
   *  "Library" in the breadcrumb. Mirrors backToLibrary()'s reset. */
  private clearScopeFilters() {
    this.typeFilter = null;
    this.toolFilter = null;
    this.collectionFilter = null;
    this.projectFilter = null;
    this.pluginFilter = null;
    this.favoritesOnly = false;
    this.discoverMode = false;
    this.selectedDiscoverEntry = null;
    this.cleanupReview();
    this.selectedItem = null;
    this.selectedFilePath = null;
    this.detailLoadedFor = null;
    this.addingTagFor = null;
    this.moreFieldsExpanded = false;
  }

  private isScoped(): boolean {
    return !!(
      this.typeFilter ||
      this.toolFilter ||
      this.collectionFilter ||
      this.projectFilter ||
      this.pluginFilter ||
      this.favoritesOnly ||
      this.discoverMode
    );
  }

  private filteredItems(): ItemMetadata[] {
    const query = this.search.trim().toLowerCase();
    const filtered = this.items.filter((item) => {
      if (this.enabledFilter === "enabled" && !item.enabled) return false;
      if (this.enabledFilter === "disabled" && item.enabled) return false;
      if (this.favoritesOnly && !item.favorite) return false;
      if (this.typeFilter && item.type !== this.typeFilter) return false;
      if (this.toolFilter && item.tool !== this.toolFilter) return false;
      if (this.collectionFilter && !item.collections.includes(this.collectionFilter)) return false;
      if (this.projectFilter && item.projectId !== this.projectFilter) return false;
      if (this.pluginFilter && item.pluginId !== this.pluginFilter) return false;
      if (this.untaggedOnly && item.tags.length > 0) return false;
      if (this.tagFilter && !item.tags.includes(this.tagFilter)) return false;
      if (query) {
        const haystack = `${item.name} ${item.description}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
    return this.sortItems(filtered);
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
    }
    return sorted;
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
    if (this.typeFilter) return TYPE_LABELS[this.typeFilter];
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
    return "All skills";
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
        rule: "Standing instructions and memories your tools always apply.",
      };
      return descriptions[this.typeFilter];
    }
    if (this.toolFilter) {
      const tool = settings.tools.find((t) => t.id === this.toolFilter);
      return tool?.id === "global"
        ? "Shared across every tool via ~/.agents/skills — projects symlink into this instead of keeping their own copy."
        : `Everything found in ${tool?.name ?? "this tool"}'s configured directories.`;
    }
    if (this.projectFilter) {
      return this.projectFilter === VAULT_PROJECT_ID
        ? "Skills scoped to this vault's own project-local folders, symlinked in from your shared library."
        : "Skills scoped to this project's local folders, symlinked in from your shared library.";
    }
    if (this.pluginFilter) {
      return "Bundled with this installed plugin — its own package, separate from your tool's global directories.";
    }
    if (this.favoritesOnly) return "Items you've starred for quick access.";
    return "Every skill, agent, and command across your configured tools and projects.";
  }

  private render() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("skillspace-view");

    this.renderSidebar(container.createDiv({ cls: "skillspace-sidebar" }));
    this.renderContent(container.createDiv({ cls: "skillspace-content" }));
  }

  // ---------- sidebar ----------

  private renderSidebar(sidebar: HTMLElement) {
    const brand = sidebar.createDiv({ cls: "skillspace-brand" });
    const brandLeft = brand.createDiv({ cls: "skillspace-brand-left" });
    const brandIcon = brandLeft.createSpan({ cls: "skillspace-brand-icon" });
    setIcon(brandIcon, PLUGIN_ICON_ID);
    brandLeft.createSpan({ text: "AI Skills Manager", cls: "skillspace-brand-name" });

    const installBtn = brand.createEl("button", {
      cls: "skillspace-icon-btn skillspace-install-btn",
      attr: { "aria-label": "Install from GitHub" },
    });
    setIcon(installBtn, "plus");
    installBtn.addEventListener("click", () => this.openInstallFromGitHub());

    // Library — always first, not reorderable.
    sidebar.createDiv({ cls: "skillspace-sidebar-heading", text: "Library" });
    this.renderNavRow(sidebar, "library", "All skills", this.items.length, !this.isScoped(), () => {
      this.clearScopeFilters();
      this.render();
    });
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

    const sectionRenderers: Record<string, (sidebar: HTMLElement) => void> = {
      types: (s) => this.renderTypesSection(s),
      tools: (s) => this.renderToolsSection(s),
      projects: (s) => this.renderProjectsSection(s),
      plugins: (s) => this.renderPluginsSection(s),
      collections: (s) => this.renderCollectionsSection(s),
    };
    for (const key of this.getSettings().sectionOrder) {
      if (this.isSectionVisible(key)) sectionRenderers[key]?.(sidebar);
    }

    const footer = sidebar.createDiv({ cls: "skillspace-sidebar-footer" });
    this.renderNavRow(
      footer,
      "refresh-cw",
      "Rescan tools",
      null,
      false,
      () => void this.manualRescan(),
      undefined,
      this.rescanningManually
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
      (evt.target as HTMLElement).closest<HTMLElement>(".skillspace-sidebar-heading-collapsible");

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
    if (key === "plugins") return this.discoveredPlugins.length > 0;
    return true;
  }

  private renderTypesSection(sidebar: HTMLElement) {
    if (!this.renderCollapsibleHeading(sidebar, "types", "Types")) return;
    for (const type of Object.keys(TYPE_LABELS) as ItemType[]) {
      const count = this.items.filter((i) => i.type === type).length;
      this.renderNavRow(sidebar, TYPE_ICONS[type], TYPE_LABELS[type], count, this.typeFilter === type, () => {
        this.clearScopeFilters();
        this.typeFilter = this.typeFilter === type ? null : type;
        this.render();
      });
    }
  }

  private renderToolsSection(sidebar: HTMLElement) {
    if (!this.renderCollapsibleHeading(sidebar, "tools", "Global workspace")) return;
    const showEmpty = this.getSettings().showEmptySidebarRows;
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
    if (!this.renderCollapsibleHeading(sidebar, "projects", "Project workspaces")) return;
    const showEmpty = this.getSettings().showEmptySidebarRows;
    const projects = this.getAllProjects();
    for (const project of projects) {
      const count = this.items.filter((i) => i.projectId === project.id).length;
      if (!showEmpty && count === 0) continue;
      const icon = project.id === VAULT_PROJECT_ID ? "book-marked" : "folder-git-2";
      this.renderNavRow(sidebar, icon, project.name, count, this.projectFilter === project.id, () => {
        this.clearScopeFilters();
        this.projectFilter = this.projectFilter === project.id ? null : project.id;
        this.render();
      });
    }
    if (projects.length <= 1) {
      sidebar.createDiv({ cls: "skillspace-sidebar-empty", text: "Add more project folders in settings" });
    }
  }

  private renderPluginsSection(sidebar: HTMLElement) {
    if (!this.renderCollapsibleHeading(sidebar, "plugins", "Plugins")) return;
    for (const plugin of this.discoveredPlugins) {
      const count = this.items.filter((i) => i.pluginId === plugin.id).length;
      this.renderNavRow(sidebar, "package", plugin.name, count, this.pluginFilter === plugin.id, () => {
        this.clearScopeFilters();
        this.pluginFilter = this.pluginFilter === plugin.id ? null : plugin.id;
        this.render();
      });
    }
  }

  private renderCollectionsSection(sidebar: HTMLElement) {
    const settings = this.getSettings();
    const expanded = this.renderCollapsibleHeading(sidebar, "collections", "Collections", (actionWrap) => {
      const addBtn = actionWrap.createEl("button", { cls: "skillspace-icon-btn", attr: { "aria-label": "New collection" } });
      setIcon(addBtn, "plus");
      addBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        new CollectionEditModal(this.app, null, this.items, (collection) => this.upsertCollection(collection)).open();
      });
    });
    if (!expanded) return;

    if (settings.collections.length === 0) {
      sidebar.createDiv({ cls: "skillspace-sidebar-empty", text: "No collections yet" });
    }

    for (const collection of settings.collections) {
      const row = sidebar.createDiv({ cls: "skillspace-nav-item" });
      const icon = row.createSpan({ cls: "skillspace-nav-icon" });
      setIcon(icon, "folder");
      row.createSpan({ text: collection.name, cls: "skillspace-nav-label" });
      if (this.collectionFilter === collection.id) row.addClass("is-active");

      const actions = row.createDiv({ cls: "skillspace-nav-actions" });
      const members = this.items.filter((item) => collection.itemIds.includes(item.entryId));
      const allOn = members.length > 0 && members.every((item) => item.enabled);

      const toggle = actions.createEl("button", {
        cls: `skillspace-toggle skillspace-toggle-sm${allOn ? " is-on" : ""}`,
        attr: { "aria-label": "Enable or disable every item in this collection" },
      });
      toggle.addEventListener("click", (evt) => {
        evt.stopPropagation();
        void this.toggleCollection(collection.id);
      });

      const editBtn = actions.createEl("button", { cls: "skillspace-icon-btn", attr: { "aria-label": "Edit collection" } });
      setIcon(editBtn, "pencil");
      editBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        new CollectionEditModal(this.app, collection, this.items, (updated) => this.upsertCollection(updated)).open();
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
    renderAction?: (container: HTMLElement) => void
  ): boolean {
    const isCollapsed = this.collapsedSections.has(key);
    const heading = sidebar.createDiv({ cls: "skillspace-sidebar-heading skillspace-sidebar-heading-collapsible" });
    heading.dataset.sectionKey = key;

    const left = heading.createDiv({ cls: "skillspace-sidebar-heading-left" });
    left.setAttr("draggable", "true");
    const chevron = left.createSpan({ cls: "skillspace-chevron" });
    setIcon(chevron, isCollapsed ? "chevron-right" : "chevron-down");
    left.createSpan({ text: title });
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
      renderAction(heading.createDiv({ cls: "skillspace-sidebar-heading-action" }));
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
    spinning?: boolean
  ) {
    const row = parent.createDiv({ cls: "skillspace-nav-item" });
    if (active) row.addClass("is-active");
    const iconEl = row.createSpan({ cls: "skillspace-nav-icon" });
    this.renderIcon(iconEl, icon, svgIcon);
    if (spinning) iconEl.addClass("is-syncing");
    row.createSpan({ text: label, cls: "skillspace-nav-label" });
    if (count !== null) row.createSpan({ text: String(count), cls: "skillspace-nav-count" });
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

  private async toggleCollection(collectionId: string) {
    const collection = this.getSettings().collections.find((c) => c.id === collectionId);
    if (!collection) return;

    const members = this.items.filter((item) => collection.itemIds.includes(item.entryId));
    const shouldEnable = members.some((item) => !item.enabled);
    for (const item of members) {
      if (item.enabled === shouldEnable) continue;
      try {
        toggleItemEnabled(item);
      } catch (e) {
        new Notice(`Couldn't toggle "${item.name}": ` + errorMessage(e));
      }
    }
    await this.rescan();
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

  // ---------- content ----------

  private renderContent(content: HTMLElement) {
    if (this.discoverMode) {
      this.renderDiscoverContent(content);
      return;
    }

    const items = this.filteredItems();

    const header = content.createDiv({ cls: "skillspace-content-header" });
    const titleRow = header.createDiv({ cls: "skillspace-title-row" });
    titleRow.createEl("h2", { text: this.scopeTitle(), cls: "skillspace-title" });
    titleRow.createSpan({ text: String(items.length), cls: "skillspace-count-pill" });
    header.createDiv({ text: this.scopeDescription(), cls: "skillspace-subtitle" });

    const toolbar = content.createDiv({ cls: "skillspace-toolbar" });

    const searchWrap = toolbar.createDiv({ cls: "skillspace-search-wrap" });
    const searchIcon = searchWrap.createSpan({ cls: "skillspace-search-icon" });
    setIcon(searchIcon, "search");
    const searchInput = searchWrap.createEl("input", {
      type: "text",
      placeholder: "Search skills, agents, commands…",
      cls: "skillspace-search",
    });
    searchInput.value = this.search;

    const clearBtn = searchWrap.createEl("button", {
      cls: "skillspace-icon-btn skillspace-search-clear",
      attr: { "aria-label": "Clear search" },
    });
    setIcon(clearBtn, "x");
    const updateClearBtn = () => clearBtn.toggle(searchInput.value.length > 0);
    updateClearBtn();

    const segmented = toolbar.createDiv({ cls: "skillspace-segmented" });
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

    this.renderTagBar(content.createDiv({ cls: "skillspace-tagbar" }));

    const body = content.createDiv({ cls: "skillspace-body" });

    // The grid is always on screen and always the same width once something's selected — it
    // never gets replaced by a tree or narrowed further to make room for a file. The one thing
    // that changes with depth is the detail rail beside it (see renderDetailRail), so only that
    // rail gets the enter animation, and only for a real navigation action (see
    // selectItem/selectFile/backToTree/backToLibrary) — an unrelated re-render (reordering a
    // sidebar section, toggling a card, favouriting) never replays it.
    const animation = this.pendingDetailAnimation;
    this.pendingDetailAnimation = null;

    const grid = body.createDiv({ cls: `skillspace-items${this.selectedItem ? " is-docked" : ""}` });
    const itemsEl = grid;
    this.renderItems(grid, items);
    if (this.selectedItem) {
      if (this.wasDocked) {
        // Already docked, just switching cards: the column layout hasn't changed, so restore
        // the exact scroll position rather than recomputing one — the newly selected card was
        // already on screen when it was clicked, so there's nothing to scroll into view.
        grid.scrollTop = this.dockedScrollTop;
      } else {
        // Just became docked (coming from the full, wider grid): the column layout changed, so
        // scroll the newly selected card into view since we don't know where it landed.
        grid.querySelector(".skillspace-card.is-selected")?.scrollIntoView({ block: "nearest" });
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
      const rail = body.createDiv({ cls: `skillspace-detail${animation ? ` skillspace-panel-enter-${animation}` : ""}` });
      this.renderDetailRail(rail, this.selectedItem);
    }

    // Re-filtering on each keystroke only needs the item grid redrawn, not the whole view —
    // but only while the grid is actually the visible side of the panel.
    searchInput.addEventListener("input", () => {
      this.search = searchInput.value;
      updateClearBtn();
      header.querySelector(".skillspace-count-pill")?.setText(String(this.filteredItems().length));
      if (itemsEl) this.renderItems(itemsEl, this.filteredItems());
    });

    clearBtn.addEventListener("click", () => {
      searchInput.value = "";
      this.search = "";
      updateClearBtn();
      header.querySelector(".skillspace-count-pill")?.setText(String(this.filteredItems().length));
      if (itemsEl) this.renderItems(itemsEl, this.filteredItems());
      searchInput.focus();
    });
  }

  private renderSegment(container: HTMLElement, label: string, active: boolean, onClick: () => void) {
    const btn = container.createEl("button", { text: label, cls: "skillspace-segment" });
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

    const header = content.createDiv({ cls: "skillspace-content-header" });
    const titleRow = header.createDiv({ cls: "skillspace-title-row" });
    titleRow.createEl("h2", { text: "Discover", cls: "skillspace-title" });
    const countPill = titleRow.createSpan({
      text: String(this.filteredDiscoverEntries().length),
      cls: "skillspace-count-pill",
    });
    header.createDiv({
      text: "Skills, agents, commands, and rules found in GitHub repos you've pointed at — browse the real content, install whenever.",
      cls: "skillspace-subtitle",
    });

    const toolbar = content.createDiv({ cls: "skillspace-toolbar" });

    const searchWrap = toolbar.createDiv({ cls: "skillspace-search-wrap" });
    const searchIcon = searchWrap.createSpan({ cls: "skillspace-search-icon" });
    setIcon(searchIcon, "search");
    const searchInput = searchWrap.createEl("input", {
      type: "text",
      placeholder: "Search discovered skills…",
      cls: "skillspace-search",
    });
    searchInput.value = this.discoverSearch;
    const clearBtn = searchWrap.createEl("button", {
      cls: "skillspace-icon-btn skillspace-search-clear",
      attr: { "aria-label": "Clear search" },
    });
    setIcon(clearBtn, "x");
    const updateClearBtn = () => clearBtn.toggle(searchInput.value.length > 0);
    updateClearBtn();

    this.renderDiscoverSortButton(toolbar);
    this.renderDiscoverRefreshAllButton(toolbar);

    const addBtn = toolbar.createEl("button", { cls: "mod-cta", text: "+ Add source" });
    addBtn.addEventListener("click", () => this.openAddDiscoverSource());

    if (totalCount > 0) this.renderDiscoverTypeFilterBar(content.createDiv({ cls: "skillspace-tagbar" }));

    const body = content.createDiv({ cls: "skillspace-body" });
    const grouped = this.discoverSortOrder === "source";
    const grid = body.createDiv({
      cls: `skillspace-items${this.selectedDiscoverEntry ? " is-docked" : ""}${grouped ? " is-grouped" : ""}`,
    });

    const renderGrid = () => {
      grid.empty();
      const entries = this.filteredDiscoverEntries();
      if (entries.length === 0) {
        grid.createDiv({
          cls: "skillspace-empty",
          text: totalCount === 0 ? "Nothing here yet. Add a GitHub repo to find what's in it." : "Nothing discovered matches your search.",
        });
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
          grid.querySelector(".skillspace-card.is-selected")?.scrollIntoView({ block: "nearest" });
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
        cls: `skillspace-detail skillspace-discover-rail${animation ? ` skillspace-panel-enter-${animation}` : ""}`,
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
    const allChip = bar.createEl("button", { text: `All (${catalog.length})`, cls: "skillspace-chip" });
    if (!this.discoverTypeFilter) allChip.addClass("is-active");
    allChip.addEventListener("click", () => {
      this.discoverTypeFilter = null;
      this.render();
    });
    for (const type of Object.keys(TYPE_LABELS) as ItemType[]) {
      const count = catalog.filter((e) => e.type === type).length;
      if (count === 0) continue;
      const chip = bar.createEl("button", { text: `${TYPE_LABELS[type]} (${count})`, cls: "skillspace-chip" });
      if (this.discoverTypeFilter === type) chip.addClass("is-active");
      chip.addEventListener("click", () => {
        this.discoverTypeFilter = this.discoverTypeFilter === type ? null : type;
        this.render();
      });
    }
  }

  private renderDiscoverSortButton(toolbar: HTMLElement) {
    const current = DISCOVER_SORT_OPTIONS.find((o) => o.key === this.discoverSortOrder) ?? DISCOVER_SORT_OPTIONS[0];
    const btn = toolbar.createEl("button", { cls: "skillspace-sort-btn", attr: { "aria-label": "Sort by" } });
    const icon = btn.createSpan({ cls: "skillspace-sort-btn-icon" });
    setIcon(icon, "arrow-up-down");
    btn.createSpan({ text: current.label, cls: "skillspace-sort-btn-label" });
    const chevron = btn.createSpan({ cls: "skillspace-sort-btn-chevron" });
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
      cls: "skillspace-sort-btn skillspace-discover-refresh-all-btn",
      attr: { "aria-label": "Re-search every repo already in Discover for anything new or changed" },
    });
    const icon = btn.createSpan({ cls: "skillspace-sort-btn-icon" });
    setIcon(icon, "refresh-cw");
    btn.createSpan({ text: "Refresh all", cls: "skillspace-sort-btn-label" });
    if (this.refreshingAllDiscover) {
      btn.disabled = true;
      btn.addClass("is-syncing");
    }
    btn.addEventListener("click", () => void this.refreshAllDiscoverSources());
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
      new Notice("Nothing to refresh yet — add a source first.");
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
        ? `Refreshed ${sources.size} source${sources.size === 1 ? "" : "s"} — ${itemsFound} item${itemsFound === 1 ? "" : "s"} found.`
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
      const key = `${entry.repoUrl}#${entry.ref}`;
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
    const section = container.createDiv({ cls: "skillspace-discover-source-group" });
    const header = section.createDiv({ cls: "skillspace-discover-source-group-header" });

    const parsed = parseOwnerRepo(group.repoUrl);
    const label = parsed ? `${parsed.owner}/${parsed.repo}` : group.repoUrl;
    const repoLine = header.createDiv({ cls: "skillspace-card-discover-repo" });
    if (parsed) {
      repoLine.createEl("img", { attr: { src: `https://github.com/${parsed.owner}.png?size=32` } });
    }
    repoLine.createSpan({ text: label, cls: "skillspace-card-discover-repo-name" });
    header.createSpan({ text: String(group.entries.length), cls: "skillspace-count-pill" });

    const removeBtn = header.createEl("button", {
      cls: "skillspace-icon-btn",
      attr: { "aria-label": `Remove all ${group.entries.length} items from ${label}` },
    });
    setIcon(removeBtn, "trash-2");
    removeBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.confirmRemoveDiscoverSource(group.repoUrl, group.ref, group.entries.length, label);
    });

    // The header stays pinned at the top of the scroll area for as long as any of this
    // section's cards are still in view (see .skillspace-discover-source-group-header's
    // position: sticky) — clicking it while stuck jumps back to this section's own top,
    // rather than scrolling to wherever the sticky header's own box currently reports (which,
    // being sticky, is always "already at the top" and wouldn't move anything).
    header.addEventListener("click", () => {
      const scrollContainer = section.closest<HTMLElement>(".skillspace-items");
      if (!scrollContainer) return;
      // getBoundingClientRect rather than offsetTop — offsetTop is relative to whichever
      // ancestor happens to be positioned, not necessarily the scroll container itself.
      const delta = section.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top;
      scrollContainer.scrollTo({ top: scrollContainer.scrollTop + delta, behavior: "smooth" });
    });

    const grid = section.createDiv({ cls: "skillspace-discover-source-group-grid" });
    for (const entry of group.entries) this.renderDiscoverCard(grid, entry);
  }

  /** Bulk removal is still just dropping our own cached rows (nothing on disk to touch, same as
   *  a single Remove) — but at the scale a whole source can reach (dozens of entries in one
   *  click), a lightweight confirm earns its keep in a way it doesn't for one card. */
  private confirmRemoveDiscoverSource(repoUrl: string, ref: string, count: number, label: string) {
    new ConfirmModal(
      this.app,
      `Remove all from ${label}?`,
      `This removes ${count} discovered item${count === 1 ? "" : "s"} from "${label}" out of Discover and stops tracking it — "Refresh all" won't search it again until you add it back. Nothing on disk is affected — none of these are installed.`,
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
    const card = container.createDiv({ cls: "skillspace-card skillspace-card-discover" });
    if (this.selectedDiscoverEntry?.id === entry.id) card.addClass("is-selected");

    const head = card.createDiv({ cls: "skillspace-card-head" });
    head.createSpan({ text: entry.name, cls: "skillspace-card-name" });

    const actions = head.createDiv({ cls: "skillspace-card-discover-actions" });
    const linkBtn = actions.createEl("button", { cls: "skillspace-icon-btn", attr: { "aria-label": "Open on GitHub" } });
    setIcon(linkBtn, "external-link");
    linkBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      window.open(this.discoverEntryUrl(entry), "_blank");
    });
    const installBtn = actions.createEl("button", {
      cls: "skillspace-icon-btn skillspace-install-btn",
      attr: { "aria-label": "Install" },
    });
    setIcon(installBtn, "plus");
    installBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.installDiscoverEntry(entry);
    });

    if (entry.description) {
      card.createDiv({ text: entry.description, cls: "skillspace-card-desc" });
    }
    if (entry.tags.length > 0) {
      const tags = card.createDiv({ cls: "skillspace-card-tags" });
      for (const tag of entry.tags) {
        tags.createSpan({ text: tag, cls: `skillspace-chip skillspace-tag-c${tagColorIndex(tag)}` });
      }
    }

    const footer = card.createDiv({ cls: "skillspace-card-footer" });
    this.renderDiscoverRepoLine(footer, entry);

    const rightGroup = footer.createDiv({ cls: "skillspace-card-footer-right" });
    rightGroup.createSpan({ text: TYPE_LABEL_SINGULAR[entry.type], cls: "skillspace-card-type" });
    const menuBtn = rightGroup.createEl("button", { cls: "skillspace-icon-btn", attr: { "aria-label": "More actions" } });
    setIcon(menuBtn, "more-vertical");
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
    const repo = container.createDiv({ cls: "skillspace-card-discover-repo" });
    const parsed = parseOwnerRepo(entry.repoUrl);
    if (parsed) {
      repo.createEl("img", { attr: { src: `https://github.com/${parsed.owner}.png?size=32` } });
      repo.createSpan({ text: `${parsed.owner}/${parsed.repo}`, cls: "skillspace-card-discover-repo-name" });
    } else {
      repo.createSpan({ text: entry.repoUrl, cls: "skillspace-card-discover-repo-name" });
    }
    if (entry.starCount !== null) {
      const stars = repo.createDiv({ cls: "skillspace-card-discover-stars" });
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
    const crumbs = panel.createDiv({ cls: "skillspace-crumbs" });
    const backBtn = crumbs.createEl("button", { cls: "skillspace-icon-btn", attr: { "aria-label": "Back" } });
    setIcon(backBtn, "arrow-left");
    const back = () => {
      this.selectedDiscoverEntry = null;
      this.pendingDetailAnimation = "back";
      this.render();
    };
    backBtn.addEventListener("click", back);
    const discoverCrumb = crumbs.createEl("button", { cls: "skillspace-crumb", text: "Discover" });
    discoverCrumb.addEventListener("click", back);
    crumbs.createSpan({ cls: "skillspace-crumb-sep", text: "/" });
    crumbs.createEl("button", { cls: "skillspace-crumb is-current", text: entry.name });

    const header = panel.createDiv({ cls: "skillspace-detail-header" });
    header.createEl("h3", { text: entry.name, cls: "skillspace-detail-title" });
    header.createSpan({ text: TYPE_LABEL_SINGULAR[entry.type], cls: "skillspace-card-type" });
    header.createSpan({ text: "Not installed", cls: "skillspace-detail-tool-pill skillspace-discover-pill" });
    const actions = header.createDiv({ cls: "skillspace-detail-actions" });
    const linkBtn = actions.createEl("button", { cls: "skillspace-icon-btn", attr: { "aria-label": "Open on GitHub" } });
    setIcon(linkBtn, "external-link");
    linkBtn.addEventListener("click", () => window.open(this.discoverEntryUrl(entry), "_blank"));
    const installBtn = actions.createEl("button", { cls: "skillspace-icon-btn skillspace-install-btn", attr: { "aria-label": "Install" } });
    setIcon(installBtn, "plus");
    installBtn.addEventListener("click", () => this.installDiscoverEntry(entry));

    this.renderDiscoverRepoLine(panel, entry);
    if (entry.subpath) {
      panel.createDiv({ cls: "skillspace-detail-path", text: entry.subpath });
    }
    if (entry.tags.length > 0) {
      const tags = panel.createDiv({ cls: "skillspace-card-tags skillspace-discover-rail-tags" });
      for (const tag of entry.tags) {
        tags.createSpan({ text: tag, cls: `skillspace-chip skillspace-tag-c${tagColorIndex(tag)}` });
      }
    }

    const body = panel.createDiv({ cls: "skillspace-detail-body" });
    const readingView = body.createDiv({
      cls: "markdown-preview-view markdown-rendered node-insert-event is-readable-line-width allow-fold-headings allow-fold-lists show-indentation-guide skillspace-markdown-preview",
    });
    const sizer = readingView.createDiv({ cls: "markdown-preview-sizer markdown-preview-section" });
    void MarkdownRenderer.render(this.app, stripFrontmatter(entry.manifestText), sizer, entry.name, this.markdownComponent);
  }

  private renderTagBar(tagbar: HTMLElement) {
    const allTags = Array.from(new Set(this.items.flatMap((item) => item.tags))).sort((a, b) => a.localeCompare(b));

    // Toggling the active chip back off works, but it's not a visible affordance — this is the
    // dedicated "clear" chip so getting out of a tag filter doesn't mean hunting for whichever
    // chip is currently selected.
    const allChip = tagbar.createEl("button", { text: "All", cls: "skillspace-chip" });
    if (!this.tagFilter && !this.untaggedOnly) allChip.addClass("is-active");
    allChip.addEventListener("click", () => {
      this.tagFilter = null;
      this.untaggedOnly = false;
      this.render();
    });

    const untagged = tagbar.createEl("button", { text: "Untagged", cls: "skillspace-chip skillspace-chip-untagged" });
    if (this.untaggedOnly) untagged.addClass("is-active");
    untagged.addEventListener("click", () => {
      this.untaggedOnly = !this.untaggedOnly;
      if (this.untaggedOnly) this.tagFilter = null;
      this.render();
    });

    for (const tag of allTags) {
      const chip = tagbar.createEl("button", { text: tag, cls: `skillspace-chip skillspace-tag-c${tagColorIndex(tag)}` });
      if (this.tagFilter === tag) chip.addClass("is-active");
      chip.addEventListener("click", () => {
        this.tagFilter = this.tagFilter === tag ? null : tag;
        this.untaggedOnly = false;
        this.render();
      });
    }

    this.renderSortButton(tagbar);
  }

  private renderSortButton(tagbar: HTMLElement) {
    const current = SORT_OPTIONS.find((o) => o.key === this.sortOrder) ?? SORT_OPTIONS[0];
    const btn = tagbar.createEl("button", { cls: "skillspace-sort-btn", attr: { "aria-label": "Sort by" } });
    const icon = btn.createSpan({ cls: "skillspace-sort-btn-icon" });
    setIcon(icon, "arrow-up-down");
    btn.createSpan({ text: current.label, cls: "skillspace-sort-btn-label" });
    const chevron = btn.createSpan({ cls: "skillspace-sort-btn-chevron" });
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
   *  visible in the current scope, so linking a skill into 3 projects reads as one card with
   *  3 project chips instead of 4 near-identical cards. Only applies outside a project filter —
   *  filtered to one Project Workspace, every row is a distinct physical file/symlink and stays
   *  its own card. A project instance whose global sibling isn't in view (search/type/tool
   *  filtered it out, or it's genuinely project-native with no global counterpart) falls back to
   *  its own standalone card rather than silently disappearing. */
  private groupedRows(items: ItemMetadata[]): { item: ItemMetadata; projectIds: string[] }[] {
    if (this.projectFilter) return items.map((item) => ({ item, projectIds: [] }));

    const rows: { item: ItemMetadata; projectIds: string[] }[] = [];
    for (const item of items) {
      if (item.projectId !== null) {
        const hasVisibleGlobalSibling = items.some((i) => i.projectId === null && i.realPath === item.realPath);
        if (hasVisibleGlobalSibling) continue;
        rows.push({ item, projectIds: [] });
        continue;
      }
      const projectIds = Array.from(
        new Set(this.items.filter((i) => i.projectId && i.realPath === item.realPath).map((i) => i.projectId as string))
      );
      rows.push({ item, projectIds });
    }
    return rows;
  }

  private renderItems(container: HTMLElement, items: ItemMetadata[]) {
    container.empty();

    if (items.length === 0) {
      container.createDiv({
        cls: "skillspace-empty",
        text: "Nothing here yet. Rescan tools, or check the paths in plugin settings.",
      });
      return;
    }

    for (const row of this.groupedRows(items)) {
      this.renderCard(container, row.item, row.projectIds);
    }
  }

  private renderCard(container: HTMLElement, item: ItemMetadata, projectIds: string[] = []) {
    const card = container.createDiv({ cls: "skillspace-card" });
    if (!item.enabled) card.addClass("is-off");
    if (this.selectedItem?.entryId === item.entryId) card.addClass("is-selected");

    const head = card.createDiv({ cls: "skillspace-card-head" });
    head.createSpan({ cls: `skillspace-dot${item.enabled ? " is-on" : ""}` });
    head.createSpan({ text: item.name, cls: "skillspace-card-name" });

    // realPath !== sourcePath is exactly what fs.realpathSync resolving through a symlink looks
    // like (same check the detail pane already uses for "→ symlinked from ..."), so it doubles
    // as "is this actually a symlink." Surfaced in the footer, next to the type pill — same slot
    // as the link icon for a Linked card, so both states read from the same place on the card.
    const isLinked = item.projectId !== null && item.realPath !== item.sourcePath;

    if (item.sourceRepo) {
      const syncBtn = head.createEl("button", {
        cls: "skillspace-icon-btn skillspace-card-sync-btn",
        attr: { "aria-label": "Check for updates" },
      });
      setIcon(syncBtn, "refresh-cw");
      syncBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        void this.quickCheckForUpdate(item, syncBtn);
      });
    }

    const toggle = head.createEl("button", {
      cls: `skillspace-toggle${item.enabled ? " is-on" : ""}`,
      attr: { "aria-label": item.enabled ? "Disable" : "Enable" },
    });
    toggle.addEventListener("click", (evt) => {
      evt.stopPropagation();
      void this.toggleEnabled(item);
    });

    if (item.description) {
      card.createDiv({ text: item.description, cls: "skillspace-card-desc" });
    }

    if (item.tags.length > 0) {
      const tags = card.createDiv({ cls: "skillspace-card-tags" });
      for (const tag of item.tags) {
        tags.createSpan({ text: tag, cls: `skillspace-chip skillspace-tag-c${tagColorIndex(tag)}` });
      }
    }

    if (projectIds.length > 0) {
      const allProjects = this.getAllProjects();
      const projects = card.createDiv({ cls: "skillspace-card-projects" });
      for (const projectId of projectIds) {
        const project = allProjects.find((p) => p.id === projectId);
        projects.createSpan({ text: project?.name ?? "Project", cls: "skillspace-chip" });
      }
    }

    const footer = card.createDiv({ cls: "skillspace-card-footer" });
    const sourceLabel = this.sourceLabel(item);
    const source = footer.createDiv({ cls: "skillspace-card-source" });
    const sourceIcon = source.createSpan({ cls: "skillspace-card-source-icon" });
    this.renderIcon(sourceIcon, sourceLabel.icon, sourceLabel.svgIcon);
    source.createSpan({ text: sourceLabel.text, cls: "skillspace-card-source-text" });

    const rightGroup = footer.createDiv({ cls: "skillspace-card-footer-right" });
    if (item.projectId === null) {
      this.renderProjectLinkButton(rightGroup, item);
    } else if (isLinked) {
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
          cls: "skillspace-icon-btn skillspace-card-link-btn",
          attr: { "aria-label": "Linked, but its library source can't be found — click to unlink from this project" },
        });
        setIcon(unlinkBtn, "link");
        unlinkBtn.addEventListener("mouseenter", () => setIcon(unlinkBtn, "unlink"));
        unlinkBtn.addEventListener("mouseleave", () => setIcon(unlinkBtn, "link"));
        unlinkBtn.addEventListener("click", (evt) => {
          evt.stopPropagation();
          void this.unlinkFromProject(item);
        });
      }
    }
    if (item.projectId !== null && !isLinked) {
      const badge = rightGroup.createSpan({
        cls: "skillspace-card-badge skillspace-card-badge-local",
        attr: { "aria-label": "A real file in this project, not linked from your library — nothing here to unlink." },
      });
      setIcon(badge, "file");
      badge.createSpan({ text: "Local" });
    }
    if (item.favorite) {
      const star = rightGroup.createSpan({ cls: "skillspace-card-star" });
      setIcon(star, "star");
    }
    rightGroup.createSpan({ text: TYPE_LABEL_SINGULAR[item.type], cls: "skillspace-card-type" });

    const menuBtn = rightGroup.createEl("button", { cls: "skillspace-icon-btn", attr: { "aria-label": "More actions" } });
    setIcon(menuBtn, "more-vertical");
    menuBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      this.openCardMenu(evt, item, isLinked);
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
        new Notice(`"${item.name}" is up to date.`);
        btn.disabled = false;
        btn.removeClass("is-syncing");
      } else {
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

  private openCardMenu(evt: MouseEvent, item: ItemMetadata, isLinked: boolean) {
    const menu = new Menu();
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
    menu.addSeparator();
    menu.addItem((menuItem) =>
      menuItem
        .setTitle(isLinked ? "Unlink from project" : "Delete")
        .setIcon(isLinked ? "unlink" : "trash-2")
        .setWarning(true)
        .onClick(() => this.confirmDelete(item, isLinked))
    );
    menu.showAtMouseEvent(evt);
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

  private confirmDelete(item: ItemMetadata, isLinked: boolean) {
    const unitPath = linkableUnit(item.sourcePath).path;
    new ConfirmModal(
      this.app,
      isLinked ? "Unlink from project?" : `Delete "${item.name}"?`,
      isLinked
        ? `This removes the project's symlink to "${item.name}". The skill itself stays in your library.`
        : `This permanently deletes "${item.name}" from disk at ${unitPath}. This can't be undone from Obsidian.`,
      isLinked ? "Unlink" : "Delete",
      async () => {
        try {
          deleteItem(item);
          await this.rescan();
        } catch (e) {
          new Notice(`Couldn't delete "${item.name}": ` + errorMessage(e));
        }
      }
    ).open();
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

  private selectItem(item: ItemMetadata) {
    const hasTree = !!this.treeForItem(item);
    this.cleanupReview();
    this.selectedItem = item;
    this.detailEditing = false;
    this.addingTagFor = null;
    this.moreFieldsExpanded = false;
    this.collapsedTreeFolders = new Set();
    this.selectedFilePath = hasTree ? null : item.sourcePath;
    this.pendingDetailAnimation = "forward";
    this.render();
  }

  private selectFile(filePath: string) {
    this.cleanupReview();
    this.selectedFilePath = filePath;
    this.detailEditing = false;
    this.addingTagFor = null;
    this.moreFieldsExpanded = false;
    this.pendingDetailAnimation = "forward";
    this.render();
  }

  private backToLibrary() {
    this.cleanupReview();
    this.selectedItem = null;
    this.selectedFilePath = null;
    this.detailLoadedFor = null;
    this.addingTagFor = null;
    this.moreFieldsExpanded = false;
    this.pendingDetailAnimation = "back";
    this.render();
  }

  private backToTree() {
    this.cleanupReview();
    this.selectedFilePath = null;
    this.detailLoadedFor = null;
    this.addingTagFor = null;
    this.moreFieldsExpanded = false;
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
    this.renderIdentityBand(panel, item, filePath);

    if (this.review && this.review.entryId === item.entryId) {
      this.renderDiffReview(panel);
    } else if (tree && !this.selectedFilePath) {
      const list = panel.createDiv({ cls: "skillspace-tree" });
      this.renderTreeNodes(list, tree, 0);
      panel.createDiv({ cls: "skillspace-tree-hint", text: "Click a file to open it." });
    } else if (filePath) {
      this.renderFileBody(panel, item, filePath);
    }
  }

  /** A plain, unstyled trail — no button chrome, just text — plus a leading back icon that
   *  always steps up exactly one level (list/single file -> library, a tree's open file -> its
   *  list). "Library" itself is always clickable, the one jump that costs the same regardless of
   *  depth; the skill segment only becomes clickable once a file from its tree is open. */
  private renderBreadcrumbs(panel: HTMLElement, item: ItemMetadata, tree: TreeNode[] | null) {
    const row = panel.createDiv({ cls: "skillspace-crumbs" });
    const fileOpenFromTree = !!tree && !!this.selectedFilePath;
    const stepBack = () => (fileOpenFromTree ? this.backToTree() : this.backToLibrary());

    const backBtn = row.createEl("button", { cls: "skillspace-icon-btn", attr: { "aria-label": "Back" } });
    setIcon(backBtn, "arrow-left");
    backBtn.addEventListener("click", stepBack);

    const crumb = (label: string, current: boolean, onClick?: () => void) => {
      const btn = row.createEl("button", { cls: `skillspace-crumb${current ? " is-current" : ""}`, text: label });
      if (onClick) btn.addEventListener("click", onClick);
      return btn;
    };
    const sep = () => row.createSpan({ cls: "skillspace-crumb-sep", text: "/" });

    crumb("Library", false, () => this.backToLibrary());
    sep();
    crumb(item.name, !fileOpenFromTree, fileOpenFromTree ? () => this.backToTree() : undefined);

    if (fileOpenFromTree && this.selectedFilePath) {
      sep();
      crumb(basename(this.selectedFilePath), true);
    }
  }

  /** Title + tool pill + edit action, then a two-column strip: tags/description/path/extra
   *  frontmatter on the left (only meaningful once a file is open, and tags/description/
   *  frontmatter only for the manifest — they're the skill's own metadata, not a sibling file's),
   *  file stats + source status on the right. Source status is the one thing in the right column
   *  that doesn't need a file open — it describes the item, not a specific file — so it's still
   *  visible while just browsing a multi-file skill's tree. Favourite/add-to-collection/
   *  project-link all live on the card now (see renderCard/openCardMenu) — Edit is the only
   *  action left here, since it's file-scoped rather than skill-scoped and stays available for
   *  any file in the tree, not just the manifest. */
  private renderIdentityBand(panel: HTMLElement, item: ItemMetadata, filePath: string | null) {
    const isManifest = !!filePath && filePath === item.sourcePath;
    const isReviewing = this.review !== null && this.review.entryId === item.entryId;

    const header = panel.createDiv({ cls: "skillspace-detail-header" });
    header.createEl("h3", {
      text: isReviewing
        ? `${this.review?.mode === "restore" ? "Restore" : "Update"} "${item.name}"`
        : filePath && !isManifest
          ? basename(filePath)
          : item.name,
      cls: "skillspace-detail-title",
    });
    header.createSpan({ text: this.sourceLabel(item).text, cls: "skillspace-detail-tool-pill" });
    if (filePath && !isReviewing) {
      const actions = header.createDiv({ cls: "skillspace-detail-actions" });
      this.renderDetailActions(actions);
    }

    // A review replaces the file view with a diff (see renderDiffReview) — the file-scoped stuff
    // below (tags, description, path, extra frontmatter, stats) would either duplicate or fight
    // with that diff, so it's suppressed for as long as the review is open.
    if (filePath && !isReviewing) {
      // The two-column band only makes sense once there's something to put in both columns — a
      // file's own stats on the right, paired with its tags/description/path on the left. With
      // nothing open (just browsing a tree, or mid-review), source status renders as its own
      // full-width row below instead (see the else-if branch) rather than floating a divider and
      // a right column over an empty left one.
      const fields = isManifest ? parseFrontmatter(this.detailContent).filter((f) => f.value) : [];

      const band = panel.createDiv({ cls: "skillspace-detail-band" });
      const left = band.createDiv({ cls: "skillspace-detail-band-left" });

      if (isManifest) this.renderTagChips(left, item);

      // The raw frontmatter is already editable via the textarea below in edit mode, so the
      // parsed description/extra-fields views are suppressed while editing to avoid showing two
      // versions of the same thing at once — tags aren't part of that textarea, so they stay.
      if (!this.detailEditing) {
        const description = fields.find((f) => f.key === "description");
        if (description) left.createDiv({ cls: "skillspace-detail-desc", text: description.value });
      }

      const pathBlock = left.createDiv({ cls: "skillspace-detail-path", attr: { title: filePath } });
      pathBlock.createDiv({ text: filePath });
      if (isManifest && item.realPath !== item.sourcePath) {
        pathBlock.createDiv({ text: `→ symlinked from ${item.realPath}`, cls: "skillspace-detail-path-target" });
      }

      if (!this.detailEditing) {
        const moreFields = fields.filter((f) => f.key !== "description");
        if (moreFields.length > 0) this.renderMoreFields(left, moreFields);
      }

      const right = band.createDiv({ cls: "skillspace-detail-band-right" });
      this.renderFileStats(right, item, filePath);
      if (item.sourceRepo) this.renderSourceStatus(right, item);
    } else if (item.sourceRepo) {
      this.renderSourceStatusInline(panel, item);
    }
  }

  private renderDetailActions(actions: HTMLElement) {
    const editBtn = actions.createEl("button", {
      cls: "skillspace-icon-btn",
      attr: { "aria-label": this.detailEditing ? "Preview" : "Edit" },
    });
    setIcon(editBtn, this.detailEditing ? "eye" : "pencil");
    editBtn.addEventListener("click", () => {
      this.detailEditing = !this.detailEditing;
      this.render();
    });
  }

  private renderFileStats(container: HTMLElement, item: ItemMetadata, filePath: string) {
    let fileSize = 0;
    let modified = Date.now();
    try {
      const stat = statSync(filePath);
      fileSize = stat.size;
      modified = stat.mtimeMs;
    } catch {
      // file may have moved since the last scan; stats just show defaults
    }
    const stats = container.createDiv({ cls: "skillspace-detail-stats" });
    const row = (label: string, value: string) => {
      const r = stats.createDiv({ cls: "skillspace-detail-stat-row" });
      r.createSpan({ text: label, cls: "skillspace-detail-stat-label" });
      r.createSpan({ text: value, cls: "skillspace-detail-stat-value" });
    };
    row("Size", formatBytes(fileSize));
    row("Length", `${this.detailContent.length.toLocaleString()} chars`);
    row("Tokens", formatTokens(this.detailContent.length));
    row("Modified", formatDate(modified));
    row("Type", TYPE_LABEL_SINGULAR[item.type]);
  }

  /** Only shown for an item installed through the "Install from GitHub" flow (see
   *  InstallFromGitHubModal) — a manually-placed skill has no sourceRepo and gets no update
   *  tracking. The check itself is on-demand only (a network call), never run automatically
   *  during a rescan — see the versioning plan's "manual update checks" decision. The repo URL
   *  truncates (full URL is the aria-label/title) since the right column is narrow. */
  private renderSourceStatus(container: HTMLElement, item: ItemMetadata) {
    const section = container.createDiv({ cls: "skillspace-detail-source" });
    this.renderSourceRepoLine(section, item);
    this.renderSourceButtons(section.createDiv({ cls: "skillspace-detail-source-actions" }), item);
  }

  /** Same repo status as renderSourceStatus, but as one full-width row instead of a stacked
   *  right-column card — used whenever there's no open file to pair it with in a two-column band
   *  (browsing a multi-file skill's tree, or an active review), where the band would otherwise
   *  float a divider and a right column over an empty left one. */
  private renderSourceStatusInline(panel: HTMLElement, item: ItemMetadata) {
    const row = panel.createDiv({ cls: "skillspace-detail-source-inline" });
    this.renderSourceRepoLine(row, item);
    this.renderSourceButtons(row.createDiv({ cls: "skillspace-detail-source-actions" }), item);
  }

  /** Repo avatar + a link straight to the exact tracked folder/file on GitHub — same avatar
   *  convention (github.com/{owner}.png) and same URL-building (githubSourceUrl) a Discover
   *  card's repo line uses, so an installed item and a not-yet-installed one show provenance the
   *  same way. Doesn't touch the tool pill (Claude Code · Global) up in the header — that answers
   *  "which tool sees this," which has nothing to do with where it came from, and every installed
   *  item has one regardless of whether it happens to also have a sourceRepo. */
  private renderSourceRepoLine(container: HTMLElement, item: ItemMetadata) {
    const repoUrl = item.sourceRepo as string;
    // Keeps the existing skillspace-detail-source-repo class (and everything the surrounding
    // .skillspace-detail-source/-inline layouts already key off it for) — just turns its single
    // text node into a small flex row with an avatar in front and a link instead of plain text.
    const row = container.createDiv({ cls: "skillspace-detail-source-repo" });
    const parsed = parseOwnerRepo(repoUrl);
    if (parsed) {
      row.createEl("img", { cls: "skillspace-detail-source-avatar", attr: { src: `https://github.com/${parsed.owner}.png?size=32` } });
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
    const checkBtn = actions.createEl("button", { cls: "skillspace-detail-source-btn" });
    this.setSourceBtnContent(checkBtn, "refresh-cw", "Check for updates");
    checkBtn.addEventListener("click", () => void this.checkForUpdate(item, checkBtn));

    // No ls-remote check needed first — the restore target is already known (whatever commit
    // was recorded at install/last-update time), unlike "Check for updates" which has to ask
    // the remote what's changed.
    const restoreBtn = actions.createEl("button", { cls: "skillspace-detail-source-btn" });
    this.setSourceBtnContent(restoreBtn, "history", "Restore installed");
    restoreBtn.addEventListener("click", () => void this.startReview(item, "restore"));
  }

  /** Rebuilds a source button's icon + label together — setText()/setIcon() alone would each
   *  wipe out the other's content, since both replace the whole element. */
  private setSourceBtnContent(btn: HTMLButtonElement, icon: string, text: string) {
    btn.empty();
    setIcon(btn.createSpan({ cls: "skillspace-detail-source-btn-icon" }), icon);
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
        new Notice(`"${item.name}" is up to date.`);
        checkBtn.disabled = false;
        checkBtn.removeClass("is-syncing");
        this.setSourceBtnContent(checkBtn, "refresh-cw", "Check for updates");
        return;
      }
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

  private renderDiffReview(panel: HTMLElement) {
    const review = this.review;
    if (!review) return;
    const verb = review.mode === "restore" ? "Restore" : "Update";

    if (review.status === "loading") {
      panel.createDiv({
        cls: "skillspace-modal-meta",
        text: review.mode === "restore" ? "Fetching the installed version…" : "Fetching upstream changes…",
      });
      return;
    }

    if (review.status === "error") {
      panel.createDiv({
        cls: "skillspace-modal-meta",
        text: `Couldn't fetch ${review.mode === "restore" ? "the installed version" : "the update"}: ${review.message}`,
      });
      const dismissBtn = panel.createEl("button", { text: "Dismiss" });
      dismissBtn.addEventListener("click", () => {
        this.review = null;
        this.render();
      });
      return;
    }

    renderDiffBody(panel.createDiv(), review.oldText, review.newText);

    if (review.companions.length > 0) {
      const list = panel.createDiv({ cls: "skillspace-diff-companion-list" });
      list.createDiv({ cls: "skillspace-modal-meta", text: "Other files in this skill that also changed:" });
      for (const row of review.companions) {
        const rowEl = list.createDiv({ cls: "skillspace-diff-companion-row" });
        rowEl.createSpan({ cls: `skillspace-diff-companion-badge is-${row.status}`, text: row.status });
        rowEl.createSpan({ text: row.file });
      }
    }

    const actions = panel.createDiv({ cls: "skillspace-modal-actions skillspace-diff-review-actions" });
    actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
      this.cleanupReview();
      this.render();
    });
    actions.createEl("button", { text: verb, cls: "mod-cta" }).addEventListener("click", () => void this.applyReview());
  }

  private async applyReview() {
    if (this.review?.status !== "ready") return;
    const { mode, unitPath, isDirectory, newRoot, newCommit, entryId, clone } = this.review;
    try {
      if (isDirectory) {
        rmSync(unitPath, { recursive: true, force: true });
        cpSync(newRoot, unitPath, { recursive: true });
      } else {
        cpSync(newRoot, unitPath);
      }
      await this.store.update(entryId, { sourceCommit: newCommit });
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

  private renderTreeNodes(container: HTMLElement, nodes: TreeNode[], depth: number) {
    for (const node of nodes) {
      const collapsed = node.isDir && this.collapsedTreeFolders.has(node.relPath);
      const isActiveFile = !node.isDir && node.absPath === this.selectedFilePath;
      const row = container.createDiv({
        cls: `skillspace-tree-item${node.isDir ? " is-dir" : ""}${isActiveFile ? " is-active" : ""}`,
      });
      row.style.setProperty("--skillspace-tree-depth", String(depth));

      const chevron = row.createSpan({ cls: "skillspace-tree-chevron" });
      if (node.isDir) setIcon(chevron, collapsed ? "chevron-right" : "chevron-down");

      const icon = row.createSpan({ cls: "skillspace-tree-icon" });
      setIcon(icon, node.isDir ? (collapsed ? "folder" : "folder-open") : "file-text");
      row.createSpan({ text: node.name, cls: "skillspace-tree-label" });

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

  /** Reads (and caches) the open file's content — shared by renderIdentityBand (stats, parsed
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
    const body = panel.createDiv({ cls: "skillspace-detail-body" });
    if (this.detailEditing) {
      // Styled and behaved like Obsidian's own source-mode editor rather than a form field:
      // no input-box chrome, grows with its content instead of scrolling in a box, Tab indents
      // instead of leaving the field, and Cmd/Ctrl+S saves without reaching for the mouse.
      const editWrap = body.createDiv({ cls: "skillspace-edit-wrap" });
      const textarea = editWrap.createEl("textarea", {
        cls: "skillspace-edit-textarea",
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

      const saveRow = body.createDiv({ cls: "skillspace-detail-save-row" });
      const cancelBtn = saveRow.createEl("button", { text: "Cancel" });
      cancelBtn.addEventListener("click", cancel);
      const saveBtn = saveRow.createEl("button", { text: "Save", cls: "mod-cta" });
      saveBtn.addEventListener("click", save);

      window.setTimeout(() => textarea.focus(), 0);
    } else {
      // Mirrors the DOM Obsidian's own reading view builds (markdown-preview-view >
      // markdown-preview-sizer/-section) so the active theme's note styling — code fences,
      // headings, callouts, tables — applies here exactly as it would in a real note.
      const readingView = body.createDiv({
        cls: "markdown-preview-view markdown-rendered node-insert-event is-readable-line-width allow-fold-headings allow-fold-lists show-indentation-guide skillspace-markdown-preview",
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
    const row = container.createDiv({ cls: "skillspace-fm-row" });
    const label = row.createSpan({ cls: "skillspace-fm-label" });
    label.createSpan({ text: key, cls: "skillspace-fm-key" });
    label.createSpan({ text: ":", cls: "skillspace-fm-colon" });
    row.createSpan({ text: value, cls: "skillspace-fm-value" });
  }

  /** A collapsed-by-default view of every frontmatter field except description (which the band
   *  already shows as prose) — license, argument-hint, allowed-tools, whatever else a tool
   *  declares. Kept out of the way by default since most of it is rarely needed at a glance. */
  private renderMoreFields(container: HTMLElement, fields: FrontmatterField[]) {
    const toggle = container.createEl("button", {
      cls: "skillspace-fm-toggle",
      text: `${this.moreFieldsExpanded ? "▾" : "▸"} ${fields.length} more field${fields.length === 1 ? "" : "s"}`,
    });
    toggle.addEventListener("click", () => {
      this.moreFieldsExpanded = !this.moreFieldsExpanded;
      this.render();
    });
    if (this.moreFieldsExpanded) {
      const box = container.createDiv({ cls: "skillspace-detail-frontmatter" });
      for (const field of fields) this.renderFrontmatterRow(box, field.key, field.value);
    }
  }

  /** Tag chips, each with its own remove button, plus a "+ tag" affordance that swaps itself for
   *  an inline input. Shown at the top of the band (see renderIdentityBand) rather than the old
   *  comma-separated text field at the very bottom of the panel. */
  private renderTagChips(container: HTMLElement, item: ItemMetadata) {
    const row = container.createDiv({ cls: "skillspace-detail-tags-row" });

    for (const tag of item.tags) {
      const chip = row.createDiv({ cls: "skillspace-tag-chip" });
      chip.createSpan({ text: tag });
      const removeBtn = chip.createEl("button", {
        cls: "skillspace-tag-chip-remove",
        text: "×",
        attr: { "aria-label": `Remove tag "${tag}"` },
      });
      removeBtn.addEventListener("click", () => {
        void this.applyItemUpdate(item.entryId, { tags: item.tags.filter((t) => t !== tag) });
      });
    }

    if (this.addingTagFor !== item.entryId) {
      const addBtn = row.createEl("button", { cls: "skillspace-tag-add-btn", text: "+ tag" });
      addBtn.addEventListener("click", () => {
        this.addingTagFor = item.entryId;
        this.render();
      });
      return;
    }

    const input = row.createEl("input", {
      type: "text",
      cls: "skillspace-tag-add-input",
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
