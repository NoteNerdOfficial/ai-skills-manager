import { readdirSync, statSync } from "fs";
import { basename, dirname, join } from "path";
import { ItemMetadata } from "./types";

export interface TreeNode {
  name: string;
  /** Relative to the skill's own folder, e.g. "references/palette.md" — not the absolute path. */
  relPath: string;
  absPath: string;
  isDir: boolean;
  children?: TreeNode[];
}

const SKIP_ENTRIES = new Set(["node_modules", ".git", ".DS_Store"]);
const MAX_DEPTH = 4;

/** Only a folder-based skill (a SKILL.md manifest inside its own directory, per the scanner's
 *  own branching in scanEntries) has sibling files worth browsing — a flat agent/command/rule
 *  .md file's directory is the shared tool folder, not something scoped to that one item. */
export function isFolderItem(item: ItemMetadata): boolean {
  return basename(item.sourcePath) === "SKILL.md";
}

export function skillFolder(item: ItemMetadata): string {
  return dirname(item.sourcePath);
}

/** `keepDotEntry` lets a caller show a dot-folder that matters for its kind of item (a mod's
 *  .claude-plugin manifest); every other dot entry stays hidden. */
function walk(dir: string, prefix: string, depth: number, keepDotEntry?: (relPath: string) => boolean): TreeNode[] {
  if (depth > MAX_DEPTH) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const nodes: TreeNode[] = [];
  for (const entry of entries) {
    if (SKIP_ENTRIES.has(entry)) continue;
    const absPath = join(dir, entry);
    const relPath = prefix ? `${prefix}/${entry}` : entry;
    if (entry.startsWith(".") && !keepDotEntry?.(relPath)) continue;

    let isDir = false;
    try {
      isDir = statSync(absPath).isDirectory();
    } catch {
      continue; // dangling symlink or permission error — skip rather than fail the whole tree
    }

    nodes.push(
      isDir
        ? { name: entry, relPath, absPath, isDir: true, children: walk(absPath, relPath, depth + 1, keepDotEntry) }
        : { name: entry, relPath, absPath, isDir: false }
    );
  }

  nodes.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return nodes;
}

export function buildFileTree(item: ItemMetadata): TreeNode[] {
  return walk(skillFolder(item), "", 0);
}

/** A mod's folder, with its .claude-plugin manifest shown but not the type declarations the engine
 *  writes into .claude-plugin/types on every load (generated, and about 14,000 lines). */
export function buildModFileTree(modPath: string): TreeNode[] {
  const nodes = walk(modPath, "", 0, (relPath) => relPath === ".claude-plugin");
  for (const node of nodes) {
    if (node.relPath === ".claude-plugin") node.children = node.children?.filter((child) => child.name !== "types");
  }
  return nodes;
}

export function countFiles(nodes: TreeNode[]): number {
  return nodes.reduce((sum, n) => sum + (n.isDir ? countFiles(n.children ?? []) : 1), 0);
}
