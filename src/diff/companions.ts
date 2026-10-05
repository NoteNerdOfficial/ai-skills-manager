import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, join } from "path";

export type CompanionStatus = "added" | "removed" | "modified";
export interface CompanionRow {
  file: string;
  status: CompanionStatus;
}

/** Every file under `dir`, as paths relative to it — used to diff a whole skill folder's file
 *  list against a freshly-fetched one, without depending on Node's newer recursive readdirSync
 *  (not guaranteed across the range of Electron/Node builds Obsidian desktop ships with). */
function listFilesRecursive(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === ".git") continue;
    const entryPath = join(dir, entry);
    const relPath = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(entryPath).isDirectory()) {
      files.push(...listFilesRecursive(entryPath, relPath));
    } else {
      files.push(relPath);
    }
  }
  return files;
}

function filesEqual(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/** Added/removed/modified status for every file in a skill's folder other than SKILL.md itself
 *  (that one gets a real line diff — see renderDiff.ts — this just needs to flag that something
 *  else changed too), sorted for stable rendering. */
export function computeCompanionChanges(oldDir: string, newDir: string): CompanionRow[] {
  const oldFiles = new Set(listFilesRecursive(oldDir).filter((f) => f !== "SKILL.md"));
  const newFiles = new Set(listFilesRecursive(newDir).filter((f) => f !== "SKILL.md"));

  const rows: CompanionRow[] = [];
  for (const file of newFiles) {
    if (!oldFiles.has(file)) rows.push({ file, status: "added" });
    else if (!filesEqual(join(oldDir, file), join(newDir, file))) rows.push({ file, status: "modified" });
  }
  for (const file of oldFiles) {
    if (!newFiles.has(file)) rows.push({ file, status: "removed" });
  }
  return rows.sort((a, b) => a.file.localeCompare(b.file));
}

/** One changed file: its path relative to the item, what applying would do to it, and the two
 *  sides (`oldPath` is what's on disk now, `newPath` is what would replace it). */
export interface TabsDiffFile {
  file: string;
  status: CompanionStatus;
  oldPath: string;
  newPath: string;
}

/** Every file that differs between a unit on disk and another copy of it (a history version or a
 *  freshly fetched update): SKILL.md first when it changed, then the rest sorted. A flat unit is
 *  one file compared as a whole. */
export function changedUnitFiles(unitPath: string, otherPath: string, isDirectory: boolean): TabsDiffFile[] {
  const differs = (a: string, b: string) =>
    existsSync(a) !== existsSync(b) || (existsSync(a) && !readFileSync(a).equals(readFileSync(b)));
  if (!isDirectory) {
    return differs(unitPath, otherPath)
      ? [{ file: basename(unitPath), status: existsSync(unitPath) ? "modified" : "added", oldPath: unitPath, newPath: otherPath }]
      : [];
  }
  const files: TabsDiffFile[] = [];
  const manifest = (root: string) => join(root, "SKILL.md");
  if (differs(manifest(unitPath), manifest(otherPath))) {
    files.push({
      file: "SKILL.md",
      status: !existsSync(manifest(unitPath)) ? "added" : !existsSync(manifest(otherPath)) ? "removed" : "modified",
      oldPath: manifest(unitPath),
      newPath: manifest(otherPath),
    });
  }
  for (const row of computeCompanionChanges(unitPath, otherPath)) {
    files.push({ file: row.file, status: row.status, oldPath: join(unitPath, row.file), newPath: join(otherPath, row.file) });
  }
  return files;
}
