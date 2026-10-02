import { existsSync } from "fs";
import { basename, dirname, isAbsolute, resolve } from "path";
import { parseFrontmatter } from "./scanners";
import { ItemMetadata } from "./types";

/** The Agent Skills spec caps a skill's description at this length; tools that follow it may
 *  truncate or reject anything longer. */
export const MAX_DESCRIPTION_CHARS = 1024;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_NAME_CHARS = 64;

/**
 * Problems that make an item silently fail to load or never trigger: broken frontmatter, a
 * missing or mismatched name, a missing description, a dangling symlink, or a markdown link to a
 * bundled file that isn't there. Pure apart from existsSync, and recomputed from the manifest
 * text whenever it's shown, so it always reflects what's on disk without any stored state.
 *
 * `parseYaml` is injected (Obsidian's own parser at runtime) so this module stays importable from
 * tests, where the obsidian package has no runtime code. Without it, YAML syntax isn't checked.
 */
export function checkIntegrity(
  item: Pick<ItemMetadata, "type" | "tool" | "sourcePath" | "realPath">,
  raw: string,
  parseYaml?: (yaml: string) => unknown
): string[] {
  const issues: string[] = [];
  if (item.realPath !== item.sourcePath && !existsSync(item.realPath)) {
    issues.push("Symlink target is missing");
  }

  if (item.type === "skill" || item.type === "agent") issues.push(...checkFrontmatter(item, raw, parseYaml));
  issues.push(...findBrokenLinks(raw, dirname(item.sourcePath)));
  return issues;
}

function checkFrontmatter(
  item: Pick<ItemMetadata, "type" | "tool" | "sourcePath">,
  raw: string,
  parseYaml?: (yaml: string) => unknown
): string[] {
  if (!/^---\r?\n/.test(raw)) return ["No frontmatter block"];
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!block) return ["Frontmatter block is never closed"];
  if (parseYaml) {
    try {
      parseYaml(block[1]);
    } catch {
      return ["Frontmatter isn't valid YAML, so the tool may skip this item"];
    }
  }

  const issues: string[] = [];
  const fields = parseFrontmatter(raw);
  const field = (key: string) => fields.find((f) => f.key === key)?.value.trim() ?? "";
  const name = field("name");
  const description = field("description");
  const manualOnly = field("disable-model-invocation") === "true";

  // Claude Code falls back to the folder name for a skill with no `name`; every other case
  // (agents everywhere, skills in other tools) needs it to load at all.
  if (!name && !(item.type === "skill" && item.tool === "claude-code")) issues.push("Missing name");

  const isFolderSkill = item.type === "skill" && basename(item.sourcePath).toLowerCase() === "skill.md";
  if (name && item.type === "skill") {
    if (!SKILL_NAME_PATTERN.test(name) || name.length > MAX_SKILL_NAME_CHARS) {
      issues.push("Name should be lowercase letters, numbers and hyphens (64 max)");
    }
    const folder = basename(dirname(item.sourcePath));
    if (isFolderSkill && folder !== name) issues.push(`Name "${name}" doesn't match folder "${folder}"`);
  }

  if (!description && !manualOnly) {
    issues.push("Missing description, so it can't be picked automatically");
  } else if (description.length > MAX_DESCRIPTION_CHARS) {
    issues.push(`Description is over ${MAX_DESCRIPTION_CHARS.toLocaleString()} characters`);
  }
  return issues;
}

/** Relative markdown links (`[x](scripts/run.py)`) whose target doesn't exist next to the file.
 *  URLs, anchors and absolute paths are skipped, and so is anything inside code, where a link
 *  is usually an example rather than a real reference. */
export function findBrokenLinks(raw: string, baseDir: string): string[] {
  const text = raw
    .replace(/^---\r?\n[\s\S]*?\r?\n---/, "")
    .replace(/^(```|~~~)[\s\S]*?^\1/gm, "")
    .replace(/`[^`\n]*`/g, "");
  const broken = new Set<string>();
  for (const match of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const target = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("~")) continue;
    if (isAbsolute(target)) continue;
    let path = target.replace(/[#?].*$/, "");
    if (!path) continue;
    try {
      path = decodeURIComponent(path);
    } catch {
      // Keep the raw target; a malformed escape is still worth checking as-is.
    }
    if (!existsSync(resolve(baseDir, path))) broken.add(path);
  }
  return [...broken].map((path) => `Broken link: ${path}`);
}
