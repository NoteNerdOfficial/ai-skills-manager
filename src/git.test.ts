import { ChildProcess, execFileSync, spawn } from "child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as git from "./git";

// Same module-mock pattern as itemToggle.test.ts (vi.spyOn can't redefine Node's "fs" namespace).
// When failCode is set, rmSync on a matching temp-clone path throws the errno error Windows gives
// when antivirus or the search indexer still has a file open inside the clone (EPERM on Node 24+,
// EBUSY on 22). failOnlyGitDir narrows the failure to the clone's .git folder.
const { rmSyncControl } = vi.hoisted(() => ({
  rmSyncControl: { failCode: null as string | null, failOnlyGitDir: false },
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      const path = String(args[0]);
      const matches = path.includes("skillmanager-clone-") && (!rmSyncControl.failOnlyGitDir || /[\\/]\.git$/.test(path));
      if (rmSyncControl.failCode && matches) {
        const err = new Error(`${rmSyncControl.failCode}, Permission denied: '${path}'`) as NodeJS.ErrnoException;
        err.code = rmSyncControl.failCode;
        throw err;
      }
      return actual.rmSync(...args);
    },
  };
});

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", ...args], { cwd });

const resetControl = () => {
  rmSyncControl.failCode = null;
  rmSyncControl.failOnlyGitDir = false;
};

/** Opens `file` from a child PowerShell without FILE_SHARE_DELETE (what a scanner does) and holds
 *  it for `ms`. Rejects at once if PowerShell fails to start or exits before locking; anything
 *  slower is bounded by the test's own timeout. */
function holdFileOpen(file: string, ms: number): Promise<ChildProcess> {
  const holder = spawn("powershell.exe", [
    "-NoProfile",
    "-Command",
    `$f=[IO.File]::Open('${file}','Open','Read','Read'); Write-Output LOCKED; Start-Sleep -Milliseconds ${ms}; $f.Close()`,
  ]);
  return new Promise((resolve, reject) => {
    holder.on("error", reject);
    holder.on("exit", (code) => reject(new Error(`lock holder exited (${code}) before locking`)));
    holder.stdout.on("data", (b) => {
      if (String(b).includes("LOCKED")) {
        holder.removeAllListeners("exit");
        resolve(holder);
      }
    });
  });
}

/** True while another process holds `file` without write sharing: opening it for writing fails. */
function isLockedAgainstWrite(file: string): boolean {
  try {
    closeSync(openSync(file, "r+"));
    return false;
  } catch {
    return true;
  }
}

describe("shallowCloneRepo temp-clone cleanup", () => {
  let sourceRepo: string;
  let repoUrl: string;

  beforeAll(() => {
    // A local repo cloned over file:// keeps the test offline while still running the real git clone.
    sourceRepo = mkdtempSync(join(tmpdir(), "skillmanager-test-src-"));
    gitIn(sourceRepo, "init", "-q");
    writeFileSync(join(sourceRepo, "SKILL.md"), "---\nname: demo\n---\n");
    gitIn(sourceRepo, "add", ".");
    gitIn(sourceRepo, "commit", "-q", "-m", "init");
    repoUrl = pathToFileURL(sourceRepo).href;
  });

  afterAll(() => {
    resetControl();
    git.retryPendingCloneRemovals();
    rmSync(sourceRepo, { recursive: true, force: true });
  });

  beforeEach(() => {
    resetControl();
    vi.restoreAllMocks();
  });

  it("cleanup() does not throw when Windows refuses to delete the temp clone", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const clone = git.shallowCloneRepo(repoUrl);
    rmSyncControl.failCode = "EPERM";
    try {
      expect(() => clone.cleanup()).not.toThrow();
    } finally {
      resetControl();
      rmSync(clone.dir, { recursive: true, force: true });
    }
  });

  it("a failed cleanup is reported with its path and removed on the next cleanup", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stuck = git.shallowCloneRepo(repoUrl);
    rmSyncControl.failCode = "EPERM";
    stuck.cleanup();
    resetControl();
    expect(existsSync(stuck.dir)).toBe(true);
    expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toContain(stuck.dir);

    const next = git.shallowCloneRepo(repoUrl);
    next.cleanup();
    expect(existsSync(stuck.dir)).toBe(false);
    expect(existsSync(next.dir)).toBe(false);
  });

  it("retryPendingCloneRemovals() removes a clone whose cleanup failed earlier", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const stuck = git.shallowCloneRepo(repoUrl);
    rmSyncControl.failCode = "EPERM";
    stuck.cleanup();
    resetControl();
    expect(existsSync(stuck.dir)).toBe(true);
    git.retryPendingCloneRemovals();
    expect(existsSync(stuck.dir)).toBe(false);
  });

  it("a failed clone reports the git error, not a cleanup error", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    rmSyncControl.failCode = "EPERM";
    const missing = pathToFileURL(join(sourceRepo, "does-not-exist")).href;
    const clonesBefore = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("skillmanager-clone-")));
    let thrown: unknown;
    try {
      git.shallowCloneRepo(missing);
    } catch (e) {
      thrown = e;
    } finally {
      // The mocked rmSync left this trial's empty temp dir behind on purpose; remove it here.
      resetControl();
      for (const n of readdirSync(tmpdir())) {
        if (n.startsWith("skillmanager-clone-") && !clonesBefore.has(n)) rmSync(join(tmpdir(), n), { recursive: true, force: true });
      }
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as NodeJS.ErrnoException).code).not.toBe("EPERM");
    expect((thrown as Error).message).not.toMatch(/Permission denied/);
  });

  it("removeGitDir() deletes the whole clone before rethrowing when .git can't be removed", () => {
    const clone = git.shallowCloneRepo(repoUrl);
    rmSyncControl.failCode = "EPERM";
    rmSyncControl.failOnlyGitDir = true;
    try {
      expect(() => git.removeGitDir(clone)).toThrow(/EPERM/);
      expect(existsSync(clone.dir)).toBe(false);
    } finally {
      resetControl();
      rmSync(clone.dir, { recursive: true, force: true });
    }
  });

  // The real-world trigger, issue #2: another process briefly holds a file open inside the fresh
  // clone. The lock is confirmed still active right before cleanup, so a slow runner can't let it
  // lapse first and pass without exercising the retry.
  it.skipIf(process.platform !== "win32")(
    "cleanup() still removes the clone when another process holds a file open for a moment",
    async () => {
      const clone = git.shallowCloneRepo(repoUrl);
      const packDir = join(clone.dir, ".git", "objects", "pack");
      const pack = readdirSync(packDir).find((f) => f.endsWith(".pack"));
      const lockedFile = pack ? join(packDir, pack) : join(clone.dir, "SKILL.md");
      let holder: ChildProcess | null = null;
      try {
        holder = await holdFileOpen(lockedFile, 1500);
        const exited = new Promise((resolve) => holder?.on("exit", resolve));
        expect(isLockedAgainstWrite(lockedFile)).toBe(true);
        clone.cleanup();
        expect(existsSync(clone.dir)).toBe(false);
        await exited;
      } finally {
        holder?.kill();
        rmSync(clone.dir, { recursive: true, force: true });
      }
    },
    20_000
  );
});
