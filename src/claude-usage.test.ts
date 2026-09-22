import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ClaudeUsageStats,
  computeClaudeUsage,
  findUsagePruneCandidates,
  listTranscriptFiles,
  rankTopUsedItems,
  scanTranscriptFile,
  usageKey,
} from "./claude-usage";
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

function assistantLine(timestamp: string, toolUse: { name: string; input: Record<string, unknown> }): string {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    message: { content: [{ type: "tool_use", name: toolUse.name, input: toolUse.input }] },
  });
}

describe("listTranscriptFiles", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skillmanager-claude-usage-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("walks project-dir -> session.jsonl, two levels, ignoring non-.jsonl files", () => {
    mkdirSync(join(root, "proj-a"));
    writeFileSync(join(root, "proj-a", "session-1.jsonl"), "");
    mkdirSync(join(root, "proj-b"));
    writeFileSync(join(root, "proj-b", "session-2.jsonl"), "");
    writeFileSync(join(root, "proj-b", "notes.txt"), "");

    expect(listTranscriptFiles(root).sort()).toEqual(
      [join(root, "proj-a", "session-1.jsonl"), join(root, "proj-b", "session-2.jsonl")].sort()
    );
  });

  it("returns an empty list rather than throwing when the projects dir doesn't exist", () => {
    expect(listTranscriptFiles(join(root, "missing"))).toEqual([]);
  });
});

describe("scanTranscriptFile", () => {
  let root: string;
  let file: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skillmanager-claude-usage-test-"));
    file = join(root, "session.jsonl");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("counts a Skill tool_use block, keyed by input.skill", () => {
    writeFileSync(file, assistantLine("2026-01-01T00:00:00Z", { name: "Skill", input: { skill: "pdf-helper" } }));
    const usage = new Map<string, ClaudeUsageStats>();
    scanTranscriptFile(file, usage);
    expect(usage.get(usageKey("skill", "pdf-helper"))).toEqual({ count: 1, lastUsedMs: Date.parse("2026-01-01T00:00:00Z") });
  });

  it("counts an Agent tool_use block, keyed by input.subagent_type", () => {
    writeFileSync(file, assistantLine("2026-01-01T00:00:00Z", { name: "Agent", input: { subagent_type: "code-reviewer" } }));
    const usage = new Map<string, ClaudeUsageStats>();
    scanTranscriptFile(file, usage);
    expect(usage.get(usageKey("agent", "code-reviewer"))).toEqual({ count: 1, lastUsedMs: Date.parse("2026-01-01T00:00:00Z") });
  });

  it("accumulates count and keeps the latest timestamp across multiple lines", () => {
    const lines = [
      assistantLine("2026-01-01T00:00:00Z", { name: "Skill", input: { skill: "pdf-helper" } }),
      assistantLine("2026-01-03T00:00:00Z", { name: "Skill", input: { skill: "pdf-helper" } }),
      assistantLine("2026-01-02T00:00:00Z", { name: "Skill", input: { skill: "pdf-helper" } }),
    ];
    writeFileSync(file, lines.join("\n"));
    const usage = new Map<string, ClaudeUsageStats>();
    scanTranscriptFile(file, usage);
    expect(usage.get(usageKey("skill", "pdf-helper"))).toEqual({ count: 3, lastUsedMs: Date.parse("2026-01-03T00:00:00Z") });
  });

  it("ignores non-assistant lines", () => {
    const lines = [
      JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00Z", message: { content: "hi" } }),
      assistantLine("2026-01-01T00:00:00Z", { name: "Skill", input: { skill: "pdf-helper" } }),
    ];
    writeFileSync(file, lines.join("\n"));
    const usage = new Map<string, ClaudeUsageStats>();
    scanTranscriptFile(file, usage);
    expect(usage.size).toBe(1);
  });

  it("skips a malformed JSON line without throwing, and still processes the rest of the file", () => {
    const lines = ["not json", assistantLine("2026-01-01T00:00:00Z", { name: "Skill", input: { skill: "pdf-helper" } })];
    writeFileSync(file, lines.join("\n"));
    const usage = new Map<string, ClaudeUsageStats>();
    expect(() => scanTranscriptFile(file, usage)).not.toThrow();
    expect(usage.get(usageKey("skill", "pdf-helper"))?.count).toBe(1);
  });

  it("skips an unreadable/missing file without throwing", () => {
    const usage = new Map<string, ClaudeUsageStats>();
    expect(() => scanTranscriptFile(join(root, "missing.jsonl"), usage)).not.toThrow();
    expect(usage.size).toBe(0);
  });

  it("skips a file over MAX_TRANSCRIPT_FILE_BYTES", () => {
    writeFileSync(file, "x".repeat(6 * 1024 * 1024));
    const usage = new Map<string, ClaudeUsageStats>();
    scanTranscriptFile(file, usage);
    expect(usage.size).toBe(0);
  });

  it("ignores a built-in subagent_type the same way as any other name — matching happens in computeClaudeUsage, not here", () => {
    writeFileSync(file, assistantLine("2026-01-01T00:00:00Z", { name: "Agent", input: { subagent_type: "Explore" } }));
    const usage = new Map<string, ClaudeUsageStats>();
    scanTranscriptFile(file, usage);
    expect(usage.get(usageKey("agent", "Explore"))?.count).toBe(1);
  });

  it("with a sinceMs cutoff, excludes an older invocation from count but still tracks it in lastUsedMs", () => {
    const lines = [
      assistantLine("2026-01-01T00:00:00Z", { name: "Skill", input: { skill: "pdf-helper" } }),
      assistantLine("2026-03-01T00:00:00Z", { name: "Skill", input: { skill: "pdf-helper" } }),
    ];
    writeFileSync(file, lines.join("\n"));
    const usage = new Map<string, ClaudeUsageStats>();
    scanTranscriptFile(file, usage, Date.parse("2026-02-01T00:00:00Z"));
    expect(usage.get(usageKey("skill", "pdf-helper"))).toEqual({
      count: 1,
      lastUsedMs: Date.parse("2026-03-01T00:00:00Z"),
    });
  });

  it("with a sinceMs cutoff, an item invoked only before the cutoff gets lastUsedMs but zero count", () => {
    writeFileSync(file, assistantLine("2026-01-01T00:00:00Z", { name: "Skill", input: { skill: "pdf-helper" } }));
    const usage = new Map<string, ClaudeUsageStats>();
    scanTranscriptFile(file, usage, Date.parse("2026-02-01T00:00:00Z"));
    expect(usage.get(usageKey("skill", "pdf-helper"))).toEqual({
      count: 0,
      lastUsedMs: Date.parse("2026-01-01T00:00:00Z"),
    });
  });
});

describe("computeClaudeUsage", () => {
  it("only includes claude-code skill/agent items, keyed by entryId", () => {
    const items = [
      makeItem({ sourcePath: "/a", entryId: "a", tool: "claude-code", type: "skill", name: "pdf-helper" }),
      makeItem({ sourcePath: "/b", entryId: "b", tool: "claude-code", type: "command", name: "deploy" }),
      makeItem({ sourcePath: "/c", entryId: "c", tool: "cursor", type: "skill", name: "pdf-helper" }),
    ];
    const raw = new Map([[usageKey("skill", "pdf-helper"), { count: 3, lastUsedMs: 100 }]]);
    const usage = computeClaudeUsage(items, raw);
    expect(usage.size).toBe(1);
    expect(usage.get("a")).toEqual({ count: 3, lastUsedMs: 100 });
  });

  it("gives a matching item with no raw usage a zero-stats entry, not an absent one", () => {
    const items = [makeItem({ sourcePath: "/a", entryId: "a", tool: "claude-code", type: "skill", name: "unused-skill" })];
    const usage = computeClaudeUsage(items, new Map());
    expect(usage.get("a")).toEqual({ count: 0, lastUsedMs: 0 });
  });

  it("matches a plugin-bundled skill under its \"<plugin-name>:<name>\" transcript key, not its bare name", () => {
    const items = [
      makeItem({
        sourcePath: "/a",
        entryId: "a",
        tool: "claude-code",
        type: "skill",
        name: "prototype",
        pluginId: "mattpocock-skills@claude-plugins-official",
      }),
    ];
    const raw = new Map([[usageKey("skill", "mattpocock-skills:prototype"), { count: 4, lastUsedMs: 100 }]]);
    const usage = computeClaudeUsage(items, raw);
    expect(usage.get("a")).toEqual({ count: 4, lastUsedMs: 100 });
  });

  it("gives duplicate entryIds sharing a name (symlinked scopes) the same stats", () => {
    const items = [
      makeItem({ sourcePath: "/a", entryId: "a", tool: "claude-code", type: "skill", name: "shared-skill" }),
      makeItem({ sourcePath: "/b", entryId: "b", tool: "claude-code", type: "skill", name: "shared-skill" }),
    ];
    const raw = new Map([[usageKey("skill", "shared-skill"), { count: 5, lastUsedMs: 200 }]]);
    const usage = computeClaudeUsage(items, raw);
    expect(usage.get("a")).toEqual(usage.get("b"));
  });
});

describe("findUsagePruneCandidates", () => {
  const staleMs = 31 * 24 * 60 * 60 * 1000;

  it("flags a never-invoked item", () => {
    const items = [makeItem({ sourcePath: "/a", entryId: "a" })];
    const usage = new Map([["a", { count: 0, lastUsedMs: 0 }]]);
    expect(findUsagePruneCandidates(items, usage)).toHaveLength(1);
  });

  it("flags an item last invoked 31+ days ago", () => {
    const items = [makeItem({ sourcePath: "/a", entryId: "a" })];
    const usage = new Map([["a", { count: 4, lastUsedMs: Date.now() - staleMs }]]);
    expect(findUsagePruneCandidates(items, usage)).toHaveLength(1);
  });

  it("does not flag an item invoked within the stale window", () => {
    const items = [makeItem({ sourcePath: "/a", entryId: "a" })];
    const usage = new Map([["a", { count: 4, lastUsedMs: Date.now() - 1000 }]]);
    expect(findUsagePruneCandidates(items, usage)).toEqual([]);
  });

  it("ignores an item absent from usageByEntryId (not a claude-code skill/agent)", () => {
    const items = [makeItem({ sourcePath: "/a", entryId: "a" })];
    expect(findUsagePruneCandidates(items, new Map())).toEqual([]);
  });
});

describe("rankTopUsedItems", () => {
  it("ranks skill and agent items together by count descending", () => {
    const items = [
      makeItem({ sourcePath: "/a", entryId: "a", type: "skill", name: "low" }),
      makeItem({ sourcePath: "/b", entryId: "b", type: "agent", name: "high" }),
    ];
    const usage = new Map([
      ["a", { count: 2, lastUsedMs: 100 }],
      ["b", { count: 9, lastUsedMs: 200 }],
    ]);
    const ranked = rankTopUsedItems(items, usage);
    expect(ranked.map((r) => r.item.entryId)).toEqual(["b", "a"]);
  });

  it("excludes zero-count items", () => {
    const items = [makeItem({ sourcePath: "/a", entryId: "a" })];
    const usage = new Map([["a", { count: 0, lastUsedMs: 0 }]]);
    expect(rankTopUsedItems(items, usage)).toEqual([]);
  });
});
