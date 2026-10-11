import { existsSync, realpathSync } from "fs";
import { homedir } from "os";
import { dirname, sep } from "path";
import { expandHome, samePathKey } from "./scanners";

export { samePathKey };
import { ProjectWorkspace } from "./types";

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isInside(path: string, folder: string): boolean {
  const p = samePathKey(path);
  const f = samePathKey(folder);
  return p === f || p.startsWith(f + sep);
}

/** The git repo a symlinked item really lives in, when that repo isn't a workspace yet: the
 *  nearest folder above `realPath` holding a .git, short of the home folder. Null for a target
 *  inside a known workspace, outside any repo (another tool's store, say), or in a plugin cache,
 *  which belongs to the tool's plugin manager. */
export function unregisteredRepoFor(realPath: string, projects: ProjectWorkspace[], pluginCaches: string[] = []): string | null {
  if (projects.some((p) => isInside(realPath, real(expandHome(p.path))))) return null;
  if (pluginCaches.some((dir) => isInside(realPath, real(expandHome(dir))))) return null;
  const home = real(homedir());
  for (let dir = dirname(realPath); dir !== dirname(dir) && dir !== home; dir = dirname(dir)) {
    if (existsSync(`${dir}${sep}.git`)) return dir;
  }
  return null;
}
