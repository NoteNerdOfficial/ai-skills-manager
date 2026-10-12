import { constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "path";
import { linkableUnit } from "./fsUnit";
import { ItemMetadata, ToolConfig } from "./types";

export const DISABLED_DIRNAME = ".skillmanager-disabled";
/** Appended to a disabled flat file's name (commands/agents/rules). Moving it into
 *  DISABLED_DIRNAME alone isn't enough: Claude Code loads every .md under commands/ (and
 *  agents/, rules/) recursively, so ".skillmanager-disabled/ado.md" still loaded as
 *  "/.skillmanager-disabled:ado". Without the .md extension no tool picks it up. Folder units
 *  (skills) don't need it, since tools only look one level down for SKILL.md. */
export const DISABLED_SUFFIX = ".skillmanager-disabled";

/** Where a unit goes when disabled: into the sibling DISABLED_DIRNAME, plus DISABLED_SUFFIX for a
 *  flat file. */
export function disabledLocation(path: string, isDirectory: boolean): string {
  return join(dirname(path), DISABLED_DIRNAME, basename(path) + (isDirectory ? "" : DISABLED_SUFFIX));
}

/** Where a disabled unit goes back to. Strips DISABLED_SUFFIX when present; a flat file disabled
 *  before the suffix existed has none and moves back as-is. */
function enabledLocation(path: string): string {
  const name = basename(path);
  return join(dirname(dirname(path)), name.endsWith(DISABLED_SUFFIX) ? name.slice(0, -DISABLED_SUFFIX.length) : name);
}

/** Renames a flat file that was disabled before DISABLED_SUFFIX existed ("<dir>/.skillmanager-
 *  disabled/foo.md") so its tool stops loading it. Returns the new path, or null when nothing
 *  needed renaming. */
export function upgradeLegacyDisabledFile(sourcePath: string): string | null {
  const unit = linkableUnit(sourcePath);
  if (unit.isDirectory || basename(dirname(unit.path)) !== DISABLED_DIRNAME || unit.name.endsWith(DISABLED_SUFFIX)) return null;
  const target = unit.path + DISABLED_SUFFIX;
  if (existsSync(target)) return null;
  moveEntry(unit.path, target, false);
  return target;
}

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
  } else if (isDirectory) {
    renameFolderWithRetry(fromPath, toPath);
  } else {
    renameSync(fromPath, toPath);
  }
}

/** Windows refuses to rename a folder while another process (antivirus, the search indexer, an
 *  editor) holds a file inside it open without FILE_SHARE_DELETE, and reports one of these codes
 *  until the handle closes. On other platforms they mean a real permission problem that waiting
 *  won't fix. */
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_RETRIES = 4;
const RENAME_RETRY_DELAY_MS = 150;

/** renameSync for a folder, retried on Windows with a linear backoff (150ms, 300ms, 450ms, 600ms:
 *  5 attempts, at most ~1.5s of waiting) and then rethrowing the last error; Node has no built-in
 *  retry for rename. The wait is a busy-loop because the toggle stays synchronous for its callers
 *  and Atomics.wait isn't allowed on a browser main thread; it only runs after a failed rename. */
function renameFolderWithRetry(fromPath: string, toPath: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(fromPath, toPath);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || attempt >= RENAME_RETRIES || !RENAME_RETRY_CODES.has(code)) throw e;
      const until = Date.now() + RENAME_RETRY_DELAY_MS * (attempt + 1);
      while (Date.now() < until) {
        // Busy-wait; see above.
      }
    }
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
    throw new Error(`"${item.name}" is part of an installed plugin. Disable the whole plugin from the sidebar instead.`);
  }
  const { willDisable, fromPath, toPath } = previewToggle(item);
  if (existsSync(toPath)) {
    throw new Error(willDisable ? `"${item.name}" is already disabled.` : `"${basename(toPath)}" already exists at its enabled location.`);
  }
  if (willDisable) mkdirSync(dirname(toPath), { recursive: true });
  moveEntry(fromPath, toPath, linkableUnit(item.sourcePath).isDirectory);
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

/** What toggleItemEnabled would do to this item's unit on disk, with no filesystem writes.
 *  toggleItemEnabled runs off this same result, so a confirmation worded from it (see
 *  LibraryView's confirmToggle) can't drift from the real move. */
export function previewToggle(item: ItemMetadata): ToggleMovePreview {
  const unit = linkableUnit(item.sourcePath);
  if (basename(dirname(unit.path)) === DISABLED_DIRNAME) {
    return { willDisable: false, fromPath: unit.path, toPath: enabledLocation(unit.path) };
  }
  return { willDisable: true, fromPath: unit.path, toPath: disabledLocation(unit.path, unit.isDirectory) };
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
      pruneOldBackups(settingsPath);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      suffix++;
      target = `${base}-${suffix}`;
    }
  }
}

/** How many settings backups to keep; older ones are removed after each new backup. */
const SETTINGS_BACKUPS_KEPT = 3;

/** Keeps only the newest SETTINGS_BACKUPS_KEPT backups so every plugin toggle doesn't leave
 *  another file behind in the tool's folder. Names sort by time (YYYYMMDD-HHMMSS, then any
 *  same-second "-N" suffix). Best effort: a backup that can't be removed is left alone. */
function pruneOldBackups(settingsPath: string): void {
  const prefix = `${basename(settingsPath)}.skillmanager-bak-`;
  const dir = dirname(settingsPath);
  const backups = readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .sort();
  for (const name of backups.slice(0, -SETTINGS_BACKUPS_KEPT)) {
    try {
      unlinkSync(join(dir, name));
    } catch {
      // Leave it; the next toggle tries again.
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
  setPluginEnabled(tool, pluginId, !currentlyEnabled);
}

/** Sets one `enabledPlugins` entry in the tool's settings file, the same way and with the same
 *  backup as togglePluginEnabled. Also how a plugin-dir or skills-folder mod is turned on or off,
 *  by its `<name>@inline` or `<name>@skills-dir` id, without moving or unlisting anything. */
export function setPluginEnabled(tool: ToolConfig, pluginId: string, enabled: boolean): void {
  if (!tool.pluginsSettingsPath) throw new Error(`${tool.name} has no known plugin settings file.`);
  const settingsPath = expandHome(tool.pluginsSettingsPath);
  if (!existsSync(settingsPath)) throw new Error(`${tool.name}'s settings file wasn't found at ${settingsPath}.`);

  backupSettingsFile(settingsPath);

  const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown> & {
    enabledPlugins?: Record<string, boolean>;
  };
  raw.enabledPlugins = { ...(raw.enabledPlugins ?? {}), [pluginId]: enabled };
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
    throw new Error(`"${item.name}" is part of an installed plugin. Remove the whole plugin from where it was installed instead.`);
  }
  const unit = linkableUnit(item.sourcePath);
  if (lstatSync(unit.path).isSymbolicLink()) {
    unlinkSync(unit.path);
    return;
  }
  await trash(unit.path);
}

/** Where Promote moves a finished mod: a folder the person keeps, outside every session's. */
export const FINISHED_MODS_DIR = "~/mods";

const PLUGIN_DIRS_ENV = "CLAUDE_CODE_PLUGIN_DIRS";

/** `~/...` for a path under the home folder, the form people write in settings.json by hand. */
export function tildify(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + sep) ? "~" + path.slice(home.length) : path;
}

/** Adds or removes one folder in CLAUDE_CODE_PLUGIN_DIRS, in the `env` block of the tool's user
 *  settings file, where every new session reads it. A value set only in the shell environment
 *  seeds the list when adding; removing from it is refused, since that isn't ours to edit. Backs
 *  the file up first, like togglePluginEnabled. A no-op when the folder is already as asked. */
export function setPluginDirListed(tool: ToolConfig, dir: string, listed: boolean): void {
  if (!tool.pluginsSettingsPath) throw new Error(`${tool.name} has no known settings file.`);
  const settingsPath = expandHome(tool.pluginsSettingsPath);
  if (!existsSync(settingsPath)) throw new Error(`${tool.name}'s settings file wasn't found at ${settingsPath}.`);

  const raw = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown> & { env?: Record<string, unknown> };
  const fromSettings = raw.env?.[PLUGIN_DIRS_ENV];
  if (fromSettings !== undefined && typeof fromSettings !== "string") throw new Error(`${PLUGIN_DIRS_ENV} in ${settingsPath} isn't a string.`);
  const current = fromSettings ?? process.env[PLUGIN_DIRS_ENV] ?? "";
  const entries = current.split(delimiter).map((p) => p.trim()).filter(Boolean);
  const target = resolve(expandHome(dir));
  const others = entries.filter((p) => resolve(expandHome(p)) !== target);
  if ((others.length !== entries.length) === listed) return;
  if (!listed && fromSettings === undefined) {
    throw new Error(`${PLUGIN_DIRS_ENV} is set in your shell environment, not ${settingsPath}. Remove the folder there.`);
  }

  backupSettingsFile(settingsPath);
  const next = listed ? [...entries, tildify(target)] : others;
  const env = { ...(raw.env ?? {}) };
  if (next.length > 0) env[PLUGIN_DIRS_ENV] = next.join(delimiter);
  else delete env[PLUGIN_DIRS_ENV];
  raw.env = env;
  writeFileSync(settingsPath, JSON.stringify(raw, null, 2) + "\n");
}

/** Moves a mod out of its session's dev folder into FINISHED_MODS_DIR and lists it in
 *  CLAUDE_CODE_PLUGIN_DIRS, so every new session loads it. Refuses rather than overwrite an
 *  existing folder there; moves the mod back if the settings file can't be updated. Returns the
 *  mod's new path. */
export function promoteDevMod(tool: ToolConfig, modPath: string): string {
  const target = join(expandHome(FINISHED_MODS_DIR), basename(modPath));
  if (existsSync(target)) throw new Error(`${target} already exists.`);
  mkdirSync(dirname(target), { recursive: true });
  renameSync(modPath, target);
  try {
    setPluginDirListed(tool, target, true);
  } catch (e) {
    renameSync(target, modPath);
    throw e;
  }
  return target;
}

/** Copies a mod folder (a fresh clone's, from Discover) into FINISHED_MODS_DIR/<name> and lists it
 *  in CLAUDE_CODE_PLUGIN_DIRS, like promoteDevMod but leaving the source alone and skipping .git.
 *  `name` is the mod's own plugin.json name; one that isn't a plain folder name is refused.
 *  Refuses rather than overwrite; removes the copy if the settings file can't be updated. Returns
 *  the installed path. */
export function installModFolder(tool: ToolConfig, sourceDir: string, name: string): string {
  if (!name || name !== basename(name) || name === "." || name === "..") throw new Error(`"${name}" can't be used as a folder name.`);
  const target = join(expandHome(FINISHED_MODS_DIR), name);
  if (existsSync(target)) throw new Error(`${target} already exists.`);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(sourceDir, target, { recursive: true, filter: (src) => basename(src) !== ".git" });
  try {
    setPluginDirListed(tool, target, true);
  } catch (e) {
    rmSync(target, { recursive: true, force: true });
    throw e;
  }
  return target;
}
