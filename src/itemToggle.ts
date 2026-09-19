import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { linkableUnit } from "./fsUnit";
import { ItemMetadata } from "./types";

export const DISABLED_DIRNAME = ".skillspace-disabled";

/** A plain rename breaks a relative symlink (e.g. "../../.agents/skills/foo") the moment it
 *  moves a directory level deeper or shallower, since the "../" count no longer lands on the
 *  same place — it silently produces a dangling link. Re-creating the symlink with an absolute
 *  target avoids that entirely, regardless of how many levels it moves. */
function moveEntry(fromPath: string, toPath: string, isDirectory: boolean): void {
  if (lstatSync(fromPath).isSymbolicLink()) {
    const rawTarget = readlinkSync(fromPath);
    const absoluteTarget = isAbsolute(rawTarget) ? rawTarget : resolve(dirname(fromPath), rawTarget);
    unlinkSync(fromPath);
    symlinkSync(absoluteTarget, toPath, isDirectory ? "dir" : "file");
  } else {
    renameSync(fromPath, toPath);
  }
}

/** Toggles whether a tool can actually see this item, by physically moving it in or out of a
 *  sibling ".skillspace-disabled" folder. Our earlier "enabled" flag lived only in our own
 *  shadow note and never touched the file a tool reads, so it had no real effect — this does. */
export function toggleItemEnabled(item: ItemMetadata): void {
  const unit = linkableUnit(item.sourcePath);
  const parentDir = dirname(unit.path);

  if (basename(parentDir) === DISABLED_DIRNAME) {
    const targetDir = dirname(parentDir);
    const target = join(targetDir, unit.name);
    if (existsSync(target)) throw new Error(`"${unit.name}" already exists at its enabled location.`);
    moveEntry(unit.path, target, unit.isDirectory);
  } else {
    const disabledDir = join(parentDir, DISABLED_DIRNAME);
    mkdirSync(disabledDir, { recursive: true });
    const target = join(disabledDir, unit.name);
    if (existsSync(target)) throw new Error(`"${unit.name}" is already disabled.`);
    moveEntry(unit.path, target, unit.isDirectory);
  }
}

/** Removes the on-disk unit backing this card. For a real skill/agent/command/rule, this is an
 *  uninstall — the actual file or folder is gone for good. For a project-scoped symlink instance,
 *  `sourcePath` (and so `unit.path`) is the symlink itself, not the global skill it points to, so
 *  this degrades to exactly the existing "unlink" behavior (see projectLink.ts's
 *  removeFromProject) without needing to special-case it. */
export function deleteItem(item: ItemMetadata): void {
  const unit = linkableUnit(item.sourcePath);
  rmSync(unit.path, { recursive: true, force: true });
}
