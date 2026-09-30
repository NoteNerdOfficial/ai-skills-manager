import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { linkableUnit } from "./fsUnit";
import { ItemMetadata, ToolConfig } from "./types";

export const DISABLED_DIRNAME = ".skillmanager-disabled";

function expandHome(rawPath: string): string {
  return rawPath.startsWith("~") ? join(homedir(), rawPath.slice(1)) : rawPath;
}

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
 *  sibling ".skillmanager-disabled" folder. Our earlier "enabled" flag lived only in our own
 *  shadow note and never touched the file a tool reads, so it had no real effect — this does.
 *
 *  Refuses anything with a pluginId: that folder belongs to the tool's own plugin manager (e.g.
 *  a git-tracked plugin cache), not a personal skills folder, and the tool has no concept of
 *  disabling one skill inside a plugin anyway — it only tracks whole-plugin on/off (see
 *  togglePluginEnabled). Moving a file out of a plugin's managed directory previously left it
 *  invisible to both the library (a scanning gap, since fixed) and the tool itself, while also
 *  leaving the plugin's own install directory in a dirty, inconsistent state. */
export function toggleItemEnabled(item: ItemMetadata): void {
  if (item.pluginId !== null) {
    throw new Error(`"${item.name}" is part of an installed plugin — disable the whole plugin from the sidebar instead.`);
  }
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

export interface ToggleMovePreview {
  /** True when this call would DISABLE the item (moving it in under DISABLED_DIRNAME); false
   *  when it would RE-ENABLE it (moving it back out) — mirrors the branch toggleItemEnabled
   *  above takes, based on whether the item's current folder already IS a .skillmanager-disabled
   *  sibling. */
  willDisable: boolean;
  fromPath: string;
  toPath: string;
}

/** Pure preview of what toggleItemEnabled above would actually do to this item's unit on disk —
 *  no filesystem writes. Kept here, right beside the real move logic, so a caller that wants to
 *  word a confirmation prompt around the exact source/destination paths (see LibraryView's
 *  confirmToggle) can never drift from what toggleItemEnabled itself would do. */
export function previewToggle(item: ItemMetadata): ToggleMovePreview {
  const unit = linkableUnit(item.sourcePath);
  const parentDir = dirname(unit.path);
  if (basename(parentDir) === DISABLED_DIRNAME) {
    return { willDisable: false, fromPath: unit.path, toPath: join(dirname(parentDir), unit.name) };
  }
  return { willDisable: true, fromPath: unit.path, toPath: join(parentDir, DISABLED_DIRNAME, unit.name) };
}

/** YYYYMMDD-HHMMSS, local time — just enough resolution to sort correctly alongside a plain
 *  directory listing without dragging in a date-formatting dependency for one string. */
function backupTimestamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** Copies settingsPath to a sibling "<name>.skillmanager-bak-<timestamp>" before it's about to
 *  be overwritten, so a bad plugin-bundle toggle (or any other corruption of the tool's own
 *  settings file) can always be recovered by hand. COPYFILE_EXCL refuses to silently clobber an
 *  existing file at the backup's own path; on that collision (two toggles landing in the same
 *  second) a numeric suffix is appended instead of overwriting the earlier backup — "one backup
 *  per write" is the whole point of this existing. Throws (and so aborts the write that would
 *  have followed it — see togglePluginEnabled) if the copy can't be made at all. */
function backupSettingsFile(settingsPath: string): void {
  const base = `${settingsPath}.skillmanager-bak-${backupTimestamp(new Date())}`;
  let target = base;
  let suffix = 0;
  for (;;) {
    try {
      copyFileSync(settingsPath, target, constants.COPYFILE_EXCL);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      suffix++;
      target = `${base}-${suffix}`;
    }
  }
}

/** Flips whether the tool loads an installed plugin at all, by writing straight into the
 *  tool's own settings JSON (e.g. Claude Code's ~/.claude/settings.json "enabledPlugins" map) —
 *  the same file and key the tool's own plugin enable/disable UI would write to, unlike
 *  toggleItemEnabled's file-move trick. This is the only granularity the tool actually supports:
 *  every item bundled in the plugin turns on or off as one unit.
 *
 *  Backs the file up first (see backupSettingsFile) — this reads, then wholesale rewrites, a
 *  file the tool itself owns and that can carry a lot more than just plugin state (permissions,
 *  other settings), so a parse/write mistake here is worth being able to undo by hand. If the
 *  backup can't be made, the rewrite doesn't happen either. */
export function togglePluginEnabled(tool: ToolConfig, pluginId: string, currentlyEnabled: boolean): void {
  if (!tool.pluginsSettingsPath) throw new Error(`${tool.name} has no known plugin settings file.`);
  const settingsPath = expandHome(tool.pluginsSettingsPath);
  if (!existsSync(settingsPath)) throw new Error(`${tool.name}'s settings file wasn't found at ${settingsPath}.`);

  backupSettingsFile(settingsPath);

  const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown> & {
    enabledPlugins?: Record<string, boolean>;
  };
  raw.enabledPlugins = { ...(raw.enabledPlugins ?? {}), [pluginId]: !currentlyEnabled };
  writeFileSync(settingsPath, JSON.stringify(raw, null, 2) + "\n");
}

/** A callback that moves a real path to the OS's own trash/recycle bin, resolving once it's
 *  actually there (or rejecting if it isn't) — deliberately just a function, not an Electron
 *  import of its own, so this stays a plain Node module. LibraryView supplies the real one via
 *  Electron's `shell.trashItem` (see its electronShell()); tests inject a fake. */
export type TrashFn = (path: string) => Promise<void>;

/** Removes the on-disk unit backing this card. For a real skill/agent/command/rule, this moves
 *  the file or folder to the OS trash/recycle bin via the injected `trash` function — recoverable
 *  by hand from there, unlike the permanent rmSync this used to do. For a project-scoped symlink
 *  instance, `sourcePath` (and so `unit.path`) is the symlink itself, not the global skill it
 *  points to: that case is never routed through `trash` at all, just unlinked directly, exactly
 *  matching the existing "unlink only, never touch the real target" behavior (see
 *  projectLink.ts's removeFromProject) — trashing a symlink would still only be trashing the
 *  link, so there's nothing trash-specific to gain by going through Electron for it, and it keeps
 *  this path working even where Electron's shell isn't reachable at all.
 *
 *  Refuses anything with a pluginId, same reasoning as toggleItemEnabled's guard: the file lives
 *  inside the tool's own plugin manager (for Claude Code, a git-tracked cache directory it can
 *  re-clone or update at any time), not a personal skills folder we own the lifecycle of.
 *  Permanently deleting a file out of that directory is a plugin uninstall, and the tool already
 *  has its own supported way to do that — this app has no business doing it via rm (or trash). */
export async function deleteItem(item: ItemMetadata, trash: TrashFn): Promise<void> {
  if (item.pluginId !== null) {
    throw new Error(`"${item.name}" is part of an installed plugin — remove the whole plugin from where it was installed instead.`);
  }
  const unit = linkableUnit(item.sourcePath);
  if (lstatSync(unit.path).isSymbolicLink()) {
    unlinkSync(unit.path);
    return;
  }
  await trash(unit.path);
}
