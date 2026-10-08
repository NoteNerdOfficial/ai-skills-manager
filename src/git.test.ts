import { ChildProcess, execFileSync, spawn } from "child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as git from "./git";

// Same module-mock pattern as itemToggle.test.ts (vi.spyOn can't redefine Node's "fs" namespace).
// When failCode is set, rmSync on a matching temp-clone path throws the errno error Windows gives
// when antivirus or the search indexer still has a file open inside the clone (EPERM on Node 24+,
// EBUSY on 22). failOnlyGitDir narrows the failure to the clone's .git folder.
// `failPaths` fails only those exact paths; `calls` records every rmSync path and its options.
const { rmSyncControl } = vi.hoisted(() => ({
  rmSyncControl: {
    failCode: null as string | null,
    failOnlyGitDir: false,
    failPaths: new Set<string>(),
    calls: [] as { path: string; options: { maxRetries?: number } | undefined }[],
  },
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      const path = String(args[0]);
      rmSyncControl.calls.push({ path, options: args[1] });
      if (rmSyncControl.failPaths.has(path)) {
        const err = new Error(`EPERM, Permission denied: '${path}'`) as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
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
  rmSyncControl.failPaths.clear();
  rmSyncControl.calls = [];
};

interface FileHolder {
  holder: ChildProcess;
  /** Created at spawn and kept for the whole test, so no exit can slip between listeners. */
  exited: Promise<number | null>;
  /** Resolves once the file is open; rejects if PowerShell fails to start or exits first. */
  locked: Promise<void>;
}

/** Opens `file` from a child PowerShell without FILE_SHARE_DELETE (what a scanner does) and holds
 *  it for `ms`. Anything slower than a failed start or an early exit is bounded by the test's own
 *  timeout. */
function holdFileOpen(file: string, ms: number): FileHolder {
  const holder = spawn("powershell.exe", [
    "-NoProfile",
    "-Command",
    `$f=[IO.File]::Open('${file}','Open','Read','Read'); Write-Output LOCKED; Start-Sleep -Milliseconds ${ms}; $f.Close()`,
  ]);
  // Settles on a failed spawn too ('error' with no 'exit'), so a finally awaiting it can't hang.
  const exited = new Promise<number | null>((resolve) => {
    holder.on("exit", resolve);
    holder.on("error", () => resolve(null));
  });
  const locked = new Promise<void>((resolve, reject) => {
    holder.on("error", reject);
    void exited.then((code) => reject(new Error(`lock holder exited (${code}) before locking`)));
    holder.stdout.on("data", (b) => String(b).includes("LOCKED") && resolve());
  });
  return { holder, exited, locked };
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
    // The failed-removal queue is module state; start every test with it drained.
    git.retryPendingCloneRemovals();
  });

  /** Clones `n` times with every temp-clone removal failing, so each clone lands in the queue. */
  const stuckClones = (n: number): string[] => {
    const dirs: string[] = [];
    for (let i = 0; i < n; i++) {
      const clone = git.shallowCloneRepo(repoUrl);
      rmSyncControl.failCode = "EPERM";
      clone.cleanup();
      resetControl();
      dirs.push(clone.dir);
    }
    return dirs;
  };

  it("keeps at most 20 failed removals queued, dropping one with a warning that names it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dirs = stuckClones(21);
    const queued = git.pendingCloneRemovals();
    const dropped = dirs.filter((d) => !queued.includes(d));
    try {
      expect(queued).toHaveLength(20);
      expect(dropped).toHaveLength(1);
      expect(queued).toContain(dirs[20]);
      expect(warn.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(new RegExp(`no longer tracking.*${dropped[0].replace(/\\/g, "\\\\")}`));
    } finally {
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    }
  }, 60_000);

  it("retries at most 3 queued removals per cleanup, from the front of the queue", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stuckClones(5);
    const queued = git.pendingCloneRemovals();
    expect(queued).toHaveLength(5);

    git.shallowCloneRepo(repoUrl).cleanup();

    expect(queued.map(existsSync)).toEqual([false, false, false, true, true]);
    expect(git.pendingCloneRemovals()).toEqual(queued.slice(3));
  });

  it("a queued clone that is still locked moves to the back, so a later entry gets its turn", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stuckClones(4);
    const [a, b, c, d] = git.pendingCloneRemovals();
    for (const locked of [a, b, c]) rmSyncControl.failPaths.add(locked);
    try {
      git.shallowCloneRepo(repoUrl).cleanup();
      git.shallowCloneRepo(repoUrl).cleanup();

      expect(existsSync(d)).toBe(false);
      expect([...git.pendingCloneRemovals()].sort()).toEqual([a, b, c].sort());
    } finally {
      resetControl();
      for (const dir of [a, b, c, d]) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("after the .git removal has used its retries, the whole-clone removal makes one quick attempt", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const clone = git.shallowCloneRepo(repoUrl);
    rmSyncControl.failCode = "EPERM";
    rmSyncControl.calls = [];
    try {
      expect(() => git.removeGitDir(clone)).toThrow();
      const gitDirCalls = rmSyncControl.calls.filter((c) => c.path === join(clone.dir, ".git"));
      const cloneCalls = rmSyncControl.calls.filter((c) => c.path === clone.dir);
      expect(gitDirCalls.map((c) => c.options?.maxRetries)).toEqual([5]);
      expect(cloneCalls).toHaveLength(1);
      expect(cloneCalls[0].options?.maxRetries ?? 0).toBe(0);
    } finally {
      resetControl();
      rmSync(clone.dir, { recursive: true, force: true });
    }
  });

  it("removeGitDir() queues the clone when both the .git removal and the clone removal fail", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const clone = git.shallowCloneRepo(repoUrl);
    rmSyncControl.failCode = "EPERM";
    try {
      expect(() => git.removeGitDir(clone)).toThrow(/EPERM, Permission denied: '.*[\\/]\.git'/);
      expect(existsSync(clone.dir)).toBe(true);
      expect(git.pendingCloneRemovals()).toEqual([clone.dir]);
    } finally {
      resetControl();
      rmSync(clone.dir, { recursive: true, force: true });
    }
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
  // clone. Right before cleanup, a plain delete of that file must still be refused, so a slow
  // runner can't let the lock lapse first and pass without exercising the retry.
  it.skipIf(process.platform !== "win32")(
    "cleanup() still removes the clone when another process holds a file open for a moment",
    async () => {
      const clone = git.shallowCloneRepo(repoUrl);
      const packDir = join(clone.dir, ".git", "objects", "pack");
      const pack = readdirSync(packDir).find((f) => f.endsWith(".pack"));
      const lockedFile = pack ? join(packDir, pack) : join(clone.dir, "SKILL.md");
      const lock = holdFileOpen(lockedFile, 1500);
      try {
        await lock.locked;
        expect(() => rmSync(lockedFile, { force: true })).toThrow(/EBUSY|EPERM/);
        clone.cleanup();
        expect(existsSync(clone.dir)).toBe(false);
      } finally {
        lock.holder.kill();
        await lock.exited;
        rmSync(clone.dir, { recursive: true, force: true });
      }
    },
    20_000
  );
});
