import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeCodexUsage, listCodexSessionFiles, scanCodexSessionFile } from "./codex-usage";
import { ItemMetadata } from "./types";

function makeItem(overrides: Partial<ItemMetadata> & { sourcePath: string }): ItemMetadata {
  return {
    entryId: overrides.sourcePath,
    realPath: overrides.sourcePath,
    tool: "codex",
    type: "skill",
    projectId: null,
    pluginId: null,
    name: "review",
    description: "",
    enabled: true,
    tags: [],
    favorite: false,
    collections: [],
    ...overrides,
  };
}

function toolCallLine(input: string, timestamp = "2026-09-01T00:00:00Z"): string {
  return JSON.stringify({ timestamp, type: "response_item", payload: { type: "custom_tool_call", name: "exec", input } });
}

describe("Codex usage scanning", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skillmanager-codex-usage-test-"));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("recursively finds session JSONL files", () => {
    const day = join(root, "2026", "09", "01");
    const other = join(root, "2026", "09", "02");
    mkdirSync(day, { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(join(day, "a.jsonl"), "");
    writeFileSync(join(other, "b.jsonl"), "");
    expect(listCodexSessionFiles(root).sort()).toEqual([join(day, "a.jsonl"), join(other, "b.jsonl")].sort());
  });

  it("counts explicit Codex skill and agent file activity, but ignores the skill catalog", () => {
    const file = join(root, "session.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "review and deploy" }] } }),
        toolCallLine("cat /Users/me/.codex/skills/review/SKILL.md"),
        toolCallLine("cat /Users/me/.codex/agents/release-agent.md", "2026-09-02T00:00:00Z"),
        toolCallLine("cat /Users/me/.codex/skills/review-agent/SKILL.md", "2026-09-03T00:00:00Z"),
      ].join("\n")
    );
    const items = [
      makeItem({ sourcePath: "/skills/review/SKILL.md", name: "review" }),
      makeItem({ sourcePath: "/agents/release-agent.md", type: "agent", name: "release-agent" }),
    ];
    const raw = new Map<string, { count: number; lastUsedMs: number }>();
    scanCodexSessionFile(file, items, raw);
    const usage = computeCodexUsage(items, raw);
    expect(usage.get(items[0].entryId)?.count).toBe(1);
    expect(usage.get(items[1].entryId)?.count).toBe(1);
  });
});
