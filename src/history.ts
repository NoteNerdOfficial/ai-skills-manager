import { createHash } from "crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join, relative } from "path";

/** Why a snapshot was taken. Each history entry is the state an item was in right BEFORE one of
 *  these happened, so restoring it undoes that change. */
export type HistoryKind = "edit" | "update" | "restore-installed" | "restore";

export interface HistoryEntry {
  id: string;
  entryId: string;
  kind: HistoryKind;
  at: number;
  /** "file": one file inside the item (an in-app edit). "unit": the item's whole folder, or its
   *  single file for a flat item (a GitHub update/restore replaces the whole unit). */
  scope: "file" | "unit";
  /** For "file" scope, the file's path relative to the unit folder ("" when the unit is itself
   *  the file). Always "" for "unit" scope. */
  relPath: string;
  /** For a "unit" snapshot of a GitHub-tracked item, the commit its content was at. Restoring
   *  sets the tracked commit back to this, so "Check for updates" stays honest. */
  commit?: string;
  /** For an "update", the commit it moved to. */
  toCommit?: string;
}

/** Versions kept per item; older ones are removed after each new snapshot. */
export const HISTORY_KEPT = 20;
/** Whole-unit snapshots larger than this are skipped (a skill folder carrying big assets). The
 *  replaced copy still goes to the OS trash, as before history existed. */
export const MAX_UNIT_SNAPSHOT_BYTES = 20 * 1024 * 1024;

const META = "meta.json";
const CONTENT = "content";

function sizeOf(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of readdirSync(path)) {
    if (entry === ".git") continue;
    total += sizeOf(join(path, entry));
    if (total > MAX_UNIT_SNAPSHOT_BYTES) break;
  }
  return total;
}

/**
 * Local version history for items, kept under the plugin's own folder (one subfolder per item,
 * one per version) using plain fs, same as every other file the plugin touches outside the
 * vault. Keyed by entryId, which stays stable when an item is disabled/moved, hashed because an
 * entryId embeds a full path and can be too long (or collide once slugged) as a folder name.
 */
export class ItemHistory {
  constructor(
    private root: string,
    private keep = HISTORY_KEPT
  ) {}

  private itemDir(entryId: string): string {
    return join(this.root, createHash("sha1").update(entryId).digest("hex").slice(0, 16));
  }

  private versionDir(entry: HistoryEntry): string {
    return join(this.itemDir(entry.entryId), entry.id);
  }

  /** Newest first. Unreadable or half-written versions are skipped. */
  list(entryId: string): HistoryEntry[] {
    const dir = this.itemDir(entryId);
    if (!existsSync(dir)) return [];
    const entries: HistoryEntry[] = [];
    for (const name of readdirSync(dir)) {
      try {
        const meta = JSON.parse(readFileSync(join(dir, name, META), "utf-8")) as HistoryEntry;
        if (meta.entryId === entryId && existsSync(join(dir, name, CONTENT))) entries.push(meta);
      } catch {
        // skip
      }
    }
    return entries.sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
  }

  /** Saves `filePath`'s current content before an edit overwrites it. `nextContent` lets a save
   *  that changes nothing skip the snapshot. Returns null when nothing was saved. */
  snapshotFile(entryId: string, unitPath: string, filePath: string, kind: HistoryKind, nextContent?: string): HistoryEntry | null {
    if (!existsSync(filePath)) return null;
    if (nextContent !== undefined && readFileSync(filePath, "utf-8") === nextContent) return null;
    const relPath = filePath === unitPath ? "" : relative(unitPath, filePath);
    return this.write({ entryId, kind, scope: "file", relPath }, (dest) => copyFileSync(filePath, dest));
  }

  /** Saves the whole unit before an update/restore replaces it. Returns null when it's missing or
   *  over MAX_UNIT_SNAPSHOT_BYTES. */
  snapshotUnit(
    entryId: string,
    unitPath: string,
    isDirectory: boolean,
    kind: HistoryKind,
    extra: { commit?: string; toCommit?: string } = {}
  ): HistoryEntry | null {
    if (!existsSync(unitPath) || sizeOf(unitPath) > MAX_UNIT_SNAPSHOT_BYTES) return null;
    return this.write({ entryId, kind, scope: "unit", relPath: "", ...extra }, (dest) => this.copyUnit(unitPath, isDirectory, dest));
  }

  private copyUnit(unitPath: string, isDirectory: boolean, dest: string): void {
    if (isDirectory) {
      cpSync(unitPath, dest, { recursive: true, dereference: true, filter: (src) => basename(src) !== ".git" });
    } else {
      copyFileSync(unitPath, dest);
    }
  }

  /** The saved copy: a file for "file" scope or a flat unit, a folder for a folder unit. */
  contentPath(entry: HistoryEntry): string {
    return join(this.versionDir(entry), CONTENT);
  }

  /** Text of one file in a version: the edited file for "file" scope, or `relPath` inside a
   *  "unit" snapshot ("" for a flat unit). Empty string when it isn't there. */
  readText(entry: HistoryEntry, relPath = ""): string {
    const path = entry.scope === "unit" && relPath ? join(this.contentPath(entry), relPath) : this.contentPath(entry);
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return "";
    }
  }

  /** Saves the current state of whatever `entry` covers, right before restoring it. Unlike the
   *  other snapshots this doesn't prune, since pruning could remove `entry` itself before it's
   *  been copied back; call prune() once the restore is done. */
  snapshotBeforeRestore(entry: HistoryEntry, unitPath: string, isDirectory: boolean, commit?: string): HistoryEntry | null {
    if (entry.scope === "file") {
      const filePath = entry.relPath ? join(unitPath, entry.relPath) : unitPath;
      if (!existsSync(filePath) || readFileSync(filePath, "utf-8") === this.readText(entry)) return null;
      return this.write({ entryId: entry.entryId, kind: "restore", scope: "file", relPath: entry.relPath }, (dest) => copyFileSync(filePath, dest), false);
    }
    if (!existsSync(unitPath) || sizeOf(unitPath) > MAX_UNIT_SNAPSHOT_BYTES) return null;
    return this.write({ entryId: entry.entryId, kind: "restore", scope: "unit", relPath: "", commit }, (dest) => this.copyUnit(unitPath, isDirectory, dest), false);
  }

  /** Writes a "file" version back over its file. Unit versions go through the view's
   *  replaceUnit instead, so the replaced copy reaches the trash like an update. */
  restoreFile(entry: HistoryEntry, unitPath: string): void {
    if (entry.scope !== "file") throw new Error("Not a single-file version.");
    const target = entry.relPath ? join(unitPath, entry.relPath) : unitPath;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(this.contentPath(entry), target);
  }

  private write(fields: Omit<HistoryEntry, "id" | "at">, copy: (dest: string) => void, prune = true): HistoryEntry {
    const itemDir = this.itemDir(fields.entryId);
    const at = Date.now();
    let id = String(at);
    for (let n = 1; existsSync(join(itemDir, id)); n++) id = `${at}-${n}`;
    const entry: HistoryEntry = { id, at, ...fields };
    const dir = join(itemDir, id);
    mkdirSync(dir, { recursive: true });
    try {
      copy(join(dir, CONTENT));
      // meta.json last: list() ignores a version without it, so a failed copy never shows up.
      writeFileSync(join(dir, META), JSON.stringify(entry, null, 2) + "\n");
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    if (prune) this.prune(fields.entryId);
    return entry;
  }

  prune(entryId: string): void {
    for (const old of this.list(entryId).slice(this.keep)) {
      try {
        rmSync(this.versionDir(old), { recursive: true, force: true });
      } catch {
        // Leave it; the next snapshot tries again.
      }
    }
  }
}
