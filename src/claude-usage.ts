import { existsSync, readFileSync, readdirSync, statSync, type Stats } from "fs";
import { join } from "path";
import { ItemMetadata } from "./types";

export interface ClaudeUsageStats {
  /** 0 = never invoked. */
  count: number;
  /** 0 = never invoked. */
  lastUsedMs: number;
}

/** Where Claude Code writes one JSONL transcript per session — the only tool this plugin manages
 *  that records real invocation history to disk (see the "why only Claude Code" note in
 *  scanTranscriptFile). */
export const CLAUDE_PROJECTS_DIR = "~/.claude/projects";

/** Distinct from dashboard.ts's 90-day mtime default — that's a conservative margin for a proxy
 *  signal (file-edit-time standing in for "still useful"); this is a real usage signal, so it
 *  doesn't need the same slack to be trustworthy. */
export const USAGE_STALE_DAYS = 30;

/** Window for rankTopUsedItems' "Top Skills & Agents" ranking — passed into scanTranscriptFile as
 *  a cutoff so `count` reflects recent invocations, not a lifetime total that never reflects
 *  declining usage. Distinct from USAGE_STALE_DAYS: lastUsedMs is always all-time (accurate
 *  recency for prune detection) regardless of this window. */
export const TOP_USED_WINDOW_DAYS = 90;

/** Per-file skip-guard so one abnormally large transcript can't blow out a single readFileSync
 *  call. The *global* budget across every file (see LibraryView's loadClaudeUsage) is the one
 *  that actually bounds worst-case cost at realistic transcript volumes. */
export const MAX_TRANSCRIPT_FILE_BYTES = 5 * 1024 * 1024;

export function usageKey(type: "skill" | "agent", name: string): string {
  return `${type}:${name}`;
}

/** Two-level walk: <projectsDir>/<project-dir>/<session>.jsonl — matches Claude Code's real
 *  on-disk layout (flat, no deeper nesting). Every readdirSync is try/catch-skipped so one
 *  unreadable/missing project directory never drops the rest, same convention as
 *  computeDashboardMetrics in dashboard.ts. */
export function listTranscriptFiles(projectsDir: string): string[] {
  const files: string[] = [];
  if (!existsSync(projectsDir)) return files;

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir);
  } catch {
    return files;
  }

  for (const dir of projectDirs) {
    const dirPath = join(projectsDir, dir);
    let entries: string[];
    try {
      if (!statSync(dirPath).isDirectory()) continue;
      entries = readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".jsonl")) files.push(join(dirPath, entry));
    }
  }
  return files;
}

/** Reads and parses one .jsonl file, mutating `into` in place (an accumulator, so the caller can
 *  yield between files without threading a growing return value through each call). Skips: an
 *  unreadable or oversized file, any line that isn't valid JSON, any line whose type isn't
 *  "assistant" — one bad file or line never breaks the whole scan.
 *
 *  Only Skill and Agent tool_use blocks carry a name reliably matching an ItemMetadata.name:
 *  `{"type":"tool_use","name":"Skill","input":{"skill":"<slug>"}}` and
 *  `{"type":"tool_use","name":"Agent","input":{"subagent_type":"<name>"}}` — confirmed against
 *  real transcripts. Slash commands expand into plain message text rather than a tool_use block
 *  (unconfirmed for custom commands, since none exist to observe), and rules are never invoked as
 *  a discrete event at all — both stay out of scope here by construction, not by an extra filter.
 *
 *  `sinceMs` (default 0, i.e. no cutoff) gates `count` only — an invocation older than the cutoff
 *  is skipped for counting purposes but still updates `lastUsedMs`, so a windowed count (for
 *  ranking "recently used") never makes an old-but-real invocation look like it never happened
 *  (staleness checks need the true last-used date, not a windowed one). */
export function scanTranscriptFile(filePath: string, into: Map<string, ClaudeUsageStats>, sinceMs = 0): void {
  let stats: Stats;
  try {
    stats = statSync(filePath);
  } catch {
    return;
  }
  if (stats.size > MAX_TRANSCRIPT_FILE_BYTES) return;

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
    if (entry.type !== "assistant") continue;

    const message = entry.message as { content?: unknown } | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) continue;

    const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    const ts = Number.isNaN(timestamp) ? 0 : timestamp;

    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_use") continue;
      const input = b.input as Record<string, unknown> | undefined;

      let key: string | null = null;
      if (b.name === "Skill" && typeof input?.skill === "string") {
        key = usageKey("skill", input.skill);
      } else if (b.name === "Agent" && typeof input?.subagent_type === "string") {
        key = usageKey("agent", input.subagent_type);
      }
      if (!key) continue;

      const existing = into.get(key) ?? { count: 0, lastUsedMs: 0 };
      if (ts >= sinceMs) existing.count += 1;
      if (ts > existing.lastUsedMs) existing.lastUsedMs = ts;
      into.set(key, existing);
    }
  }
}

/** Joins items (tool === "claude-code" && type is "skill" | "agent" — commands/rules have no
 *  usage signal, see scanTranscriptFile) against raw usageKey-keyed counts, keyed by entryId for
 *  direct cache lookup. Every matching item gets an entry, count 0 if it never showed up in
 *  rawUsage, so callers don't need a separate "was this item even checked" branch.
 *
 *  Duplicate entryIds sharing a name (the same skill symlinked into multiple project scopes)
 *  intentionally get the same stats — Claude Code's own invocation doesn't disambiguate scope, so
 *  there's no way to attribute a count to one scope over another. Expected, not a bug. */
/** A plugin-bundled skill/agent is invoked under a "<plugin-name>:<item-name>" key in the
 *  transcript, not the item's bare name — confirmed against a real transcript:
 *  {"name":"Skill","input":{"skill":"mattpocock-skills:prototype"}} for a "prototype" skill
 *  whose pluginId is "mattpocock-skills@claude-plugins-official". pluginId itself is
 *  "<plugin-name>@<marketplace>" (see scanAllPlugins/readInstalledPlugins), so only the part
 *  before "@" is the namespace Claude Code actually uses. */
function invocationName(item: ItemMetadata): string {
  return item.pluginId ? `${item.pluginId.split("@")[0]}:${item.name}` : item.name;
}

export function computeClaudeUsage(
  items: ItemMetadata[],
  rawUsage: Map<string, ClaudeUsageStats>
): Map<string, ClaudeUsageStats> {
  const result = new Map<string, ClaudeUsageStats>();
  for (const item of items) {
    if (item.tool !== "claude-code") continue;
    if (item.type !== "skill" && item.type !== "agent") continue;
    const key = usageKey(item.type, invocationName(item));
    result.set(item.entryId, rawUsage.get(key) ?? { count: 0, lastUsedMs: 0 });
  }
  return result;
}

/** "Never invoked, or not invoked in staleDays+." No size/percentile gate the way
 *  findPruneCandidates in dashboard.ts has — a real usage signal doesn't need a cost-based proxy
 *  to be trustworthy. Sorted least-used first (never-invoked items first, via lastUsedMs === 0
 *  sorting lowest), ties broken by lowest count. Only meaningful for items already present in
 *  usageByEntryId (i.e. claude-code skills/agents); anything else is silently ignored. */
export function findUsagePruneCandidates(
  items: ItemMetadata[],
  usageByEntryId: Map<string, ClaudeUsageStats>,
  staleDays = USAGE_STALE_DAYS
): { item: ItemMetadata; stats: ClaudeUsageStats }[] {
  const now = Date.now();
  const staleMs = staleDays * 24 * 60 * 60 * 1000;
  const flagged: { item: ItemMetadata; stats: ClaudeUsageStats }[] = [];
  for (const item of items) {
    const stats = usageByEntryId.get(item.entryId);
    if (!stats) continue;
    if (stats.lastUsedMs === 0 || now - stats.lastUsedMs > staleMs) flagged.push({ item, stats });
  }
  return flagged.sort((a, b) => a.stats.lastUsedMs - b.stats.lastUsedMs);
}

/** Ranked by invocation count, descending — skills and agents combined into one list (not split
 *  by type). Items with zero invocations are excluded; they surface in findUsagePruneCandidates
 *  instead, not here. Expects `usageByEntryId` to already be windowed (see TOP_USED_WINDOW_DAYS
 *  and the `sinceMs` param on scanTranscriptFile) — this function itself is window-agnostic, it
 *  just sorts and filters on whatever `count` it's handed. */
export function rankTopUsedItems(
  items: ItemMetadata[],
  usageByEntryId: Map<string, ClaudeUsageStats>
): { item: ItemMetadata; stats: ClaudeUsageStats }[] {
  const ranked: { item: ItemMetadata; stats: ClaudeUsageStats }[] = [];
  for (const item of items) {
    const stats = usageByEntryId.get(item.entryId);
    if (stats && stats.count > 0) ranked.push({ item, stats });
  }
  return ranked.sort((a, b) => b.stats.count - a.stats.count);
}
