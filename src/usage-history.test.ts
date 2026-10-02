import { describe, expect, it } from "vitest";
import { DayCounts, UsageHistory, buildHeatmap, dayKey, heatLevel, mergeUsageHistory, recordSessionDay } from "./usage-history";

const NOW = new Date(2026, 9, 2, 12).getTime(); // Fri Oct 2 2026, local time

describe("recordSessionDay", () => {
  it("counts a session once per day per item", () => {
    const days = new Map<string, DayCounts>();
    const seen = new Set<string>();
    recordSessionDay(days, seen, "skill:a", NOW);
    recordSessionDay(days, seen, "skill:a", NOW + 1000);
    recordSessionDay(days, new Set(), "skill:a", NOW);
    expect(days.get("skill:a")).toEqual({ [dayKey(NOW)]: 2 });
  });
});

describe("mergeUsageHistory", () => {
  it("keeps the larger count per day so deleted transcripts don't erase history", () => {
    const history: UsageHistory = { "claude-code|skill:a": { "2026-09-01": 3 } };
    const fresh = new Map<string, DayCounts>([["skill:a", { "2026-09-01": 1, "2026-09-02": 2 }]]);
    expect(mergeUsageHistory(history, "claude-code", fresh, NOW)).toBe(true);
    expect(history["claude-code|skill:a"]).toEqual({ "2026-09-01": 3, "2026-09-02": 2 });
    expect(mergeUsageHistory(history, "claude-code", fresh, NOW)).toBe(false);
  });

  it("drops days past retention and empty keys", () => {
    const history: UsageHistory = { "codex|skill:old": { "2024-01-01": 1 } };
    expect(mergeUsageHistory(history, "codex", new Map(), NOW)).toBe(true);
    expect(history).toEqual({});
  });
});

describe("buildHeatmap", () => {
  it("ends on the current week, Monday first, and totals only the window", () => {
    const { columns, total } = buildHeatmap({ [dayKey(NOW)]: 2, "2026-01-01": 9 }, NOW, 26);
    expect(columns).toHaveLength(26);
    expect(new Date(columns[0][0].ms).getDay()).toBe(1);
    const last = columns[25];
    expect(last[4].day).toBe(dayKey(NOW));
    expect(last[4].count).toBe(2);
    expect(last[5].future).toBe(true);
    expect(total).toBe(2);
  });
});

describe("heatLevel", () => {
  it("scales to the busiest day", () => {
    expect(heatLevel(0, 10)).toBe(0);
    expect(heatLevel(1, 10)).toBe(1);
    expect(heatLevel(10, 10)).toBe(4);
  });
});
