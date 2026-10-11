import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findModCleanup, findModHealthIssues } from "./modChecks";
import { ModEntry, ToolConfig } from "./types";

describe("mod checks", () => {
  let root: string;
  let savedEnv: string | undefined;
  let tool: ToolConfig;
  let settingsPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skillmanager-modchecks-"));
    savedEnv = process.env.CLAUDE_CODE_PLUGIN_DIRS;
    delete process.env.CLAUDE_CODE_PLUGIN_DIRS;
    settingsPath = join(root, "settings.json");
    writeFileSync(settingsPath, "{}");
    tool = { id: "claude-code", name: "Claude Code", icon: "asterisk", paths: {}, devModsPath: join(root, "dev-mods"), pluginsSettingsPath: settingsPath };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.CLAUDE_CODE_PLUGIN_DIRS;
    else process.env.CLAUDE_CODE_PLUGIN_DIRS = savedEnv;
  });

  function writeMod(dir: string, modules: string[] = ["./register.tsx"], withModule = true) {
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    mkdirSync(join(dir, "hooks"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), "{}");
    writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({ modules }));
    if (withModule) writeFileSync(join(dir, "hooks", "register.tsx"), "");
  }

  const mod = (name: string, path: string, origin: ModEntry["origin"], enabled = true): ModEntry => ({ id: path, name, path, realPath: path, toolId: "claude-code", origin, enabled });

  it("flags env folders that are gone or aren't plugins", () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    writeFileSync(settingsPath, JSON.stringify({ env: { CLAUDE_CODE_PLUGIN_DIRS: [join(root, "gone"), plain].join(delimiter) } }));
    expect(findModHealthIssues([tool], []).map((i) => i.kind)).toEqual(["missing-dir", "not-a-plugin"]);
  });

  it("flags a missing hooks module, but not on a mod that's turned off", () => {
    const dir = join(root, "band");
    writeMod(dir, ["./register.tsx", "./gone.ts", "../../outside.ts"]);
    expect(findModHealthIssues([], [mod("band", dir, "plugin-dir")])).toMatchObject([{ kind: "missing-module", modules: ["./gone.ts", "../../outside.ts"] }]);
    expect(findModHealthIssues([], [mod("band", dir, "plugin-dir", false)])).toEqual([]);
  });

  it("flags two copies that both load everywhere, and leaves a dev copy to Cleanup", () => {
    const a = join(root, "a");
    const b = join(root, "b");
    const dev = join(root, "dev-mods", "s1", "band");
    for (const dir of [a, b, dev]) writeMod(dir);
    const mods = [mod("band", a, "plugin-dir"), mod("band", b, "skill"), mod("band", dev, "dev")];
    expect(findModHealthIssues([], mods)).toMatchObject([{ kind: "duplicate", name: "band" }]);
    expect(findModCleanup([], mods)).toMatchObject([{ kind: "promoted-copy", dev: { path: dev }, finished: { path: a } }]);
  });

  it("lists empty session folders older than a day", () => {
    const old = join(root, "dev-mods", "old");
    const fresh = join(root, "dev-mods", "fresh");
    const used = join(root, "dev-mods", "used");
    mkdirSync(old, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    writeMod(join(used, "band"));
    writeFileSync(join(old, ".DS_Store"), "");
    const dayAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(old, dayAgo, dayAgo);
    utimesSync(used, dayAgo, dayAgo);
    expect(findModCleanup([tool], [])).toEqual([{ kind: "empty-sessions", toolId: "claude-code", paths: [old] }]);
  });
});
