import { readFileSync, statSync } from "fs";
import { ItemMetadata } from "./types";

export interface DashboardMetric {
  item: ItemMetadata;
  charCount: number;
  mtimeMs: number;
}

export interface OverlapPair {
  a: ItemMetadata;
  b: ItemMetadata;
  score: number;
  /** Flagged by identical name rather than (or regardless of) description similarity — see
   *  isSameName. A row can be both; sameName just means it wasn't the score that got it in. */
  sameName: boolean;
}

/** Case-insensitive, trimmed name match, also requiring the same item type. Two items claiming
 *  the same name are an unambiguous overlap signal on their own — the name is effectively a
 *  skill's trigger id — independent of how differently their descriptions happen to be worded
 *  (e.g. a terse GitHub-installed one-liner vs. a detailed hand-written version of the "same"
 *  skill barely share any words, so Jaccard alone misses it; see OVERLAP_THRESHOLD's
 *  jaccard-on-descriptions callers). The type check matters because that trigger-id reading only
 *  holds within one type — an always-loaded rule and an on-demand skill that happen to share a
 *  name aren't actually competing for the same trigger. */
export function isSameName(a: ItemMetadata, b: ItemMetadata): boolean {
  return a.type === b.type && a.name.trim().toLowerCase() === b.name.trim().toLowerCase();
}

/** Reads each item's single representative file (its `sourcePath` — a multi-file skill's is its
 *  SKILL.md, same file the detail rail reads) to measure the context footprint it actually costs
 *  once loaded. An unreadable file (permissions, mid-move) is skipped rather than failing the
 *  whole dashboard. */
export function computeDashboardMetrics(items: ItemMetadata[]): DashboardMetric[] {
  const metrics: DashboardMetric[] = [];
  for (const item of items) {
    let charCount: number;
    try {
      charCount = readFileSync(item.sourcePath, "utf-8").length;
    } catch {
      continue;
    }
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(item.sourcePath).mtimeMs;
    } catch {
      // leave at 0
    }
    metrics.push({ item, charCount, mtimeMs });
  }
  return metrics;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

/** Self-scaling rather than a fixed byte threshold, which would be wrong for both a five-skill
 *  vault and a five-hundred-skill one: flags items in the top quartile of enabled context cost
 *  that also haven't been touched in a while — a free proxy for "probably not earning its keep,"
 *  without needing real invocation-usage tracking. */
export function findPruneCandidates(metrics: DashboardMetric[], staleDays = 90): DashboardMetric[] {
  if (metrics.length === 0) return [];
  const sortedSizes = metrics.map((m) => m.charCount).sort((a, b) => a - b);
  const sizeThreshold = percentile(sortedSizes, 0.75);
  const now = Date.now();
  const staleMs = staleDays * 24 * 60 * 60 * 1000;
  return metrics
    .filter((m) => m.charCount >= sizeThreshold && now - m.mtimeMs > staleMs)
    .sort((a, b) => b.charCount - a.charCount);
}

function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export const OVERLAP_THRESHOLD = 0.4;

/** The same name+description similarity score findOverlapPairs uses internally, exposed so a
 *  disabled item's dashboard "restore" row can find what it used to overlap with (that pair no
 *  longer exists in findOverlapPairs' output once one side is disabled). */
export function pairSimilarity(a: ItemMetadata, b: ItemMetadata): number {
  return jaccard(wordSet(`${a.name} ${a.description}`), wordSet(`${b.name} ${b.description}`));
}

/** Pairwise over enabled items only (O(n^2), fine at the tens-to-low-hundreds scale a vault's
 *  enabled skills/agents/commands/rules actually reach). Flags near-duplicate name+description
 *  text as a likely case of two items fighting over the same trigger conditions.
 *
 *  A skill symlinked into several projects (or into a project and left in the global library)
 *  shows up as one ItemMetadata per scope, all sharing the same name/description since they're
 *  the same file. Comparing those would flag "100% overlap" between something and itself under
 *  a different scope, not two genuinely different items, so pairs that resolve to the same real
 *  file (see ItemMetadata.realPath) are skipped. */
export function findOverlapPairs(items: ItemMetadata[], threshold = OVERLAP_THRESHOLD): OverlapPair[] {
  const sets = items.map((item) => wordSet(`${item.name} ${item.description}`));
  const pairs: OverlapPair[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[i].realPath === items[j].realPath) continue;
      const score = jaccard(sets[i], sets[j]);
      const sameName = isSameName(items[i], items[j]);
      if (sameName || score >= threshold) pairs.push({ a: items[i], b: items[j], score, sameName });
    }
  }
  // Same-name pairs first — a name collision is a certain signal, unlike a description score
  // that only crossed the threshold — then by score within each group.
  return pairs.sort((a, b) => Number(b.sameName) - Number(a.sameName) || b.score - a.score);
}
