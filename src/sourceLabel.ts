import { ItemMetadata, PluginSource, ProjectWorkspace, SkillManagerPluginSettings } from "./types";
import { projectIcon } from "./rescan";
import { isBuiltInPath } from "./scanners";

/** What tool this item is for, and the plugin it's bundled with or built-in status (if either) —
 *  answers "what is this and where's it from," independent of where it's currently scoped.
 *  Pure/read-only. */
export function toolLabel(
  item: ItemMetadata,
  settings: SkillManagerPluginSettings,
  plugins: PluginSource[]
): { icon: string; text: string; svgIcon?: string } {
  const tool = settings.tools.find((t) => t.id === item.tool);
  const toolName = tool?.name ?? item.tool;
  if (item.pluginId) {
    const pluginName = plugins.find((p) => p.id === item.pluginId)?.name ?? item.pluginId;
    return { icon: tool?.icon ?? "package", text: `${toolName} · ${pluginName}`, svgIcon: tool?.svgIcon };
  }
  if (isBuiltInPath(item.sourcePath, tool)) {
    return { icon: tool?.icon ?? "blocks", text: `${toolName} · Built-in`, svgIcon: tool?.svgIcon };
  }
  return { icon: tool?.icon ?? "blocks", text: toolName, svgIcon: tool?.svgIcon };
}

/** Global, or the one specific project/vault this instance lives in or is linked from —
 *  answers "where is it scoped," independent of which tool/plugin it's for. Pure/read-only. */
export function originLabel(item: ItemMetadata, projects: ProjectWorkspace[]): { icon: string; text: string } {
  if (item.projectId) {
    const project = projects.find((p) => p.id === item.projectId);
    return { icon: projectIcon(item.projectId), text: project?.name ?? "Project" };
  }
  return { icon: "globe", text: "Global" };
}

/** Combined "Tool(· Plugin) · Origin" line — used where there's only one slot to put identity
 *  info in (the detail pane's single-line header pill), unlike the card, which has a slot for
 *  each (see toolLabel/originLabel) and would otherwise say the same thing twice. */
export function sourceLabel(
  item: ItemMetadata,
  settings: SkillManagerPluginSettings,
  projects: ProjectWorkspace[],
  plugins: PluginSource[]
): string {
  return `${toolLabel(item, settings, plugins).text} · ${originLabel(item, projects).text}`;
}
