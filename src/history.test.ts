import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ItemHistory } from "./history";

let tmp: string;
let historyRoot: string;
let skillDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "skillmanager-history-"));
  historyRoot = join(tmp, "history");
  skillDir = join(tmp, "skills", "demo");
  mkdirSync(join(skillDir, "refs"), { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "v1");
  writeFileSync(join(skillDir, "refs", "notes.md"), "notes v1");
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("ItemHistory", () => {
  it("snapshots a file before an edit and restores it", () => {
    const history = new ItemHistory(historyRoot);
    const file = join(skillDir, "refs", "notes.md");
    const entry = history.snapshotFile("id-1", skillDir, file, "edit", "notes v2");
    expect(entry).toMatchObject({ scope: "file", relPath: join("refs", "notes.md"), kind: "edit" });

    writeFileSync(file, "notes v2");
    expect(history.readText(entry!)).toBe("notes v1");
    history.restoreFile(entry!, skillDir);
    expect(readFileSync(file, "utf-8")).toBe("notes v1");
  });

  it("skips a save that changes nothing", () => {
    const history = new ItemHistory(historyRoot);
    expect(history.snapshotFile("id-1", skillDir, join(skillDir, "SKILL.md"), "edit", "v1")).toBeNull();
    expect(history.list("id-1")).toEqual([]);
  });

  it("handles a flat item whose unit is the file itself", () => {
    const history = new ItemHistory(historyRoot);
    const flat = join(tmp, "cmd.md");
    writeFileSync(flat, "old");
    const entry = history.snapshotFile("flat", flat, flat, "edit", "new");
    expect(entry?.relPath).toBe("");
    writeFileSync(flat, "new");
    history.restoreFile(entry!, flat);
    expect(readFileSync(flat, "utf-8")).toBe("old");
  });

  it("copies a whole folder unit, following a symlinked folder and skipping .git", () => {
    const history = new ItemHistory(historyRoot);
    mkdirSync(join(skillDir, ".git"));
    const link = join(tmp, "linked");
    symlinkSync(skillDir, link, "dir");
    const entry = history.snapshotUnit("id-1", link, true, "update", { commit: "aaa", toCommit: "bbb" });
    expect(entry).toMatchObject({ scope: "unit", commit: "aaa", toCommit: "bbb" });
    expect(history.readText(entry!, "SKILL.md")).toBe("v1");
    expect(history.readText(entry!, join("refs", "notes.md"))).toBe("notes v1");
    expect(existsSync(join(history.contentPath(entry!), ".git"))).toBe(false);
  });

  it("lists newest first, keeps items apart, and prunes past the limit", () => {
    const history = new ItemHistory(historyRoot, 3);
    const file = join(skillDir, "SKILL.md");
    for (let i = 2; i <= 6; i++) {
      history.snapshotFile("id-1", skillDir, file, "edit", `v${i}`);
      writeFileSync(file, `v${i}`);
    }
    history.snapshotFile("id-2", skillDir, file, "edit", "other");

    const entries = history.list("id-1");
    expect(entries.map((e) => history.readText(e))).toEqual(["v5", "v4", "v3"]);
    expect(history.list("id-2")).toHaveLength(1);
  });
});

describe("ItemHistory restore", () => {
  it("can restore the oldest kept version even when the pre-restore snapshot hits the limit", () => {
    const history = new ItemHistory(historyRoot, 2);
    const file = join(skillDir, "SKILL.md");
    history.snapshotFile("id-1", skillDir, file, "edit", "v2");
    writeFileSync(file, "v2");
    history.snapshotFile("id-1", skillDir, file, "edit", "v3");
    writeFileSync(file, "v3");

    const oldest = history.list("id-1")[1];
    expect(history.readText(oldest)).toBe("v1");
    expect(history.snapshotBeforeRestore(oldest, skillDir, true)).not.toBeNull();
    history.restoreFile(oldest, skillDir);
    history.prune("id-1");

    expect(readFileSync(file, "utf-8")).toBe("v1");
    const kept = history.list("id-1");
    expect(kept).toHaveLength(2);
    expect(kept[0]).toMatchObject({ kind: "restore" });
    expect(history.readText(kept[0])).toBe("v3");
  });
});
