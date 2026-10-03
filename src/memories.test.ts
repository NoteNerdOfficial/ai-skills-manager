import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DISABLED_DIRNAME } from "./itemToggle";
import { checkMemoryIndexed, forgetMemoryIndexEntry, isMemoryIndex, isMemoryItem, projectSlug, scanAllMemories, scanMemories, toggleMemoryEnabled } from "./memories";
import { ItemMetadata, ToolConfig } from "./types";

let root: string;
let tool: ToolConfig;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skillmanager-memories-"));
  tool = { id: "claude-code", name: "Claude Code", icon: "asterisk", paths: {}, memoryPath: root };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeMemory(dir: string, file: string, content = "---\nname: Note\ndescription: A note\n---\nBody") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), content);
}

function asMetadata(item: ReturnType<typeof scanMemories>[number]): ItemMetadata {
  return { ...item, tags: [], favorite: false, collections: [] };
}

describe("projectSlug", () => {
  it("swaps every non-alphanumeric character for a dash", () => {
    expect(projectSlug("/Users/me/my.app_x")).toBe("-Users-me-my-app-x");
  });
});

describe("scanMemories", () => {
  it("maps per-project memory folders to workspaces by slug, case-insensitively", () => {
    const projectPath = "/Users/me/Apps/demo";
    writeMemory(join(root, "-Users-me-Apps-demo", "memory"), "a.md");
    writeMemory(join(root, "-Users-me-Apps-demo", "memory"), "MEMORY.md", "- [A](a.md)\n");
    writeMemory(join(root, "-Users-me-other", "memory"), "b.md");

    const items = scanMemories(tool, [{ id: "p1", name: "demo", path: projectPath.toLowerCase() }]);
    expect(items.map((i) => [i.name, i.projectId]).sort()).toEqual([
      ["MEMORY", "p1"],
      ["Note", null],
      ["Note", "p1"],
    ]);
    expect(items.every((i) => i.type === "rule" && isMemoryItem(i, tool))).toBe(true);
  });

  it("treats a folder with no per-project subfolders as flat global memories", () => {
    writeMemory(root, "c.md");
    const items = scanMemories(tool, []);
    expect(items).toHaveLength(1);
    expect(items[0].projectId).toBeNull();
  });

  it("returns nothing when the path is cleared", () => {
    writeMemory(root, "c.md");
    expect(scanMemories({ ...tool, memoryPath: "" }, [])).toEqual([]);
  });
});

describe("project-scoped memories", () => {
  it("scans each workspace's in-repo memory folder and tags it with that workspace", () => {
    const project = { id: "p1", name: "demo", path: join(root, "repo") };
    writeMemory(join(project.path, ".tool", "memory"), "x.md");
    const scoped = { ...tool, memoryPath: "", projectMemoryPath: ".tool/memory" };
    const items = scanAllMemories([scoped], [project]);
    expect(items.map((i) => i.projectId)).toEqual(["p1"]);
    expect(isMemoryItem(items[0], scoped, [project])).toBe(true);
    expect(isMemoryItem(items[0], scoped, [])).toBe(false);
  });
});

describe("toggleMemoryEnabled", () => {
  it("removes the index line on disable and restores it verbatim on enable", () => {
    const dir = join(root, "-p", "memory");
    writeMemory(dir, "a.md");
    writeMemory(dir, "b.md");
    const index = "# Index\n- [Alpha title](a.md) — hook\n- [B](b.md)\n";
    writeFileSync(join(dir, "MEMORY.md"), index);

    const a = () => asMetadata(scanMemories(tool, []).find((i) => i.sourcePath.includes("a.md"))!);
    toggleMemoryEnabled(a());
    expect(readFileSync(join(dir, "MEMORY.md"), "utf-8")).toBe("# Index\n- [B](b.md)\n");
    expect(a().enabled).toBe(false);

    toggleMemoryEnabled(a());
    expect(readFileSync(join(dir, "MEMORY.md"), "utf-8")).toBe("# Index\n- [B](b.md)\n- [Alpha title](a.md) — hook\n");
    expect(a().enabled).toBe(true);
    expect(existsSync(join(dir, DISABLED_DIRNAME, "memory-index.json"))).toBe(false);
  });

  it("generates a pointer when re-enabling a memory with no saved line", () => {
    const dir = join(root, "-p", "memory");
    writeMemory(dir, "a.md");
    writeFileSync(join(dir, "MEMORY.md"), "");
    const a = () => asMetadata(scanMemories(tool, []).find((i) => !isMemoryIndex(i))!);
    toggleMemoryEnabled(a());
    toggleMemoryEnabled(a());
    expect(readFileSync(join(dir, "MEMORY.md"), "utf-8")).toBe("- [Note](a.md): A note\n");
  });
});

describe("forgetMemoryIndexEntry", () => {
  it("drops the deleted memory's index line", () => {
    const dir = join(root, "-p", "memory");
    writeMemory(dir, "a.md");
    writeFileSync(join(dir, "MEMORY.md"), "- [A](a.md)\n- [B](b.md)\n");
    const a = asMetadata(scanMemories(tool, []).find((i) => !isMemoryIndex(i))!);
    forgetMemoryIndexEntry(a);
    expect(readFileSync(join(dir, "MEMORY.md"), "utf-8")).toBe("- [B](b.md)\n");
  });
});

describe("checkMemoryIndexed", () => {
  it("flags an enabled memory its index doesn't link to", () => {
    const dir = join(root, "-p", "memory");
    writeMemory(dir, "a.md");
    writeFileSync(join(dir, "MEMORY.md"), "- [B](b.md)\n");
    expect(checkMemoryIndexed({ sourcePath: join(dir, "a.md"), enabled: true })).toHaveLength(1);
    writeFileSync(join(dir, "MEMORY.md"), "- [A](./a.md)\n");
    expect(checkMemoryIndexed({ sourcePath: join(dir, "a.md"), enabled: true })).toEqual([]);
  });
});
