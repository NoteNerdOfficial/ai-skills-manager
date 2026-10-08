import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { errorMessage } from "./errors";

function git(args: string[], cwd?: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      // Update reviews run from the view and must not remain in a loading state forever when
      // GitHub, a proxy, or git's credential/network layer stops responding.
      timeout: 45_000,
    }).trim();
  } catch (e) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Git isn't installed, or isn't on your PATH. Install Git to use Discover, install-from-GitHub, and update checks.");
    }
    if (e instanceof Error && ((e as NodeJS.ErrnoException).code === "ETIMEDOUT" || (e as NodeJS.ErrnoException & { killed?: boolean }).killed)) {
      throw new Error("GitHub did not respond within 45 seconds. Check your connection and try again.");
    }
    throw e;
  }
}

/** Resolves a repo's current commit for a given ref without cloning anything. Passing no ref
 *  checks "HEAD" — a symbolic ref every repo has — which is what lets a tracked skill follow
 *  "whatever the default branch is" without Skillmanager ever needing to know its actual name. */
export function remoteHeadCommit(repoUrl: string, ref?: string): string {
  const output = git(["ls-remote", repoUrl, ref || "HEAD"]);
  const sha = output.split(/\s+/)[0];
  if (!sha) throw new Error(`No matching ref found in ${repoUrl}`);
  return sha;
}

/** Deletes a path inside (or of) a fresh temp clone. On Windows, antivirus and the search indexer
 *  open git's newly written pack files right after a clone, and deleting while they hold them
 *  fails (EBUSY on Node 22, EPERM on Node 24+). maxRetries makes Node retry those codes with a
 *  linear backoff (200ms, 400ms, … ~3s in total), which covers a scan of a small skill repo. */
function removeClonePath(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** Best effort: temp clones whose cleanup failed even after retries, oldest first, tried again on
 *  later cleanups and when the plugin unloads. Kept in memory rather than swept from the temp
 *  folder on load, because a sweep could delete a clone another vault's update-check cache is
 *  still using. */
const pendingRemovals = new Set<string>();

/** Caps on that queue, so a folder that stays locked can neither grow it without bound nor slow
 *  every later clone's cleanup. */
const MAX_PENDING_REMOVALS = 20;
const MAX_RETRIES_PER_CLEANUP = 3;

/** A temp clone that can't be deleted is litter in %TEMP%, not a failed operation, so cleanup
 *  never throws: a throw from a `finally` would replace the caller's real result or error. */
function cleanupClone(dir: string): void {
  retryPendingCloneRemovals(MAX_RETRIES_PER_CLEANUP);
  try {
    removeClonePath(dir);
  } catch (e) {
    console.warn(`AI Skills Manager: couldn't remove temp clone ${dir}, will retry later: ${errorMessage(e)}`);
    queueRemoval(dir);
  }
}

function queueRemoval(dir: string): void {
  pendingRemovals.add(dir);
  if (pendingRemovals.size <= MAX_PENDING_REMOVALS) return;
  const oldest = pendingRemovals.values().next().value as string;
  pendingRemovals.delete(oldest);
  console.warn(`AI Skills Manager: no longer tracking temp clone ${oldest}; delete it by hand if it's still there.`);
}

/** One quick attempt (no retry backoff) at each of the `limit` oldest clones whose cleanup failed
 *  earlier (all of them by default); anything still held stays queued. */
export function retryPendingCloneRemovals(limit = Infinity): void {
  let tried = 0;
  for (const dir of [...pendingRemovals]) {
    if (tried++ >= limit) break;
    try {
      rmSync(dir, { recursive: true, force: true });
      pendingRemovals.delete(dir);
    } catch {
      // Still held; stays queued for the next attempt.
    }
  }
}

/** The clones currently queued for a later removal attempt, oldest first. */
export function pendingCloneRemovals(): string[] {
  return [...pendingRemovals];
}

/** Removes a clone's .git folder so its contents can be copied as-is. If that still fails after
 *  retries, the whole clone is cleaned up before rethrowing, so a caller that hasn't stored the
 *  clone anywhere yet never orphans the temp dir. */
export function removeGitDir(clone: ClonedRepo): void {
  try {
    removeClonePath(join(clone.dir, ".git"));
  } catch (e) {
    clone.cleanup();
    throw e;
  }
}

export interface ClonedRepo {
  /** Absolute path to the temp clone — caller reads whatever subpath it needs from here. */
  dir: string;
  /** The commit actually checked out (resolves "default branch" down to a real sha). */
  commit: string;
  /** Always removes the temp clone, whether or not the caller finished using it. */
  cleanup: () => void;
}

/** Shallow-clones a repo at a ref (or its default branch, if none given) into a fresh temp
 *  directory. Depth 1 keeps this fast for the common case (a small skill repo), at the cost of
 *  not supporting arbitrary historical commits as a ref — acceptable since a tracked skill only
 *  ever needs "whatever's at the tip now". */
export function shallowCloneRepo(repoUrl: string, ref?: string): ClonedRepo {
  const dir = mkdtempSync(join(tmpdir(), "skillmanager-clone-"));
  try {
    const args = ["clone", "--depth", "1", "--single-branch"];
    if (ref) args.push("--branch", ref);
    args.push(repoUrl, dir);
    git(args);
    const commit = git(["rev-parse", "HEAD"], dir);
    return { dir, commit, cleanup: () => cleanupClone(dir) };
  } catch (e) {
    cleanupClone(dir);
    throw e;
  }
}

/** Fetches one exact historical commit — used to restore a skill back to the state it was
 *  installed at, as opposed to shallowCloneRepo's "whatever's at the tip now". A plain shallow
 *  clone can't target an arbitrary commit (--branch only accepts branch/tag names), so this
 *  fetches it directly instead: works against GitHub's public smart-HTTP endpoint (and any other
 *  host with uploadpack.allowReachableSHA1InWant enabled), which is the standard way to grab a
 *  single commit without cloning the repo's full history. */
export function shallowCloneAtCommit(repoUrl: string, commitSha: string): ClonedRepo {
  const dir = mkdtempSync(join(tmpdir(), "skillmanager-clone-"));
  try {
    git(["init", "-q", dir]);
    git(["remote", "add", "origin", repoUrl], dir);
    git(["fetch", "--depth", "1", "origin", commitSha], dir);
    git(["checkout", "-q", "FETCH_HEAD"], dir);
    return { dir, commit: commitSha, cleanup: () => cleanupClone(dir) };
  } catch (e) {
    cleanupClone(dir);
    throw new Error(
      `Couldn't fetch the originally-installed commit from this host. Try "Check for updates" instead. (${errorMessage(e)})`
    );
  }
}
