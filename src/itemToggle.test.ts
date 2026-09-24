import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DISABLED_DIRNAME, TrashFn, deleteItem, previewToggle, toggleItemEnabled, togglePluginEnabled } from "./itemToggle";
import { ItemMetadata, ToolConfig } from "./types";

// vi.spyOn can't redefine a property on Node's own "fs" ESM namespace object ("Module namespace
// is not configurable in ESM"), so proving deleteItem never falls back to a direct rmSync goes
// through a real module mock instead — vi.hoisted keeps this control reachable from inside the
// (hoisted-to-the-top) vi.mock factory below.
const { rmSyncCalls } = vi.hoisted(() => ({
  rmSyncCalls: [] as unknown[][],
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      rmSyncCalls.push(args);
      return actual.rmSync(...args);
    },
  };
});

/** Fails the test loudly if deleteItem ever reaches for the real OS trash during a symlink
 *  delete — see the "removes only the link" test below. */
const unreachableTrash: TrashFn = () => {
  throw new Error("trash() should never be called for a symlink delete");
};

/** Stands in for the real Electron shell.trashItem in tests that only care that deleteItem moved
 *  the right path out of its original location — actually removes it, same observable effect a
 *  real trash call has on the original location. */
const fakeTrashThatRemoves: TrashFn = async (path) => {
  rmSync(path, { recursive: true, force: true });
};

function makeItem(sourcePath: string): ItemMetadata {
  return {
    entryId: "test-entry",
    sourcePath,
    realPath: sourcePath,
    tool: "claude-code",
    type: "agent",
    projectId: null,
    pluginId: null,
    name: "test",
    description: "",
    enabled: true,
    tags: [],
    favorite: false,
    collections: [],
  };
}

describe("toggleItemEnabled / deleteItem", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skillmanager-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("disables a flat file by moving it into a sibling .skillmanager-disabled folder", () => {
    const filePath = join(root, "backend.md");
    writeFileSync(filePath, "content");

    toggleItemEnabled(makeItem(filePath));

    expect(existsSync(filePath)).toBe(false);
    const disabledPath = join(root, DISABLED_DIRNAME, "backend.md");
    expect(existsSync(disabledPath)).toBe(true);
  });

  it("re-enables a disabled flat file by moving it back", () => {
    const filePath = join(root, "backend.md");
    writeFileSync(filePath, "content");
    const item = makeItem(filePath);

    toggleItemEnabled(item); // disable
    const disabledPath = join(root, DISABLED_DIRNAME, "backend.md");
    toggleItemEnabled(makeItem(disabledPath)); // re-enable

    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(disabledPath)).toBe(false);
  });

  it("disables a skill folder (SKILL.md's containing directory) as a unit", () => {
    const skillDir = join(root, "pdf-editing");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: pdf-editing\n---\n");
    writeFileSync(join(skillDir, "helper.py"), "print(1)");

    toggleItemEnabled(makeItem(join(skillDir, "SKILL.md")));

    expect(existsSync(skillDir)).toBe(false);
    const disabledDir = join(root, DISABLED_DIRNAME, "pdf-editing");
    expect(existsSync(join(disabledDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(disabledDir, "helper.py"))).toBe(true);
  });

  it("throws rather than clobbering an existing file when disabling twice", () => {
    const filePath = join(root, "backend.md");
    writeFileSync(filePath, "content");
    mkdirSync(join(root, DISABLED_DIRNAME));
    writeFileSync(join(root, DISABLED_DIRNAME, "backend.md"), "already disabled, different content");

    expect(() => toggleItemEnabled(makeItem(filePath))).toThrow(/already disabled/);
    // The pre-existing disabled copy must survive untouched.
    expect(existsSync(filePath)).toBe(true);
  });

  it("throws rather than clobbering an existing file when re-enabling onto a conflict", () => {
    const disabledDir = join(root, DISABLED_DIRNAME);
    mkdirSync(disabledDir);
    const disabledPath = join(disabledDir, "backend.md");
    writeFileSync(disabledPath, "disabled content");
    writeFileSync(join(root, "backend.md"), "already enabled, different content");

    expect(() => toggleItemEnabled(makeItem(disabledPath))).toThrow(/already exists/);
    expect(existsSync(disabledPath)).toBe(true);
  });

  it("re-targets a relative symlink to an absolute path when moving a flat file, so it never dangles", () => {
    // Mirrors a project-scoped instance: a symlink one level under the project's tool folder
    // pointing back at a global skill via a relative "../../" path. Moving it into a nested
    // .skillmanager-disabled folder changes its depth, which would break a naive rename.
    const globalTarget = join(root, "global-target.md");
    writeFileSync(globalTarget, "content");

    const projectDir = join(root, "project", "agents");
    mkdirSync(projectDir, { recursive: true });
    const linkPath = join(projectDir, "backend.md");
    symlinkSync("../../global-target.md", linkPath, "file");
    expect(readlinkSync(linkPath)).toBe("../../global-target.md");

    toggleItemEnabled(makeItem(linkPath));

    const disabledLinkPath = join(projectDir, DISABLED_DIRNAME, "backend.md");
    expect(lstatSync(disabledLinkPath).isSymbolicLink()).toBe(true);
    // The relative form would now resolve to the wrong place (one directory deeper) — the
    // absolute rewrite is what keeps this pointing at the real file.
    expect(readlinkSync(disabledLinkPath)).toBe(globalTarget);
    expect(existsSync(disabledLinkPath)).toBe(true); // resolves and the target is readable
  });

  it("re-targets a symlinked skill directory the same way", () => {
    const globalSkillDir = join(root, "global-skills", "pdf-editing");
    mkdirSync(globalSkillDir, { recursive: true });
    writeFileSync(join(globalSkillDir, "SKILL.md"), "manifest");

    const projectDir = join(root, "project", "skills");
    mkdirSync(projectDir, { recursive: true });
    const linkPath = join(projectDir, "pdf-editing");
    symlinkSync("../../global-skills/pdf-editing", linkPath, "dir");

    toggleItemEnabled(makeItem(join(linkPath, "SKILL.md")));

    const disabledLinkPath = join(projectDir, DISABLED_DIRNAME, "pdf-editing");
    expect(lstatSync(disabledLinkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(disabledLinkPath)).toBe(globalSkillDir);
    expect(existsSync(join(disabledLinkPath, "SKILL.md"))).toBe(true);
  });

  it("moves only the selected link when multiple links share one target", () => {
    const target = join(root, "shared", "review.md");
    mkdirSync(join(root, "shared"), { recursive: true });
    writeFileSync(target, "content");
    const claudeLink = join(root, "claude", "review.md");
    const codexLink = join(root, "codex", "review.md");
    mkdirSync(dirname(claudeLink), { recursive: true });
    mkdirSync(dirname(codexLink), { recursive: true });
    symlinkSync(target, claudeLink, "file");
    symlinkSync(target, codexLink, "file");

    toggleItemEnabled(makeItem(claudeLink));

    expect(existsSync(join(root, "claude", DISABLED_DIRNAME, "review.md"))).toBe(true);
    expect(lstatSync(codexLink).isSymbolicLink()).toBe(true);
    expect(readFileSync(codexLink, "utf-8")).toBe("content");
    expect(readFileSync(target, "utf-8")).toBe("content");
  });

  it("refuses to delete a plugin-bundled item, leaving the file untouched", async () => {
    const filePath = join(root, "ask-matt.md");
    writeFileSync(filePath, "content");
    const item = { ...makeItem(filePath), pluginId: "mattpocock-skills@claude-plugins-official" };

    await expect(deleteItem(item, fakeTrashThatRemoves)).rejects.toThrow(/installed plugin/);
    expect(existsSync(filePath)).toBe(true);
  });

  it("deleteItem moves a flat file out via the injected trash function", async () => {
    const filePath = join(root, "backend.md");
    writeFileSync(filePath, "content");
    await deleteItem(makeItem(filePath), fakeTrashThatRemoves);
    expect(existsSync(filePath)).toBe(false);
  });

  it("deleteItem moves a skill folder out via the injected trash function, recursively", async () => {
    const skillDir = join(root, "pdf-editing");
    mkdirSync(join(skillDir, "scripts"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "manifest");
    writeFileSync(join(skillDir, "scripts", "helper.py"), "print(1)");

    await deleteItem(makeItem(join(skillDir, "SKILL.md")), fakeTrashThatRemoves);

    expect(existsSync(skillDir)).toBe(false);
  });

  it("deleteItem calls the injected trash function with the real path, never rmSync directly", async () => {
    const skillDir = join(root, "pdf-editing");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), "manifest");
    rmSyncCalls.length = 0;
    // Deliberately does NOT touch the filesystem — proves deleteItem itself never falls back to
    // a direct rmSync/rm when the trash function is the one actually responsible for the move,
    // and that the real unit path (not some other path) was handed to it.
    const trash: TrashFn = vi.fn(async () => {});

    await deleteItem(makeItem(join(skillDir, "SKILL.md")), trash);

    expect(trash).toHaveBeenCalledWith(skillDir);
    expect(trash).toHaveBeenCalledTimes(1);
    expect(rmSyncCalls).toEqual([]);
    expect(existsSync(skillDir)).toBe(true); // the fake trash fn never actually removed it
  });

  it("deleteItem throws and leaves the folder in place when the trash function rejects", async () => {
    const skillDir = join(root, "pdf-editing");
    mkdirSync(skillDir);
    writeFileSync(join(skillDir, "SKILL.md"), "manifest");
    const rejectingTrash: TrashFn = async () => {
      throw new Error("trash unavailable");
    };

    await expect(deleteItem(makeItem(join(skillDir, "SKILL.md")), rejectingTrash)).rejects.toThrow("trash unavailable");

    expect(existsSync(skillDir)).toBe(true);
  });

  it("refuses to toggle a plugin-bundled item individually, leaving the file untouched", () => {
    const filePath = join(root, "ask-matt.md");
    writeFileSync(filePath, "content");
    const item = { ...makeItem(filePath), pluginId: "mattpocock-skills@claude-plugins-official" };

    expect(() => toggleItemEnabled(item)).toThrow(/installed plugin/);
    expect(existsSync(filePath)).toBe(true);
  });

  it("deleteItem on a project-linked symlink removes only the link, never the real target, and never calls trash", async () => {
    // This is the case that matters most: uninstalling a project-scoped instance of a shared
    // global skill must never reach through the symlink and delete the global copy other
    // projects still depend on. It also must never route through the OS trash — trashing a
    // symlink would still just be trashing the link, so this stays a plain unlink even when
    // Electron's shell isn't reachable at all.
    const globalSkillDir = join(root, "global-skills", "pdf-editing");
    mkdirSync(globalSkillDir, { recursive: true });
    writeFileSync(join(globalSkillDir, "SKILL.md"), "manifest");
    writeFileSync(join(globalSkillDir, "helper.py"), "print(1)");

    const projectDir = join(root, "project", "skills");
    mkdirSync(projectDir, { recursive: true });
    const linkPath = join(projectDir, "pdf-editing");
    symlinkSync(globalSkillDir, linkPath, "dir");

    await deleteItem(makeItem(join(linkPath, "SKILL.md")), unreachableTrash);

    expect(existsSync(linkPath)).toBe(false); // the link is gone
    expect(existsSync(globalSkillDir)).toBe(true); // the real global skill is untouched
    expect(existsSync(join(globalSkillDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(globalSkillDir, "helper.py"))).toBe(true);
  });
});

describe("previewToggle", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skillmanager-preview-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("previews an enabled item as a disable move, without touching the filesystem", () => {
    const filePath = join(root, "backend.md");
    writeFileSync(filePath, "content");

    const preview = previewToggle(makeItem(filePath));

    expect(preview.willDisable).toBe(true);
    expect(preview.fromPath).toBe(filePath);
    expect(preview.toPath).toBe(join(root, DISABLED_DIRNAME, "backend.md"));
    expect(existsSync(filePath)).toBe(true); // still where it started — preview never moves it
    expect(existsSync(preview.toPath)).toBe(false);
  });

  it("previews a disabled item as an enable move, matching where toggleItemEnabled would actually put it", () => {
    const filePath = join(root, "backend.md");
    writeFileSync(filePath, "content");
    toggleItemEnabled(makeItem(filePath)); // disable it for real first
    const disabledPath = join(root, DISABLED_DIRNAME, "backend.md");

    const preview = previewToggle(makeItem(disabledPath));

    expect(preview.willDisable).toBe(false);
    expect(preview.fromPath).toBe(disabledPath);
    expect(preview.toPath).toBe(filePath);
  });
});

function makeTool(pluginsSettingsPath?: string): ToolConfig {
  return { id: "claude-code", name: "Claude Code", icon: "asterisk", paths: {}, pluginsSettingsPath };
}

describe("togglePluginEnabled", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skillmanager-plugin-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("flips an already-listed plugin from enabled to disabled, leaving other keys untouched", () => {
    const settingsPath = join(root, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ["x"] }, enabledPlugins: { "foo@bar": true } }, null, 2));

    togglePluginEnabled(makeTool(settingsPath), "foo@bar", true);

    const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      enabledPlugins?: Record<string, boolean>;
      permissions?: unknown;
    };
    expect(written.enabledPlugins).toEqual({ "foo@bar": false });
    expect(written.permissions).toEqual({ allow: ["x"] }); // untouched
  });

  it("adds a disabled entry for a plugin that was implicitly enabled (absent from the map)", () => {
    const settingsPath = join(root, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: {} }, null, 2));

    togglePluginEnabled(makeTool(settingsPath), "foo@bar", true);

    const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      enabledPlugins?: Record<string, boolean>;
    };
    expect(written.enabledPlugins).toEqual({ "foo@bar": false });
  });

  it("throws when the tool has no configured plugin settings path", () => {
    expect(() => togglePluginEnabled(makeTool(undefined), "foo@bar", true)).toThrow(/no known plugin settings file/);
  });

  it("throws when the settings file doesn't exist", () => {
    expect(() => togglePluginEnabled(makeTool(join(root, "missing.json")), "foo@bar", true)).toThrow(/wasn't found/);
  });
});
