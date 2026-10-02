/** Local calendar day ("YYYY-MM-DD") -> number of sessions that used the item that day. */
export type DayCounts = Record<string, number>;

/** historyKey(tool, usageKey) -> that item's per-day session counts. Persisted in plugin data so
 *  the activity heatmap keeps history the tools themselves delete (Claude Code removes
 *  transcripts after 30 days by default). */
export type UsageHistory = Record<string, DayCounts>;

export const HEATMAP_WEEKS = 26;
/** A little over a year, so the 26-week view never loses data and the store can't grow forever. */
const HISTORY_RETENTION_DAYS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

export function historyKey(tool: string, usageKey: string): string {
  return `${tool}|${usageKey}`;
}

/** Local date rather than UTC, so a late-evening session lands on the day the user remembers. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Records one session file's usage. Each session counts once per day per item, however many
 *  times it invoked that item, so the heatmap shows sessions rather than raw calls. `seen` is
 *  per file, which is what makes the count per session. */
export function recordSessionDay(into: Map<string, DayCounts>, seen: Set<string>, key: string, ts: number): void {
  if (!ts) return;
  const day = dayKey(ts);
  const marker = `${key}\u0000${day}`;
  if (seen.has(marker)) return;
  seen.add(marker);
  const days = into.get(key) ?? {};
  days[day] = (days[day] ?? 0) + 1;
  into.set(key, days);
}

/** Folds a fresh transcript scan into the saved history. Takes the max per day: while a day's
 *  transcripts still exist the fresh count is complete, and once the tool deletes them the saved
 *  count is what's left, so neither direction loses data and re-running the merge is harmless.
 *  Returns whether anything changed so the caller can skip a needless save. */
export function mergeUsageHistory(
  history: UsageHistory,
  tool: string,
  fresh: Map<string, DayCounts>,
  nowMs = Date.now()
): boolean {
  let changed = false;
  for (const [usageKey, days] of fresh) {
    const key = historyKey(tool, usageKey);
    const saved = history[key] ?? (history[key] = {});
    for (const [day, count] of Object.entries(days)) {
      if ((saved[day] ?? 0) < count) {
        saved[day] = count;
        changed = true;
      }
    }
  }

  const cutoff = dayKey(nowMs - HISTORY_RETENTION_DAYS * DAY_MS);
  for (const [key, days] of Object.entries(history)) {
    for (const day of Object.keys(days)) {
      if (day < cutoff) {
        delete days[day];
        changed = true;
      }
    }
    if (Object.keys(days).length === 0) {
      delete history[key];
      changed = true;
    }
  }
  return changed;
}

export interface HeatmapCell {
  day: string;
  ms: number;
  count: number;
  /** After today: drawn empty, never counted. */
  future: boolean;
}

/** Columns of 7 days (Mon to Sun), oldest week first, ending with the week containing `nowMs`. */
export function buildHeatmap(days: DayCounts, nowMs = Date.now(), weeks = HEATMAP_WEEKS): { columns: HeatmapCell[][]; total: number } {
  const today = new Date(nowMs);
  today.setHours(12, 0, 0, 0);
  const mondayOffset = (today.getDay() + 6) % 7;
  const start = new Date(today);
  start.setDate(today.getDate() - mondayOffset - (weeks - 1) * 7);

  const todayKey = dayKey(nowMs);
  const columns: HeatmapCell[][] = [];
  let total = 0;
  const cursor = new Date(start);
  for (let w = 0; w < weeks; w++) {
    const column: HeatmapCell[] = [];
    for (let d = 0; d < 7; d++) {
      const day = dayKey(cursor.getTime());
      const future = day > todayKey;
      const count = future ? 0 : (days[day] ?? 0);
      total += count;
      column.push({ day, ms: cursor.getTime(), count, future });
      cursor.setDate(cursor.getDate() + 1);
    }
    columns.push(column);
  }
  return { columns, total };
}

/** 0 for no activity, otherwise 1-4 scaled to the busiest day in view, so a lightly used item
 *  still shows visible contrast between its busier and quieter days. */
export function heatLevel(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  return Math.max(1, Math.ceil((count / max) * 4));
}
