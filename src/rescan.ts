import { App, FileSystemAdapter } from "obsidian";
import { ItemMetadata, PluginSource, ProjectWorkspace, SkillSpacePluginSettings } from "./types";
import { scanAllPlugins, scanAllProjects, scanAllTools } from "./scanners";
import { ShadowNoteStore } from "./store";

export const VAULT_PROJECT_ID = "vault";

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
 *  after a project-presence change) so the scan pipeline can't drift into two implementations. */
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
