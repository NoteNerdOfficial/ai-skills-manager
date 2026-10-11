import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

import { findRepoManifests, readModPreview } from "./discover";

describe("findRepoManifests mods", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skillmanager-discover-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(path: string, text: string) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }

  function writeMod(dir: string, plugin: object, modules: unknown[] = ["./register.tsx"]) {
    write(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify(plugin));
    write(join(dir, "hooks", "hooks.json"), JSON.stringify({ modules }));
    write(join(dir, "hooks", "register.tsx"), "export const register = () => {};\n");
  }

  it("lists a mod as one entry, not the skills bundled inside it", () => {
    writeMod(join(root, "mods", "band"), { name: "band" });
    write(join(root, "mods", "band", "skills", "inner", "SKILL.md"), "---\nname: inner\n---\n");
    write(join(root, "skills", "outer", "SKILL.md"), "---\nname: outer\n---\n");
    const found = findRepoManifests(root).map((f) => [f.type, f.path]).sort();
    expect(found).toEqual([
      ["mod", join(root, "mods", "band")],
      ["skill", join(root, "skills", "outer", "SKILL.md")],
    ]);
  });

  it("treats a plugin without hooks modules as a plain folder and a repo-root mod as a mod", () => {
    write(join(root, "plain", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "plain" }));
    write(join(root, "plain", "hooks", "hooks.json"), JSON.stringify({ hooks: {} }));
    write(join(root, "plain", "skills", "s", "SKILL.md"), "---\nname: s\n---\n");
    expect(findRepoManifests(root).map((f) => f.type)).toEqual(["skill"]);

    const repo = join(root, "repo");
    writeMod(repo, { name: "rooted" });
    expect(findRepoManifests(repo)).toEqual([{ type: "mod", path: repo }]);
  });

  it("previews a mod from plugin.json, its README and its hooks modules", () => {
    const dir = join(root, "band");
    writeMod(dir, { name: "band", description: "A band", keywords: ["ui", 3] }, ["./register.tsx", "../../escape.ts"]);
    write(join(dir, "README.md"), "# Band\n");
    write(join(root, "escape.ts"), "secret");
    const preview = readModPreview(dir);
    expect(preview).toMatchObject({ name: "band", description: "A band", tags: ["ui"] });
    expect(preview.manifestText).toContain("# Band");
    expect(preview.manifestText).toContain("## hooks/register.tsx\n\n```tsx\nexport const register");
    expect(preview.manifestText).not.toContain("secret");
  });

  it("falls back to the folder name and widens the fence past backticks in the source", () => {
    const dir = join(root, "ticks");
    writeMod(dir, {});
    write(join(dir, "hooks", "register.tsx"), "const s = ```;\n");
    const preview = readModPreview(dir);
    expect(preview.name).toBe("ticks");
    expect(preview.manifestText).toContain("````tsx\n");
  });
});
