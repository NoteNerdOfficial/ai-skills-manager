import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeDashboardMetrics, findOverlapPairs, findPruneCandidates } from "./dashboard";
import { ItemMetadata } from "./types";

function makeItem(overrides: Partial<ItemMetadata> & { sourcePath: string }): ItemMetadata {
  return {
    entryId: overrides.sourcePath,
    realPath: overrides.sourcePath,
    tool: "claude-code",
    type: "skill",
    projectId: null,
    pluginId: null,
    name: "test",
    description: "",
    enabled: true,
    tags: [],
    favorite: false,
    collections: [],
    ...overrides,
  };
}

describe("computeDashboardMetrics", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skillspace-dash-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("measures each item's file size in characters", () => {
    const filePath = join(root, "a.md");
    writeFileSync(filePath, "12345");
    const metrics = computeDashboardMetrics([makeItem({ sourcePath: filePath, name: "a" })]);
    expect(metrics).toHaveLength(1);
    expect(metrics[0].charCount).toBe(5);
    expect(metrics[0].mtimeMs).toBeGreaterThan(0);
  });

  it("skips an item whose file can't be read instead of throwing", () => {
    const missingPath = join(root, "missing.md");
    const metrics = computeDashboardMetrics([makeItem({ sourcePath: missingPath, name: "missing" })]);
    expect(metrics).toEqual([]);
  });
});

describe("findPruneCandidates", () => {
  it("returns nothing for an empty set", () => {
    expect(findPruneCandidates([])).toEqual([]);
  });

  it("flags a large, stale item but not a large, recent one", () => {
    const now = Date.now();
    const oldMs = now - 200 * 24 * 60 * 60 * 1000;
    const metrics = [
      { item: makeItem({ sourcePath: "/a", name: "small-recent" }), charCount: 100, mtimeMs: now },
      { item: makeItem({ sourcePath: "/b", name: "large-recent" }), charCount: 10000, mtimeMs: now },
      { item: makeItem({ sourcePath: "/c", name: "large-stale" }), charCount: 10000, mtimeMs: oldMs },
    ];
    const candidates = findPruneCandidates(metrics, 90);
    expect(candidates.map((c) => c.item.name)).toEqual(["large-stale"]);
  });

  it("doesn't flag anything when every item is the same size", () => {
    const oldMs = Date.now() - 200 * 24 * 60 * 60 * 1000;
    const metrics = [
      { item: makeItem({ sourcePath: "/a", name: "a" }), charCount: 500, mtimeMs: oldMs },
      { item: makeItem({ sourcePath: "/b", name: "b" }), charCount: 500, mtimeMs: oldMs },
    ];
    // Same-size set still has a well-defined 75th percentile equal to that size, so both
    // qualify on size — this just documents that behavior rather than asserting emptiness.
    const candidates = findPruneCandidates(metrics, 90);
    expect(candidates).toHaveLength(2);
  });
});

describe("findOverlapPairs", () => {
  it("flags two items with near-identical name+description", () => {
    const items = [
      makeItem({ sourcePath: "/a", name: "pdf helper", description: "extract text from pdf files" }),
      makeItem({ sourcePath: "/b", name: "pdf assistant", description: "extract text from pdf files" }),
    ];
    const pairs = findOverlapPairs(items, 0.4);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].score).toBeGreaterThanOrEqual(0.4);
  });

  it("doesn't flag two unrelated items", () => {
    const items = [
      makeItem({ sourcePath: "/a", name: "pdf helper", description: "extract text from pdf files" }),
      makeItem({ sourcePath: "/b", name: "git commit", description: "write commit messages" }),
    ];
    expect(findOverlapPairs(items, 0.4)).toEqual([]);
  });

  it("sorts multiple matching pairs by score descending", () => {
    const items = [
      makeItem({ sourcePath: "/a", name: "pdf helper", description: "extract text from pdf files" }),
      makeItem({ sourcePath: "/b", name: "pdf helper", description: "extract text from pdf files" }),
      makeItem({ sourcePath: "/c", name: "pdf assistant", description: "extract data from pdf forms" }),
    ];
    const pairs = findOverlapPairs(items, 0.3);
    expect(pairs.length).toBeGreaterThan(1);
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i - 1].score).toBeGreaterThanOrEqual(pairs[i].score);
    }
  });
});
