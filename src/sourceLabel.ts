import { ItemMetadata, PluginSource, ProjectWorkspace, SkillSpacePluginSettings } from "./types";
import { VAULT_PROJECT_ID } from "./rescan";

/** Same tool ("Claude Code") reads identically whether an item is truly global or scoped to one
 *  specific vault/project/plugin — this makes that explicit everywhere the item is shown, not
 *  just when a sidebar filter happens to already be scoped to one of them. Pure/read-only, so
 *  it's shared by both the library card/detail chrome and the file view's header. */
export function sourceLabel(
  item: ItemMetadata,
  settings: SkillSpacePluginSettings,
  projects: ProjectWorkspace[],
  plugins: PluginSource[]
): { icon: string; text: string; svgIcon?: string } {
  const tool = settings.tools.find((t) => t.id === item.tool);
  const toolName = tool?.name ?? item.tool;
  if (item.pluginId) {
    const pluginName = plugins.find((p) => p.id === item.pluginId)?.name ?? item.pluginId;
    return { icon: "package", text: `${toolName} · ${pluginName}` };
  }
  if (item.projectId) {
    const project = projects.find((p) => p.id === item.projectId);
    const icon = item.projectId === VAULT_PROJECT_ID ? "book-marked" : "folder-git-2";
    return { icon, text: `${toolName} · ${project?.name ?? "Project"}` };
  }
  return { icon: tool?.icon ?? "globe", text: `${toolName} · Global`, svgIcon: tool?.svgIcon };
}
