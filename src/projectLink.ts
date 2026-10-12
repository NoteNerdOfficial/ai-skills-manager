import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, symlinkSync, unlinkSync } from "fs";
import { basename, dirname, join, relative, sep } from "path";
import { linkableUnit } from "./fsUnit";
import { FINISHED_MODS_DIR, setPluginDirListed } from "./itemToggle";
import { expandHome, readPluginDirsEnv, resolveToolDir } from "./scanners";
import { ItemMetadata, ModEntry, ProjectWorkspace, ToolConfig } from "./types";

/** Symlinks an item into a project's local tool folder, or with `project` null into the tool's
 *  global (user) folder, for an item kept in a project or repo — never copies, so it can never
 *  drift out of sync with the source. */
export function addToProject(item: ItemMetadata, tool: ToolConfig, project: ProjectWorkspace | null): void {
  const targetDir = resolveToolDir(tool, item.type, project);
  if (!targetDir) throw new Error(`${tool.name} has no configured ${item.type} path`);

  mkdirSync(targetDir, { recursive: true });

  const unit = linkableUnit(item.sourcePath);
  const linkPath = join(targetDir, unit.name);
  if (existsSync(linkPath)) return;
  symlinkSync(unit.path, linkPath, unit.isDirectory ? "dir" : "file");
}

/** Removes a project-local item — but only if it's actually a symlink we (or the user) created,
 *  never a real file, so this can't accidentally delete vault-only content. */
export function removeFromProject(projectItemSourcePath: string): void {
  const unit = linkableUnit(projectItemSourcePath);
  if (!lstatSync(unit.path).isSymbolicLink()) {
    throw new Error("This item isn't a symlink, so it won't be deleted as a real file or folder.");
  }
  unlinkSync(unit.path);
}

/** Mod origins that can be linked into a project: a folder the person keeps (a CLAUDE_CODE_PLUGIN_DIRS
 *  folder, or one in a skills folder). An installed mod belongs to the tool's plugin manager and a
 *  dev mod to the session developing it, so neither is linked from here. */
export function canLinkModToProjects(mod: ModEntry, tool: ToolConfig | undefined): tool is ToolConfig {
  return !!(tool?.projectPaths?.skill ?? tool?.paths.skill) && (mod.origin === "plugin-dir" || mod.origin === "skill" || mod.origin === "repo");
}

/** The symlink in a project's skills folder (or with `project` null, the global one) that points
 *  at this mod, if any. The tool loads a plugin it finds there, followed through the link, in that
 *  project only, or in every session from the global folder. */
export function modProjectLink(mod: ModEntry, tool: ToolConfig, project: ProjectWorkspace | null): string | null {
  const dir = resolveToolDir(tool, "skill", project);
  if (!dir) return null;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      if (lstatSync(path).isSymbolicLink() && realpathSync(path) === mod.realPath) return path;
    } catch {
      // A broken link points at nothing, so it isn't this mod.
    }
  }
  return null;
}

/** Symlinks a mod folder into a project's skills folder (or with `project` null, the global one),
 *  named after the folder it points at. Refuses rather than replace anything already there. */
export function addModToProject(mod: ModEntry, tool: ToolConfig, project: ProjectWorkspace | null): void {
  const dir = resolveToolDir(tool, "skill", project);
  if (!dir) throw new Error(`${tool.name} has no configured skill path`);
  if (modProjectLink(mod, tool, project)) return;
  const linkPath = join(dir, basename(mod.realPath));
  if (existsSync(linkPath) || isLink(linkPath)) throw new Error(`${linkPath} already exists.`);
  mkdirSync(dir, { recursive: true });
  // A project's own mod links from its real folder, never through that project's symlink.
  symlinkSync(mod.projectId ? mod.realPath : mod.path, linkPath, "dir");
}

/** Removes the mod's symlink from a project's (or the global) skills folder. The folder it points
 *  at is untouched. */
export function removeModFromProject(mod: ModEntry, tool: ToolConfig, project: ProjectWorkspace | null): void {
  const linkPath = modProjectLink(mod, tool, project);
  if (linkPath) unlinkSync(linkPath);
}

/** The project holding the mod's real folder (not a link to it): where it's kept, so it can't be
 *  linked into or unlinked from there. `loadsThere` is set when that's the project's skills folder,
 *  which the tool loads it from, rather than a source repo's root, which it doesn't. */
export function modSourceProject(
  mod: ModEntry,
  tool: ToolConfig,
  projects: ProjectWorkspace[]
): { project: ProjectWorkspace; loadsThere: boolean } | null {
  const home = dirname(mod.realPath);
  const same = (dir: string | null) => {
    try {
      return !!dir && realpathSync(dir) === home;
    } catch {
      return false;
    }
  };
  for (const project of projects) {
    if (same(resolveToolDir(tool, "skill", project))) return { project, loadsThere: true };
    if (project.sourceRepoToolId && same(expandHome(project.path))) return { project, loadsThere: false };
  }
  return null;
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

const realOrNull = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/** The CLAUDE_CODE_PLUGIN_DIRS entries that load this mod's real folder, as written there. */
export function modGlobalEntries(mod: ModEntry, tool: ToolConfig): string[] {
  return readPluginDirsEnv(tool.pluginsSettingsPath).filter((dir) => realOrNull(dir) === mod.realPath);
}

/** Global for a mod: listed in CLAUDE_CODE_PLUGIN_DIRS, how the tool loads a mod you keep in every
 *  session. A legacy symlink in the global skills folder counts too, so unchecking clears it. */
export function isModGlobal(mod: ModEntry, tool: ToolConfig): boolean {
  return modGlobalEntries(mod, tool).length > 0 || !!modProjectLink(mod, tool, null);
}

/** Lists a mod in CLAUDE_CODE_PLUGIN_DIRS, through FINISHED_MODS_DIR (~/mods) like Promote and
 *  Install: a folder already inside it is listed as is, and one kept anywhere else gets a symlink
 *  there first, so every global mod is reachable from one folder. Unlisting removes every entry
 *  for the mod, the ~/mods symlink if that's what it was listed through, and any legacy symlink
 *  in the global skills folder. The mod's own folder is never moved or deleted. */
export function setModGlobal(mod: ModEntry, tool: ToolConfig, on: boolean): void {
  const modsDir = expandHome(FINISHED_MODS_DIR);
  if (on) {
    const realModsDir = realOrNull(modsDir);
    let dir: string;
    if (realModsDir && mod.realPath.startsWith(realModsDir + sep)) {
      dir = join(modsDir, relative(realModsDir, mod.realPath));
    } else {
      dir = join(modsDir, basename(mod.realPath));
      if (realOrNull(dir) !== mod.realPath) {
        if (existsSync(dir) || isLink(dir)) throw new Error(`${dir} already exists.`);
        mkdirSync(modsDir, { recursive: true });
        symlinkSync(mod.realPath, dir, "dir");
      }
    }
    setPluginDirListed(tool, dir, true);
    return;
  }
  for (const entry of modGlobalEntries(mod, tool)) {
    setPluginDirListed(tool, entry, false);
    if (dirname(entry) === modsDir && isLink(entry)) unlinkSync(entry);
  }
  removeModFromProject(mod, tool, null);
}
