import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, resolve, sep } from "path";
import { expandHome, readPluginDirsEnv } from "./scanners";
import { ModEntry, ToolConfig } from "./types";

/** Something that stops a mod from loading as intended (Insights > Health). */
export type ModHealthIssue =
  | { kind: "missing-dir"; toolId: string; path: string }
  | { kind: "not-a-plugin"; toolId: string; path: string }
  | { kind: "missing-module"; mod: ModEntry; modules: string[] }
  | { kind: "duplicate"; name: string; mods: ModEntry[] };

/** A leftover worth removing (Insights > Cleanup). */
export type ModCleanupItem =
  | { kind: "promoted-copy"; dev: ModEntry; finished: ModEntry }
  | { kind: "empty-sessions"; toolId: string; paths: string[] };

/** A session folder this new may belong to a session that's about to write its first mod. */
const EMPTY_SESSION_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** hooks/hooks.json's module paths that don't resolve to a file inside the mod. */
function missingModules(modPath: string): string[] {
  let modules: unknown;
  try {
    modules = (JSON.parse(readFileSync(join(modPath, "hooks", "hooks.json"), "utf-8")) as { modules?: unknown }).modules;
  } catch {
    return [];
  }
  if (!Array.isArray(modules)) return [];
  const root = resolve(modPath);
  return modules.filter((m): m is string => {
    if (typeof m !== "string" || !m) return false;
    const file = resolve(root, "hooks", m);
    return !file.startsWith(root + sep) || !existsSync(file);
  });
}

/** Checks that need only the disk and the tool's settings, no session data:
 *  - a CLAUDE_CODE_PLUGIN_DIRS entry naming a folder that's gone, or one with no plugin manifest
 *  - a mod whose hooks.json names a module file that isn't there
 *  - two mods with the same name that both load in every session (dev copies only load in their
 *    own session, so a dev copy beside a finished one is a Cleanup item instead) */
export function findModHealthIssues(tools: ToolConfig[], mods: ModEntry[]): ModHealthIssue[] {
  const issues: ModHealthIssue[] = [];
  for (const tool of tools) {
    if (!tool.devModsPath) continue;
    for (const dir of readPluginDirsEnv(tool.pluginsSettingsPath)) {
      if (!existsSync(dir)) issues.push({ kind: "missing-dir", toolId: tool.id, path: dir });
      else if (!existsSync(join(dir, ".claude-plugin", "plugin.json"))) issues.push({ kind: "not-a-plugin", toolId: tool.id, path: dir });
    }
  }
  for (const mod of mods) {
    if (!mod.enabled) continue;
    const missing = missingModules(mod.path);
    if (missing.length > 0) issues.push({ kind: "missing-module", mod, modules: missing });
  }
  const global = new Map<string, ModEntry[]>();
  for (const mod of mods) {
    if (!mod.enabled || mod.origin === "dev") continue;
    const key = `${mod.toolId}\0${mod.name}`;
    global.set(key, [...(global.get(key) ?? []), mod]);
  }
  for (const group of global.values()) {
    if (group.length > 1) issues.push({ kind: "duplicate", name: group[0].name, mods: group });
  }
  return issues;
}

/** Dev copies of a mod that also exists finished (it was promoted or copied out by hand), and
 *  session folders under the dev mods folder with no mod left in them, older than a day. */
export function findModCleanup(tools: ToolConfig[], mods: ModEntry[], now = Date.now()): ModCleanupItem[] {
  const items: ModCleanupItem[] = [];
  for (const dev of mods) {
    if (dev.origin !== "dev") continue;
    const finished = mods.find((m) => m.origin !== "dev" && m.toolId === dev.toolId && m.name === dev.name);
    if (finished) items.push({ kind: "promoted-copy", dev, finished });
  }
  for (const tool of tools) {
    if (!tool.devModsPath) continue;
    const root = expandHome(tool.devModsPath);
    let sessions: string[];
    try {
      sessions = readdirSync(root).filter((name) => !name.startsWith("."));
    } catch {
      continue;
    }
    const empty = sessions
      .map((name) => join(root, name))
      .filter((dir) => {
        try {
          const stat = statSync(dir);
          if (!stat.isDirectory() || now - stat.mtimeMs < EMPTY_SESSION_MIN_AGE_MS) return false;
          return readdirSync(dir).every((name) => name.startsWith("."));
        } catch {
          return false;
        }
      });
    if (empty.length > 0) items.push({ kind: "empty-sessions", toolId: tool.id, paths: empty });
  }
  return items;
}
