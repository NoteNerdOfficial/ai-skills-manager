import { existsSync, readFileSync, readdirSync } from "fs";
import { basename, dirname, join, relative, sep } from "path";
import { createHash } from "crypto";
import { requestUrl } from "obsidian";
import { shallowCloneRepo } from "./git";
import { parseFrontmatter } from "./scanners";
import { slug } from "./format";
import { errorMessage } from "./errors";
import { DiscoverEntry, ItemType } from "./types";

/** slug() truncates to 80 chars — fine for makeEntryId's short tool/type/project/name tuple, but
 *  a repo URL alone can eat most of that budget, so hashing the full repoUrl+subpath+name through
 *  slug() risked two different skills in a long-URL/deep-subpath repo silently truncating to the
 *  same id. Hash the distinguishing tuple instead and keep a readable name prefix only for
 *  debuggability, not uniqueness. */
function discoverEntryId(repoUrl: string, entrySubpath: string, name: string): string {
  const hash = createHash("sha1").update(`${repoUrl}#${entrySubpath}#${name}`).digest("hex").slice(0, 12);
  return `${slug(name)}-${hash}`;
}

/** Same reasoning as discoverEntryId — hash the full repoUrl+ref+subpath rather than slug()-ing
 *  it directly, so a long URL can't truncate two distinct sources onto the same id. */
export function discoverSourceId(repoUrl: string, ref: string, subpath: string): string {
  return createHash("sha1").update(`${repoUrl}#${ref}#${subpath}`).digest("hex").slice(0, 16);
}

/** Collapses catalog entries that are the same real skill/agent/command/rule but ended up with
 *  different `id`s — the only way that happens is `id`'s own hash inputs (repoUrl/subpath/name)
 *  having been computed slightly differently across two discovery runs (e.g. the id-hashing
 *  scheme changing between plugin versions, or a subpath-normalization fix landing later). The
 *  catalog merge is otherwise deliberately additive-only (see refreshAllDiscoverSources /
 *  AddDiscoverSourceModal) so a transient scan failure can't wipe it out — but that same
 *  never-prunes design means an id drift leaves the old row behind forever, invisible to the
 *  id-keyed Map dedup, so it silently piles up as a duplicate card every time the source is
 *  re-added or refreshed. Re-groups by what a card actually displays as (repoUrl + type + name,
 *  case-insensitive) instead, keeping only the most recently discovered row per group. */
export function dedupeDiscoverCatalog(catalog: DiscoverEntry[]): DiscoverEntry[] {
  const byIdentity = new Map<string, DiscoverEntry>();
  for (const entry of catalog) {
    const key = `${entry.repoUrl}#${entry.type}#${entry.name.trim().toLowerCase()}`;
    const existing = byIdentity.get(key);
    if (!existing || entry.discoveredAt >= existing.discoveredAt) byIdentity.set(key, entry);
  }
  return Array.from(byIdentity.values());
}

const MAX_DISCOVER_DEPTH = 6;
const SKIP_DIRNAMES = new Set(["node_modules", ".git"]);

/** A folder whose own name is one of these is trusted to hold agent/command/rule files directly
 *  inside it, one .md file per item — the exact same "location, not content, decides the type"
 *  convention scanAllPlugins already trusts for a Claude Code plugin bundle's own skills/agents/
 *  commands folders (see scanners.ts). Best-effort for an arbitrary repo: a collection that uses
 *  different folder names (Codex's "prompts" for commands, say) won't be picked up — there's no
 *  configured path to fall back on the way the real scanner has. */
const TYPE_DIRNAMES: Record<string, ItemType> = {
  agent: "agent",
  agents: "agent",
  command: "command",
  commands: "command",
  rule: "rule",
  rules: "rule",
};

interface FoundManifest {
  type: ItemType;
  /** For a skill: the SKILL.md path. For agent/command/rule: the .md file itself. */
  path: string;
}

/** Walks `rootDir` for every skill (a SKILL.md-holding folder, found regardless of the folder's
 *  own name — never descending past one, since its own reference/scripts/ subfolders aren't
 *  further skills) and every agent/command/rule (a .md file sitting directly inside a folder
 *  named agents/commands/rules, per TYPE_DIRNAMES above — a type, once matched, carries into
 *  nested category subfolders the same way scanEntries lets a configured type directory nest
 *  category folders for skills). Not coupled to a configured ToolConfig — it just walks a plain
 *  directory (a fresh clone, or a clone narrowed to one subpath). */
export function findRepoManifests(rootDir: string): FoundManifest[] {
  const results: FoundManifest[] = [];

  function walk(dir: string, depth: number, typeHint: ItemType | null) {
    const skillManifest = join(dir, "SKILL.md");
    if (existsSync(skillManifest)) {
      results.push({ type: "skill", path: skillManifest });
      return;
    }
    if (depth >= MAX_DISCOVER_DEPTH) return;

    let entries: { name: string; isDirectory: boolean; isFile: boolean }[];
    try {
      // Deliberately does NOT skip dot-prefixed folders — a Claude Code plugin's manifest lives
      // in .claude-plugin/, and it's common for a repo to nest its whole skills/agents/commands
      // tree under .github/ alongside its Actions/config. Confirmed against microsoft/skills,
      // whose entire content (skills, agents, commands) lives under .github/ — skipping dotfiles
      // made every bare-repo-URL search find nothing at all. Same exclusion set scanEntries uses.
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => !SKIP_DIRNAMES.has(e.name))
        .map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }));
    } catch {
      return;
    }

    const dirType = TYPE_DIRNAMES[basename(dir).toLowerCase()] ?? null;
    const effectiveType = dirType ?? typeHint;
    if (effectiveType) {
      for (const entry of entries) {
        if (entry.isFile && entry.name.endsWith(".md")) {
          results.push({ type: effectiveType, path: join(dir, entry.name) });
        }
      }
    }

    for (const entry of entries) {
      if (entry.isDirectory) walk(join(dir, entry.name), depth + 1, effectiveType);
    }
  }

  walk(rootDir, 0, null);
  return results;
}

/** Clones `repoUrl` (same shallow clone InstallFromGitHubModal uses), finds every skill, agent,
 *  command, and rule under `subpath` (or the whole repo, if none given), and returns one
 *  DiscoverEntry per item found — cached manifest text and parsed frontmatter only, no companion
 *  files. The clone is always removed afterwards; nothing from it persists beyond what's read
 *  into the returned entries. */
export async function discoverGitSkills(repoUrl: string, ref: string, subpath: string): Promise<DiscoverEntry[]> {
  const clone = shallowCloneRepo(repoUrl, ref || undefined);
  try {
    const sourceRoot = subpath ? join(clone.dir, subpath) : clone.dir;
    if (!existsSync(sourceRoot)) {
      throw new Error(`"${subpath}" doesn't exist in this repo${ref ? ` at ${ref}` : ""}.`);
    }

    const found = findRepoManifests(sourceRoot);
    if (found.length === 0) {
      throw new Error(`Nothing found${subpath ? ` under "${subpath}"` : ""} in this repo.`);
    }

    const discoveredAt = Date.now();
    return found.map(({ type, path: manifestPath }) => {
      const manifestText = readFileSync(manifestPath, "utf-8");
      const fields = parseFrontmatter(manifestText);
      const find = (key: string) => fields.find((f) => f.key === key)?.value ?? "";

      // A skill's identity is its own folder; an agent/command/rule's identity is the .md file
      // itself (there's no wrapping folder to point at).
      const itemPath = type === "skill" ? dirname(manifestPath) : manifestPath;
      const relFromSourceRoot = relative(sourceRoot, itemPath).split(sep).join("/");
      const entrySubpath = [subpath, relFromSourceRoot].filter((s) => s && s !== ".").join("/");
      const fallbackName = type === "skill" ? basename(itemPath) : basename(itemPath).replace(/\.(?:instructions|prompt)\.md$|\.md$/, "");
      const name = find("name") || fallbackName;
      const tags = find("tags")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);

      return {
        id: discoverEntryId(repoUrl, entrySubpath, name),
        repoUrl,
        ref,
        subpath: entrySubpath,
        type,
        commit: clone.commit,
        name,
        description: find("description"),
        tags,
        manifestText,
        starCount: null,
        starsFetchedAt: null,
        discoveredAt,
      };
    });
  } finally {
    clone.cleanup();
  }
}

/** Re-fetches exactly one already-known catalog entry's manifest — used by a card's "Refresh"
 *  action. Deliberately NOT built on discoverGitSkills/findRepoManifests: those search a
 *  directory for items of unknown type/location, but a refresh already knows both (entry.type,
 *  entry.subpath) — and for an agent/command/rule, entry.subpath is a single .md *file*, which
 *  findRepoManifests can't walk (it expects a directory to search). Keeps id/type/subpath;
 *  refreshes content/commit/name/description/tags from upstream. */
export async function refetchDiscoverEntry(entry: DiscoverEntry): Promise<DiscoverEntry> {
  const clone = shallowCloneRepo(entry.repoUrl, entry.ref || undefined);
  try {
    const manifestPath = entry.type === "skill" ? join(clone.dir, entry.subpath, "SKILL.md") : join(clone.dir, entry.subpath);
    if (!existsSync(manifestPath)) {
      throw new Error(`"${entry.subpath}" no longer exists in this repo${entry.ref ? ` at ${entry.ref}` : ""}.`);
    }

    const manifestText = readFileSync(manifestPath, "utf-8");
    const fields = parseFrontmatter(manifestText);
    const find = (key: string) => fields.find((f) => f.key === key)?.value ?? "";
    const tags = find("tags")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    return {
      ...entry,
      commit: clone.commit,
      name: find("name") || entry.name,
      description: find("description"),
      tags,
      manifestText,
    };
  } finally {
    clone.cleanup();
  }
}

/** owner/repo out of any github.com URL form (https, .git suffix, trailing slash) — used both
 *  for the star-count API call and for the card's avatar image (github.com/{owner}.png). */
export function parseOwnerRepo(repoUrl: string): { owner: string; repo: string } | null {
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repoUrl.trim());
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

/** The browsable GitHub URL for a tracked skill/agent/command/rule — a Discover catalog entry
 *  or an already-installed item, anything carrying the same repoUrl/ref/subpath/commit quad.
 *  GitHub's web UI doesn't resolve "HEAD" as a browsable ref the way git itself does, so a
 *  subpath with no explicit branch/tag falls back to the pinned commit sha instead — always a
 *  valid /tree/<ref>/ segment on GitHub, unlike the literal string "HEAD". No subpath at all just
 *  links the repo itself (its default-branch landing page needs no ref in the URL). */
export function githubSourceUrl(repoUrl: string, ref: string, subpath: string, commit: string): string {
  const parsed = parseOwnerRepo(repoUrl);
  if (!parsed) return repoUrl;
  if (!subpath) {
    return ref ? `https://github.com/${parsed.owner}/${parsed.repo}/tree/${ref}` : `https://github.com/${parsed.owner}/${parsed.repo}`;
  }
  return `https://github.com/${parsed.owner}/${parsed.repo}/tree/${ref || commit}/${subpath}`;
}

/** One unauthenticated call to GitHub's public REST API for a repo's star count. Callers are
 *  responsible for only calling this at discovery/refresh time (never on render) — unauthenticated
 *  requests are capped at 60/hour per IP, so this is never retried or polled. A failure (network,
 *  rate limit, private repo) just means no star count shows, not a broken catalog entry. */
export async function fetchGithubStars(repoUrl: string): Promise<number | null> {
  const parsed = parseOwnerRepo(repoUrl);
  if (!parsed) return null;
  try {
    const res = await requestUrl({
      url: `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`,
      throw: false,
    });
    if (res.status !== 200) return null;
    const body: unknown = res.json;
    const stars = typeof body === "object" && body !== null && "stargazers_count" in body ? body.stargazers_count : null;
    return typeof stars === "number" ? stars : null;
  } catch (e) {
    console.warn("Couldn't fetch GitHub star count: " + errorMessage(e));
    return null;
  }
}
