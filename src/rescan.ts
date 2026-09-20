import { App, FileSystemAdapter } from "obsidian";
import { ItemMetadata, PluginSource, ProjectWorkspace, SkillSpacePluginSettings } from "./types";
import { scanAllPlugins, scanAllProjects, scanAllTools } from "./scanners";
import { ShadowNoteStore } from "./store";

export const VAULT_PROJECT_ID = "vault";

/** Lucide icon id for a project/vault name shown anywhere in the UI — the vault reads as
 *  distinct from a registered project workspace wherever its name appears (sidebar, card
 *  chips, the project-links picker), not just in the sidebar. */
export function projectIcon(projectId: string): string {
  return projectId === VAULT_PROJECT_ID ? "book-marked" : "folder-git-2";
}

/** The current vault (auto-registered, always included) plus any user-registered project folders. */
export function getAllProjects(app: App, settings: SkillSpacePluginSettings): ProjectWorkspace[] {
  const adapter = app.vault.adapter;
  const vaultProject: ProjectWorkspace[] =
    adapter instanceof FileSystemAdapter
      ? [{ id: VAULT_PROJECT_ID, name: app.vault.getName(), path: adapter.getBasePath() }]
      : [];
  return [...vaultProject, ...settings.projectWorkspaces];
}

export interface RescanResult {
  items: ItemMetadata[];
  plugins: PluginSource[];
}

/** Re-scans every configured tool/project/plugin directory and syncs the shadow-note store to
 *  match. Shared by the library view (full rescan) and the file view (just needs a fresh read
 *  after a project-presence change) so the scan pipeline can't drift into two implementations.
 *
 *  A disabled tool (see ToolConfig.disabled, set from the "All tools" page) is still scanned
 *  and kept in the store/returned items here, deliberately — skipping the scan entirely would
 *  mean pruneMissing() deletes its shadow notes (tags/favourites/collections), silently wiping
 *  that metadata on every disable rather than just hiding the items until re-enabled. Hiding a
 *  disabled tool's items from the main library grid happens downstream instead, in
 *  LibraryView.filteredItems() — this result stays "everything that's actually stored" so the
 *  "All tools" page can still show a disabled tool's true item count. */
export async function performRescan(
  app: App,
  settings: SkillSpacePluginSettings,
  store: ShadowNoteStore
): Promise<RescanResult> {
  const projects = getAllProjects(app, settings);
  const pluginScan = scanAllPlugins(settings.tools);
  const discovered = [
    ...scanAllTools(settings.tools),
    ...scanAllProjects(settings.tools, projects),
    ...pluginScan.items,
  ];
  for (const item of discovered) {
    await store.ensureItem(item);
  }
  await store.pruneMissing(new Set(discovered.map((d) => d.entryId)));
  return { items: await store.list(), plugins: pluginScan.plugins };
}
