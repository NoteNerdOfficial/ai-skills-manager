import { existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync } from "fs";
import { join } from "path";
import { linkableUnit } from "./fsUnit";
import { resolveToolDir } from "./scanners";
import { ItemMetadata, ProjectWorkspace, ToolConfig } from "./types";

/** Symlinks a global item into a project's local tool folder — never copies, so it can never
 *  drift out of sync with the source. */
export function addToProject(item: ItemMetadata, tool: ToolConfig, project: ProjectWorkspace): void {
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
