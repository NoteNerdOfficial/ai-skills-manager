import { basename, dirname } from "path";

export interface LinkableUnit {
  path: string;
  isDirectory: boolean;
  name: string;
}

/** The filesystem entry that actually represents an item — a SKILL.md's containing folder
 *  (folders are the addressable unit for skills, matching how tools symlink them), or the
 *  file itself for flat commands/agents/rules. Shared by the project-symlink and
 *  enable/disable-move logic so both agree on what "this item" means on disk. */
export function linkableUnit(sourcePath: string): LinkableUnit {
  if (basename(sourcePath) === "SKILL.md") {
    const dir = dirname(sourcePath);
    return { path: dir, isDirectory: true, name: basename(dir) };
  }
  return { path: sourcePath, isDirectory: false, name: basename(sourcePath) };
}
