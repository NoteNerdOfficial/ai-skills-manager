import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { DiffLine } from "./buildDiffLines";
import { changedUnitFiles } from "./companions";
import { foldSegments } from "./renderDiff";

const lines = (markers: string): DiffLine[] =>
  [...markers].map((m, i) => ({ lineNumber: i + 1, marker: m === "." ? " " : (m as "+" | "-"), segments: [] }));

describe("foldSegments", () => {
  it("keeps context around a change and folds the long stretches either side", () => {
    // 20 unchanged, 1 change, 20 unchanged
    expect(foldSegments(lines(".".repeat(20) + "+" + ".".repeat(20)))).toEqual([
      { kind: "fold", from: 0, to: 17 },
      { kind: "rows", from: 17, to: 24 },
      { kind: "fold", from: 24, to: 41 },
    ]);
  });

  it("doesn't fold a stretch too short to be worth it", () => {
    expect(foldSegments(lines("+" + ".".repeat(9) + "-"))).toEqual([{ kind: "rows", from: 0, to: 11 }]);
  });

  it("folds the middle of a long gap between two changes", () => {
    expect(foldSegments(lines("+" + ".".repeat(12) + "-"))).toEqual([
      { kind: "rows", from: 0, to: 4 },
      { kind: "fold", from: 4, to: 10 },
      { kind: "rows", from: 10, to: 14 },
    ]);
  });

  it("folds a 13,000-line file down to the rows around its changes", () => {
    const markers = Array.from({ length: 13000 }, (_, i) => (i === 100 || i === 9000 ? "+" : ".")).join("");
    const drawn = foldSegments(lines(markers))
      .filter((s) => s.kind === "rows")
      .reduce((n, s) => n + s.to - s.from, 0);
    expect(drawn).toBe(14);
  });
});

describe("changedUnitFiles", () => {
  let tmp: string;
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("lists SKILL.md first when it changed, then other files with what applying would do", () => {
    tmp = mkdtempSync(join(tmpdir(), "skillmanager-diffview-"));
    const now = join(tmp, "now");
    const other = join(tmp, "other");
    for (const dir of [now, other]) mkdirSync(join(dir, "refs"), { recursive: true });
    writeFileSync(join(now, "SKILL.md"), "a");
    writeFileSync(join(other, "SKILL.md"), "b");
    writeFileSync(join(now, "refs", "same.md"), "x");
    writeFileSync(join(other, "refs", "same.md"), "x");
    writeFileSync(join(now, "gone.md"), "x");
    writeFileSync(join(other, "new.md"), "x");

    expect(changedUnitFiles(now, other, true).map((f) => [f.file, f.status])).toEqual([
      ["SKILL.md", "modified"],
      ["gone.md", "removed"],
      ["new.md", "added"],
    ]);
  });

  it("skips SKILL.md when only another file changed, and treats a flat unit as one file", () => {
    tmp = mkdtempSync(join(tmpdir(), "skillmanager-diffview-"));
    const now = join(tmp, "now");
    const other = join(tmp, "other");
    for (const dir of [now, other]) mkdirSync(dir);
    writeFileSync(join(now, "SKILL.md"), "same");
    writeFileSync(join(other, "SKILL.md"), "same");
    writeFileSync(join(now, "ref.md"), "1");
    writeFileSync(join(other, "ref.md"), "2");
    expect(changedUnitFiles(now, other, true).map((f) => f.file)).toEqual(["ref.md"]);

    writeFileSync(join(tmp, "cmd.md"), "old");
    writeFileSync(join(tmp, "cmd-new.md"), "new");
    expect(changedUnitFiles(join(tmp, "cmd.md"), join(tmp, "cmd-new.md"), false)).toMatchObject([{ file: "cmd.md", status: "modified" }]);
    expect(changedUnitFiles(join(tmp, "cmd.md"), join(tmp, "cmd.md"), false)).toEqual([]);
  });
});
