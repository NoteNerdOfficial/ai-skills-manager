import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { errorMessage } from "./errors";

/** Env vars that tell git (via libcurl) how to reach the network: proxies and extra CA bundles.
 *  On a managed computer these usually live in the shell profile, which an app launched from the
 *  Dock or Start menu never reads. */
const NETWORK_ENV_KEYS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
];

function isNetworkEnvKey(key: string): boolean {
  return NETWORK_ENV_KEYS.includes(key.toUpperCase());
}

/** Proxy set in the plugin's settings. Wins over anything detected. */
let proxyOverride = "";

export function setGitProxy(proxy: string): void {
  proxyOverride = proxy.trim();
}

let detectedEnv: Record<string, string> | null = null;

/** Parses `scutil --proxy` output into proxy env vars, for when the macOS network settings name a
 *  fixed HTTPS/HTTP proxy. A proxy only given through an auto-config (PAC) URL can't be used by
 *  git, so that case needs the proxy setting instead. */
export function proxyEnvFromScutil(output: string): Record<string, string> {
  const field = (name: string) => new RegExp(`^\\s*${name}\\s*:\\s*(\\S+)\\s*$`, "m").exec(output)?.[1] ?? "";
  const env: Record<string, string> = {};
  for (const scheme of ["HTTPS", "HTTP"]) {
    if (field(`${scheme}Enable`) !== "1" || !field(`${scheme}Proxy`)) continue;
    const port = field(`${scheme}Port`);
    env[`${scheme}_PROXY`] = `http://${field(`${scheme}Proxy`)}${port ? `:${port}` : ""}`;
  }
  const exceptions = /ExceptionsList\s*:\s*<array>\s*\{([^}]*)\}/.exec(output)?.[1];
  if (exceptions && Object.keys(env).length > 0) {
    const hosts = [...exceptions.matchAll(/^\s*\d+\s*:\s*(\S+)\s*$/gm)].map((m) => m[1].replace(/^\*/, ""));
    if (hosts.length > 0) env.NO_PROXY = hosts.join(",");
  }
  return env;
}

/** Reads the network env vars from a login shell, then falls back to the macOS system proxy.
 *  Runs once per session; each source is best effort and a failure just means it's skipped. */
function detectNetworkEnv(): Record<string, string> {
  if (detectedEnv) return detectedEnv;
  const env: Record<string, string> = {};
  const has = (key: string) => Object.entries({ ...process.env, ...env }).some(([k, v]) => k.toUpperCase() === key && v);

  if (process.platform !== "win32") {
    try {
      const marker = "__SKILLMANAGER_ENV__";
      const output = execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", `echo ${marker}; env`], {
        encoding: "utf-8",
        timeout: 5_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const body = output.slice(output.indexOf(marker) + marker.length);
      for (const line of body.split("\n")) {
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq);
        if (isNetworkEnvKey(key) && !process.env[key]) env[key] = line.slice(eq + 1);
      }
    } catch {
      // No usable shell, or its profile hung. The system proxy below may still work.
    }
  }

  if (process.platform === "darwin" && !has("HTTPS_PROXY") && !has("HTTP_PROXY") && !has("ALL_PROXY")) {
    try {
      Object.assign(env, proxyEnvFromScutil(execFileSync("scutil", ["--proxy"], { encoding: "utf-8", timeout: 3_000 })));
    } catch {
      // Not fatal: git just connects directly.
    }
  }

  detectedEnv = env;
  return env;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...detectNetworkEnv() };
  if (proxyOverride) {
    for (const key of Object.keys(env)) {
      if (["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"].includes(key.toUpperCase())) delete env[key];
    }
    env.HTTPS_PROXY = proxyOverride;
    env.HTTP_PROXY = proxyOverride;
  }
  // There's no terminal to type a username into. Without this, a host that wants sign-in makes
  // git wait for input until the timeout instead of failing right away.
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/** The host a git command talks to, for error messages. */
function hostOf(args: string[]): string {
  for (const arg of args) {
    try {
      const url = new URL(arg);
      if (url.hostname) return url.hostname;
    } catch {
      const scp = /^[^@/]+@([^:/]+):/.exec(arg);
      if (scp) return scp[1];
    }
  }
  return "the remote";
}

/** Turns git's raw stderr into a message that says what went wrong and what to try, keeping git's
 *  own "fatal:" line at the end for troubleshooting. Returns null for errors it doesn't recognise. */
export function friendlyGitError(stderr: string, host: string): string | null {
  const fatal = /fatal: .*/.exec(stderr)?.[0]?.trim();
  const detail = fatal ? ` (${fatal})` : "";
  if (
    /could not read (Username|Password)|terminal prompts disabled|Authentication failed|Invalid username or password|returned error: 40[13]|redirection:[\s\S]*\/login/i.test(
      stderr
    )
  ) {
    return `${host} needs you to sign in. Clone this repo once from a terminal so git saves your credentials, then try again.${detail}`;
  }
  if (/Repository not found|returned error: 404/i.test(stderr)) {
    return `Couldn't find that repo on ${host}. Check the URL, and that your account can open it.${detail}`;
  }
  if (/Connection reset|Failed to connect|Could not resolve (host|proxy)|Connection timed out|Connection refused|Proxy CONNECT aborted|Recv failure|SSL_ERROR_SYSCALL/i.test(stderr)) {
    return `Couldn't reach ${host}. On a work network, git may need a proxy: set one under Settings > AI Skills Manager > Network, or ask IT for the proxy address.${detail}`;
  }
  if (/SSL certificate problem|unable to get local issuer certificate|self.signed certificate/i.test(stderr)) {
    return `Couldn't verify ${host}'s certificate. Your network may inspect secure traffic; ask IT for its root certificate and point git at it with "git config --global http.sslCAInfo <file>".${detail}`;
  }
  return null;
}

function git(args: string[], cwd?: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      env: gitEnv(),
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
      throw new Error(`${hostOf(args)} did not respond within 45 seconds. Check your connection and try again.`);
    }
    const rawStderr = (e as { stderr?: unknown }).stderr;
    const stderr = typeof rawStderr === "string" ? rawStderr : "";
    const friendly = friendlyGitError(stderr, hostOf(args));
    if (friendly) throw new Error(friendly);
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
function removeClonePath(path: string, maxRetries = 5): void {
  rmSync(path, { recursive: true, force: true, maxRetries, retryDelay: 200 });
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
function cleanupClone(dir: string, maxRetries?: number): void {
  retryPendingCloneRemovals(MAX_RETRIES_PER_CLEANUP);
  try {
    removeClonePath(dir, maxRetries);
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
 *  earlier (all of them by default). One still held moves to the back of the queue, so a capped
 *  pass rotates through every entry instead of retrying the same locked ones forever. */
export function retryPendingCloneRemovals(limit = Infinity): void {
  let tried = 0;
  for (const dir of [...pendingRemovals]) {
    if (tried++ >= limit) break;
    pendingRemovals.delete(dir);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      pendingRemovals.add(dir);
    }
  }
}

/** The clones currently queued for a later removal attempt, oldest first. */
export function pendingCloneRemovals(): string[] {
  return [...pendingRemovals];
}

/** Removes a clone's .git folder so its contents can be copied as-is. If that still fails after
 *  retries, the whole clone is removed, or queued for retry if that also fails, before rethrowing,
 *  so a caller that hasn't stored the clone anywhere yet doesn't drop it untracked. The retry
 *  budget is already spent on the same lock by then, so the whole-clone removal makes one quick
 *  attempt rather than waiting a second time. */
export function removeGitDir(clone: ClonedRepo): void {
  try {
    removeClonePath(join(clone.dir, ".git"));
  } catch (e) {
    cleanupClone(clone.dir, 0);
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
