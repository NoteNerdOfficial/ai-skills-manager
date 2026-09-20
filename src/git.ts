import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { errorMessage } from "./errors";

function git(args: string[], cwd?: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }).trim();
  } catch (e) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Git isn't installed, or isn't on your PATH. Install Git to use Discover, install-from-GitHub, and update checks.");
    }
    throw e;
  }
}

/** Resolves a repo's current commit for a given ref without cloning anything. Passing no ref
 *  checks "HEAD" — a symbolic ref every repo has — which is what lets a tracked skill follow
 *  "whatever the default branch is" without Skillspace ever needing to know its actual name. */
export function remoteHeadCommit(repoUrl: string, ref?: string): string {
  const output = git(["ls-remote", repoUrl, ref || "HEAD"]);
  const sha = output.split(/\s+/)[0];
  if (!sha) throw new Error(`No matching ref found in ${repoUrl}`);
  return sha;
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
  const dir = mkdtempSync(join(tmpdir(), "skillspace-clone-"));
  try {
    const args = ["clone", "--depth", "1", "--single-branch"];
    if (ref) args.push("--branch", ref);
    args.push(repoUrl, dir);
    git(args);
    const commit = git(["rev-parse", "HEAD"], dir);
    return { dir, commit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
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
  const dir = mkdtempSync(join(tmpdir(), "skillspace-clone-"));
  try {
    git(["init", "-q", dir]);
    git(["remote", "add", "origin", repoUrl], dir);
    git(["fetch", "--depth", "1", "origin", commitSha], dir);
    git(["checkout", "-q", "FETCH_HEAD"], dir);
    return { dir, commit: commitSha, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `Couldn't fetch the originally-installed commit from this host. Try "Check for updates" instead. (${errorMessage(e)})`
    );
  }
}
