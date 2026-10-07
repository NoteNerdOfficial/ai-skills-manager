import { requestUrl } from "obsidian";

const LATEST_RELEASE_URL = "https://api.github.com/repos/NoteNerdOfficial/ai-skills-manager/releases/latest";

/** Opens this plugin's page in Obsidian's Community plugins browser, which has the Update button. */
export const COMMUNITY_PLUGIN_URL = "obsidian://show-plugin?id=ai-skills-manager";

/** `unknown` means the check hasn't finished yet or couldn't reach GitHub (offline, rate limited). */
export type PluginVersionStatus =
  | { state: "unknown"; installed: string }
  | { state: "current"; installed: string }
  | { state: "outdated"; installed: string; latest: string };

/** Numeric x.y.z comparison; missing or non-numeric parts count as 0. Positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((part) => parseInt(part, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((part) => parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Latest published release tag on GitHub, which is what Obsidian's own update check installs. */
export async function fetchLatestPluginVersion(): Promise<string | null> {
  try {
    const res = await requestUrl({ url: LATEST_RELEASE_URL, headers: { Accept: "application/vnd.github+json" } });
    const tag = (res.json as { tag_name?: unknown }).tag_name;
    return typeof tag === "string" && tag.trim() ? tag.trim().replace(/^v/, "") : null;
  } catch {
    return null;
  }
}

export function versionStatus(installed: string, latest: string | null): PluginVersionStatus {
  if (!latest) return { state: "unknown", installed };
  return compareVersions(latest, installed) > 0 ? { state: "outdated", installed, latest } : { state: "current", installed };
}
