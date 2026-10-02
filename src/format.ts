export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function formatTokens(charCount: number): string {
  const estimate = Math.round(charCount / 4);
  return estimate >= 1000 ? `~${(estimate / 1000).toFixed(1)}k tokens` : `~${estimate} tokens`;
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function stripFrontmatter(raw: string): string {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

export function slug(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "item"
  );
}

/** "Today", "Yesterday", "3d ago", "5w ago", then a plain date past two months. 0 means never. */
export function formatRelativeDay(ms: number, now = Date.now()): string {
  if (ms === 0) return "Never";
  const days = Math.floor((now - ms) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  return formatDate(ms);
}
