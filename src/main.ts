import { addIcon, Notice, Plugin } from "obsidian";
import {
  DEFAULT_SECTION_ORDER,
  DEFAULT_SETTINGS,
  DEFAULT_TOOLS,
  MORE_HORIZONTAL_ICON_ID,
  MORE_ICON_ID,
  PLUGIN_ICON_ID,
  SkillManagerPluginSettings,
} from "./types";
import { SkillManagerSettingTab } from "./settings";
import { LIBRARY_VIEW_TYPE, LibraryView } from "./views/LibraryView";
import { performRescan, RescanResult } from "./rescan";
import { ShadowNoteStore } from "./store";
import { remoteHeadCommit } from "./git";

/** Four outlined shapes (triangle, circle, hexagon, square) in a 2x2 grid — the plugin's mark.
 *  Registered on a 100x100 viewBox, which is what `addIcon()` renders custom icons on. */
const PLUGIN_ICON_SVG = `
<polygon points="26,10 43,43 9,43" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="74" cy="26" r="18" fill="none" stroke="currentColor" stroke-width="7"/>
<polygon points="45,74 35.5,90.5 16.5,90.5 7,74 16.5,57.5 35.5,57.5" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
<rect x="57" y="57" width="34" height="34" fill="none" stroke="currentColor" stroke-width="7" stroke-linejoin="round"/>
`;

/** Three dots stacked vertically, same 100x100 viewBox convention as PLUGIN_ICON_SVG above. */
const MORE_ICON_SVG = `
<circle cx="50" cy="22" r="9" fill="currentColor"/>
<circle cx="50" cy="50" r="9" fill="currentColor"/>
<circle cx="50" cy="78" r="9" fill="currentColor"/>
`;

/** Same three dots, laid out side by side instead — card footers (skill cards, Discover cards)
 *  use this orientation; sidebar row menus (Workspaces, Collections) use MORE_ICON_SVG. */
const MORE_HORIZONTAL_ICON_SVG = `
<circle cx="22" cy="50" r="9" fill="currentColor"/>
<circle cx="50" cy="50" r="9" fill="currentColor"/>
<circle cx="78" cy="50" r="9" fill="currentColor"/>
`;

export default class SkillManagerPlugin extends Plugin {
  settings: SkillManagerPluginSettings;
  store: ShadowNoteStore;
  private autoRescanIntervalId: number | null = null;
  private autoUpdateCheckIntervalId: number | null = null;

  async onload() {
    addIcon(PLUGIN_ICON_ID, PLUGIN_ICON_SVG);
    addIcon(MORE_ICON_ID, MORE_ICON_SVG);
    addIcon(MORE_HORIZONTAL_ICON_ID, MORE_HORIZONTAL_ICON_SVG);
    await this.loadSettings();
    this.store = new ShadowNoteStore(this.app, this.settings.storageFolder);

    this.registerView(
      LIBRARY_VIEW_TYPE,
      (leaf) => new LibraryView(leaf, () => this.settings, this.store, () => this.saveSettings())
    );

    this.addRibbonIcon(PLUGIN_ICON_ID, "Open AI Skills Manager", () => {
      void this.activateLibrary();
    });

    this.addCommand({
      id: "open-library",
      name: "Open library",
      callback: () => this.activateLibrary(),
    });

    this.addSettingTab(new SkillManagerSettingTab(this.app, this));
    this.applyAutoRescanInterval();
    this.applyAutoUpdateCheckInterval();
  }

  private openLibraryViews(): LibraryView[] {
    return this.app.workspace
      .getLeavesOfType(LIBRARY_VIEW_TYPE)
      .map((leaf) => leaf.view)
      .filter((view): view is LibraryView => view instanceof LibraryView);
  }

  /** Re-renders any open library view against its already-discovered items — for a settings
   *  change that only affects display (e.g. which sidebar rows are hidden), where a full disk
   *  rescan would be wasted work. */
  refreshOpenViews() {
    for (const view of this.openLibraryViews()) view.refresh();
  }

  /** Re-scans every configured tool/project. Routes through each open library view's own
   *  `rescan()` (which updates its in-memory state and re-renders) when any are open, so the
   *  filesystem isn't scanned twice; falls back to scanning directly so the shadow-note store
   *  still stays in sync even with no view open. Shared by the manual "Scan tools" button and
   *  the auto-rescan interval below. */
  async rescanEverywhere(): Promise<RescanResult> {
    const views = this.openLibraryViews();
    if (views.length === 0) {
      return performRescan(this.app, this.settings, this.store, false);
    }
    const [first] = await Promise.all(views.map((view) => view.rescan()));
    return first;
  }

  /** Clears any previously scheduled auto-rescan and, if `autoRescanMinutes` is set, schedules a
   *  new one — called on load and whenever that setting changes, since the interval itself has
   *  to live on the plugin (a settings tab is only around while its pane is open). */
  applyAutoRescanInterval() {
    if (this.autoRescanIntervalId !== null) {
      window.clearInterval(this.autoRescanIntervalId);
      this.autoRescanIntervalId = null;
    }
    const minutes = this.settings.autoRescanMinutes;
    if (minutes > 0) {
      this.autoRescanIntervalId = this.registerInterval(
        window.setInterval(() => void this.rescanEverywhere(), minutes * 60 * 1000)
      );
    }
  }

  /** Checks every tracked sourceRepo item against its remote — routed through each open library
   *  view's `backgroundCheckForUpdates()` (which also updates that view's stale indicators) when
   *  any are open, same split as rescanEverywhere. With no view open there's no sync-status map to
   *  update, so this just reads the shadow-note store directly and surfaces a Notice if it finds
   *  anything stale. Never applies an update itself either way. */
  async checkForUpdatesEverywhere(): Promise<void> {
    const views = this.openLibraryViews();
    if (views.length > 0) {
      await Promise.all(views.map((view) => view.backgroundCheckForUpdates()));
      return;
    }
    const tracked = (await this.store.list()).filter((item) => item.sourceRepo);
    let stale = 0;
    for (const item of tracked) {
      try {
        if (remoteHeadCommit(item.sourceRepo as string, item.sourceRef || undefined) !== item.sourceCommit) stale++;
      } catch {
        // Unreachable source — skip it silently in the background; the manual button surfaces
        // per-item errors for anyone who wants to dig into why.
      }
      // Same yield backgroundCheckForUpdates uses — each iteration blocks on a network call, so
      // without this a large tracked list freezes Obsidian's whole renderer for the sum of them.
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
    if (stale > 0) new Notice(`${stale} skill${stale === 1 ? "" : "s"} ${stale === 1 ? "has" : "have"} an update available.`);
  }

  /** Same idea as applyAutoRescanInterval, for the separate "Auto check for updates" setting. */
  applyAutoUpdateCheckInterval() {
    if (this.autoUpdateCheckIntervalId !== null) {
      window.clearInterval(this.autoUpdateCheckIntervalId);
      this.autoUpdateCheckIntervalId = null;
    }
    const minutes = this.settings.autoUpdateCheckMinutes;
    if (minutes > 0) {
      this.autoUpdateCheckIntervalId = this.registerInterval(
        window.setInterval(() => void this.checkForUpdatesEverywhere(), minutes * 60 * 1000)
      );
    }
  }

  async loadSettings() {
    const loaded = (await this.loadData()) as Partial<SkillManagerPluginSettings> | null;
    // Only `paths`/`projectPaths`/`disabled` are ever user-edited (via the "All tools" page);
    // icon/name/pluginsRegistry are code-defined. Rebuilding from DEFAULT_TOOLS each load means
    // adding or changing one of those later reaches existing users instead of being silently
    // overwritten by a stale persisted copy of the old shape — which is exactly what happened
    // before this fix (and would happen again for projectPaths if it weren't carried over too).
    const mergedTools = DEFAULT_TOOLS.map((defaultTool) => {
      const saved = loaded?.tools?.find((t) => t.id === defaultTool.id);
      if (!saved) return defaultTool;
      return {
        ...defaultTool,
        paths: saved.paths,
        projectPaths: saved.projectPaths ?? defaultTool.projectPaths,
        disabled: saved.disabled,
        // Same "user-edited, carry over" treatment as paths/projectPaths above — these are the
        // fields the "All tools" detail rail's MCP servers section lets a user fill in for a
        // built-in tool with no confirmed default (see LibraryView.renderToolDetailRail).
        mcpConfigPath: saved.mcpConfigPath ?? defaultTool.mcpConfigPath,
        projectMcpConfigPath: saved.projectMcpConfigPath ?? defaultTool.projectMcpConfigPath,
        mcpConfigKey: saved.mcpConfigKey ?? defaultTool.mcpConfigKey,
        // Same treatment — user-edited via LibraryView's renderRuleAdditionalPaths.
        ruleAdditionalPaths: saved.ruleAdditionalPaths ?? defaultTool.ruleAdditionalPaths,
        ruleAdditionalProjectPaths: saved.ruleAdditionalProjectPaths ?? defaultTool.ruleAdditionalProjectPaths,
      };
    });
    // A user-added tool isn't in DEFAULT_TOOLS at all, so the map above never sees it — carry it
    // over as-is instead of letting it silently vanish on the next reload.
    const customTools = (loaded?.tools ?? []).filter(
      (t) => t.custom && !DEFAULT_TOOLS.some((defaultTool) => defaultTool.id === t.id)
    );

    // Same idea for section order: keep the user's chosen order for known sections, but a
    // section added by a later update still shows up (appended) instead of silently vanishing
    // because it's missing from an older saved order list.
    const savedOrder = (loaded?.sectionOrder ?? []).filter((key) => DEFAULT_SECTION_ORDER.includes(key));
    const missingKeys = DEFAULT_SECTION_ORDER.filter((key) => !savedOrder.includes(key));
    const mergedSectionOrder = [...savedOrder, ...missingKeys];

    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded, {
      tools: [...mergedTools, ...customTools],
      sectionOrder: mergedSectionOrder,
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.store?.setFolder(this.settings.storageFolder);
  }

  async activateLibrary() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(LIBRARY_VIEW_TYPE)[0];
    if (existing) {
      await workspace.revealLeaf(existing);
      return;
    }
    const leaf = workspace.getLeaf("tab");
    await leaf.setViewState({ type: LIBRARY_VIEW_TYPE, active: true });
    await workspace.revealLeaf(leaf);
  }
}
