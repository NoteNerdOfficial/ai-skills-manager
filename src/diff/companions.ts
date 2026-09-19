import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

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
