import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkIntegrity } from "./integrity";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "integrity-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function skill(folder: string, content: string, tool = "claude-code") {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  const sourcePath = join(dir, "SKILL.md");
  writeFileSync(sourcePath, content);
  return { item: { type: "skill" as const, tool, sourcePath, realPath: sourcePath }, content };
}

describe("checkIntegrity", () => {
  it("passes a well-formed skill", () => {
    const { item, content } = skill("pdf-tools", "---\nname: pdf-tools\ndescription: Work with PDFs.\n---\nBody");
    expect(checkIntegrity(item, content)).toEqual([]);
  });

  it("flags missing and unclosed frontmatter", () => {
    expect(checkIntegrity(skill("a", "Just text").item, "Just text")).toEqual(["No frontmatter block"]);
    const unclosed = "---\nname: a\n";
    expect(checkIntegrity(skill("a", unclosed).item, unclosed)).toEqual(["Frontmatter block is never closed"]);
  });

  it("reports invalid YAML when a parser is supplied", () => {
    const { item, content } = skill("a", "---\nname: a\ndescription: x\n---\n");
    const failing = () => {
      throw new Error("bad");
    };
    expect(checkIntegrity(item, content, failing)[0]).toMatch(/valid YAML/);
  });

  it("flags a name that doesn't match its folder or the naming rules", () => {
    const { item, content } = skill("pdf", "---\nname: PDF Tools\ndescription: x\n---\n");
    const issues = checkIntegrity(item, content);
    expect(issues).toContain('Name "PDF Tools" doesn\'t match folder "pdf"');
    expect(issues.some((i) => i.startsWith("Name should be"))).toBe(true);
  });

  it("only requires a skill name outside Claude Code", () => {
    const text = "---\ndescription: x\n---\n";
    expect(checkIntegrity(skill("a", text).item, text)).toEqual([]);
    expect(checkIntegrity(skill("b", text, "codex").item, text)).toEqual(["Missing name"]);
  });

  it("skips the description check for manual-only skills", () => {
    const missing = "---\nname: a\n---\n";
    expect(checkIntegrity(skill("a", missing).item, missing)[0]).toMatch(/Missing description/);
    const manual = "---\nname: a\ndisable-model-invocation: true\n---\n";
    expect(checkIntegrity(skill("a", manual).item, manual)).toEqual([]);
  });

  it("flags an overlong description", () => {
    const text = `---\nname: a\ndescription: ${"x".repeat(1100)}\n---\n`;
    expect(checkIntegrity(skill("a", text).item, text)[0]).toMatch(/over 1,024/);
  });

  it("flags broken relative links but ignores URLs, anchors and code", () => {
    const body = [
      "---\nname: a\ndescription: x\n---",
      "[ok](scripts/run.py) [missing](reference/guide.md) [web](https://example.com) [top](#intro)",
      "`[inline](nope.md)`",
      "```\n[fenced](also-nope.md)\n```",
    ].join("\n");
    const { item } = skill("a", body);
    mkdirSync(join(root, "a", "scripts"));
    writeFileSync(join(root, "a", "scripts", "run.py"), "");
    expect(checkIntegrity(item, body)).toEqual(["Broken link: reference/guide.md"]);
  });

  it("flags a dangling symlink target", () => {
    const sourcePath = join(root, "link.md");
    symlinkSync(join(root, "gone.md"), sourcePath);
    const item = { type: "command" as const, tool: "claude-code", sourcePath, realPath: join(root, "gone.md") };
    expect(checkIntegrity(item, "")).toEqual(["Symlink target is missing"]);
  });
});
