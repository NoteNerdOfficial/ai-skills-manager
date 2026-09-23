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
    root = mkdtempSync(join(tmpdir(), "skillmanager-dash-test-"));
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
    expect(metrics[0].alwaysAvailableCharCount).toBe("a\n".length);
    expect(metrics[0].invocationCharCount).toBe(5);
    expect(metrics[0].mtimeMs).toBeGreaterThan(0);
  });

  it("separates skill metadata from the instruction body", () => {
    const filePath = join(root, "SKILL.md");
    const content = "---\nname: review\ndescription: Review changes\n---\n\nRead the diff carefully.";
    writeFileSync(filePath, content, { encoding: "utf-8", flag: "w" });
    const metrics = computeDashboardMetrics([makeItem({ sourcePath: filePath, name: "review", description: "Review changes" })]);
    expect(metrics[0].alwaysAvailableCharCount).toBe("review\nReview changes".length);
    expect(metrics[0].invocationCharCount).toBe("\nRead the diff carefully.".length);
  });

  it("does not claim a universal context cost for commands and rules", () => {
    const filePath = join(root, "command.md");
    writeFileSync(filePath, "---\nname: deploy\n---\nRun deploy.");
    const metrics = computeDashboardMetrics([makeItem({ sourcePath: filePath, type: "command", name: "deploy" })]);
    expect(metrics[0].alwaysAvailableCharCount).toBeNull();
    expect(metrics[0].invocationCharCount).toBeNull();
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
      { item: makeItem({ sourcePath: "/a", name: "small-recent" }), charCount: 100, alwaysAvailableCharCount: null, invocationCharCount: null, mtimeMs: now },
      { item: makeItem({ sourcePath: "/b", name: "large-recent" }), charCount: 10000, alwaysAvailableCharCount: null, invocationCharCount: null, mtimeMs: now },
      { item: makeItem({ sourcePath: "/c", name: "large-stale" }), charCount: 10000, alwaysAvailableCharCount: null, invocationCharCount: null, mtimeMs: oldMs },
    ];
    const candidates = findPruneCandidates(metrics, 90);
    expect(candidates.map((c) => c.item.name)).toEqual(["large-stale"]);
  });

  it("doesn't flag anything when every item is the same size", () => {
    const oldMs = Date.now() - 200 * 24 * 60 * 60 * 1000;
    const metrics = [
      { item: makeItem({ sourcePath: "/a", name: "a" }), charCount: 500, alwaysAvailableCharCount: null, invocationCharCount: null, mtimeMs: oldMs },
      { item: makeItem({ sourcePath: "/b", name: "b" }), charCount: 500, alwaysAvailableCharCount: null, invocationCharCount: null, mtimeMs: oldMs },
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

  it("doesn't flag the same file linked into two scopes (e.g. global + a project) as an overlap", () => {
    const items = [
      makeItem({ sourcePath: "/global/pdf-helper/SKILL.md", realPath: "/real/pdf-helper/SKILL.md", name: "pdf helper", description: "extract text from pdf files" }),
      makeItem({ sourcePath: "/project-a/.claude/skills/pdf-helper/SKILL.md", realPath: "/real/pdf-helper/SKILL.md", name: "pdf helper", description: "extract text from pdf files" }),
    ];
    expect(findOverlapPairs(items, 0.4)).toEqual([]);
  });

  it("flags two items with the same name even when their descriptions barely overlap", () => {
    const items = [
      makeItem({
        sourcePath: "/a",
        name: "defuddle",
        description:
          "Extract clean markdown content from web pages using Defuddle CLI, removing clutter and navigation to save tokens. Use instead of WebFetch when the user provides a URL to read or analyze, for online documentation, articles, blog posts, or any standard web page.",
      }),
      makeItem({ sourcePath: "/b", name: "defuddle", description: "Extract clean Markdown from HTML pages with Defuddle CLI." }),
    ];
    const pairs = findOverlapPairs(items, 0.4);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].sameName).toBe(true);
    expect(pairs[0].score).toBeLessThan(0.4);
  });

  it("doesn't mark a description-only match as sameName", () => {
    const items = [
      makeItem({ sourcePath: "/a", name: "pdf helper", description: "extract text from pdf files" }),
      makeItem({ sourcePath: "/b", name: "pdf assistant", description: "extract text from pdf files" }),
    ];
    const pairs = findOverlapPairs(items, 0.4);
    expect(pairs[0].sameName).toBe(false);
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
