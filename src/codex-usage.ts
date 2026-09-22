import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { ItemMetadata } from "./types";
import { ClaudeUsageStats, usageKey } from "./claude-usage";

/** Codex CLI's on-disk session history. The layout is sessions/YYYY/MM/DD/*.jsonl. */
export const CODEX_SESSIONS_DIR = "~/.codex/sessions";

/** Recursively lists Codex session files without assuming a fixed date range. */
export function listCodexSessionFiles(sessionsDir: string): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      try {
        if (statSync(path).isDirectory()) visit(path);
        else if (entry.endsWith(".jsonl")) files.push(path);
      } catch {
        // A session can disappear while Codex is rotating history.
      }
    }
  };
  if (existsSync(sessionsDir)) visit(sessionsDir);
  return files;
}

function itemPathPattern(item: ItemMetadata): RegExp | null {
  if (item.tool !== "codex" || (item.type !== "skill" && item.type !== "agent")) return null;
  const folder = item.type === "skill" ? "skills" : "agents";
  const escapedName = item.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|/)\\.codex/${folder}/(?:[^\\s/"']+/)*${escapedName}(?:/|\\.md(?:[\\s"']|$)|[\\s"']|$)`, "i");
}

/**
 * Reads only tool-call input strings. Codex session files also contain the complete system
 * prompt and available-skill catalog; restricting this to tool calls avoids counting every
 * installed skill merely because it was advertised to the model.
 */
export function scanCodexSessionFile(
  filePath: string,
  items: ItemMetadata[],
  into: Map<string, ClaudeUsageStats>,
  sinceMs = 0
): void {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return;
  }

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type !== "response_item") continue;
    const payload = entry.payload as Record<string, unknown> | undefined;
    if (payload?.type !== "custom_tool_call") continue;
    const input = typeof payload.input === "string" ? payload.input : "";
    if (!input) continue;
    const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    const ts = Number.isNaN(timestamp) ? 0 : timestamp;

    for (const item of items) {
      const pattern = itemPathPattern(item);
      if (!pattern || !pattern.test(input)) continue;
      const key = usageKey(item.type as "skill" | "agent", item.name);
      const existing = into.get(key) ?? { count: 0, lastUsedMs: 0 };
      if (ts >= sinceMs) existing.count += 1;
      if (ts > existing.lastUsedMs) existing.lastUsedMs = ts;
      into.set(key, existing);
    }
  }
}

/** Joins raw name-keyed Codex activity to the discovered Codex items. */
export function computeCodexUsage(items: ItemMetadata[], rawUsage: Map<string, ClaudeUsageStats>): Map<string, ClaudeUsageStats> {
  const result = new Map<string, ClaudeUsageStats>();
  for (const item of items) {
    if (item.tool !== "codex" || (item.type !== "skill" && item.type !== "agent")) continue;
    result.set(item.entryId, rawUsage.get(usageKey(item.type, item.name)) ?? { count: 0, lastUsedMs: 0 });
  }
  return result;
}
