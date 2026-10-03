import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join, sep } from "path";
import { DISABLED_DIRNAME, previewToggle, toggleItemEnabled } from "./itemToggle";
import { expandHome, parseSourceMeta, scanDirectory, stableEntryPath } from "./scanners";
import { DiscoveredItem, ItemMetadata, ProjectWorkspace, ToolConfig } from "./types";

/** The index file an agent loads every session, pointing at the individual memory files beside
 *  it (Claude Code's auto-memory convention). Only acted on when it actually exists, so a tool
 *  whose memory folder has no index just gets its files listed. */
export const MEMORY_INDEX_FILENAME = "MEMORY.md";

/** Inside a memory folder's DISABLED_DIRNAME: filename -> the index line(s) removed when that
 *  memory was disabled, so re-enabling restores the exact original pointer text. Not a .md file,
 *  so the scanner never lists it. */
const DISABLED_INDEX_SIDECAR = "memory-index.json";

/** Claude Code names a project's folder under ~/.claude/projects after its absolute path with
 *  every non-alphanumeric character swapped for "-" (/Users/me/my.app -> -Users-me-my-app). */
export function projectSlug(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, "-");
}

export function memoryRoot(tool: ToolConfig): string | null {
  const raw = tool.memoryPath?.trim();
  return raw ? expandHome(raw) : null;
}

export function projectMemoryDir(tool: ToolConfig, project: ProjectWorkspace): string | null {
  const raw = tool.projectMemoryPath?.trim();
  return raw ? join(expandHome(project.path), raw) : null;
}

function isUnder(path: string, root: string): boolean {
  return path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Whether an item came from one of this tool's memory folders (global, or the project-scoped one
 *  inside the item's own workspace) rather than its rules paths. Derived from the path each time
 *  instead of stored, so changing a memory path in settings reclassifies everything on the next
 *  render without touching the shadow notes. */
export function isMemoryItem(
  item: Pick<ItemMetadata, "sourcePath" | "projectId">,
  tool: ToolConfig | undefined,
  projects: ProjectWorkspace[] = []
): boolean {
  if (!tool) return false;
  const path = stableEntryPath(item.sourcePath);
  const root = memoryRoot(tool);
  if (root && isUnder(path, root)) return true;
  const project = item.projectId ? projects.find((p) => p.id === item.projectId) : undefined;
  const projectDir = project ? projectMemoryDir(tool, project) : null;
  return projectDir !== null && isUnder(path, projectDir);
}

export function isMemoryIndex(item: Pick<ItemMetadata, "sourcePath">): boolean {
  return basename(stableEntryPath(item.sourcePath)) === MEMORY_INDEX_FILENAME;
}

function childDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/** Two layouts, told apart from disk: Claude Code's per-project one (<root>/<project-slug>/memory/
 *  *.md, where the slug is matched back to a registered workspace), or a plain folder of memory
 *  files treated as global. A per-project folder whose slug matches no workspace is still listed,
 *  as global, so nothing an agent has written stays hidden. */
export function scanMemories(tool: ToolConfig, projects: ProjectWorkspace[]): DiscoveredItem[] {
  const root = memoryRoot(tool);
  if (!root || !existsSync(root)) return [];

  const projectDirs = childDirs(root).filter((name) => existsSync(join(root, name, "memory")));
  if (projectDirs.length === 0) return scanDirectory(root, tool, "rule", null, null);

  // Lowercased: macOS paths are case-insensitive, and a workspace registered as ~/documents/...
  // should still match a slug Claude Code wrote as -Users-me-Documents-...
  const bySlug = new Map(projects.map((p) => [projectSlug(expandHome(p.path)).toLowerCase(), p.id]));
  return projectDirs.flatMap((name) =>
    scanDirectory(join(root, name, "memory"), tool, "rule", bySlug.get(name.toLowerCase()) ?? null, null)
  );
}

/** The in-repo memory folder (ToolConfig.projectMemoryPath) of every workspace, read flat. */
export function scanProjectMemories(tool: ToolConfig, projects: ProjectWorkspace[]): DiscoveredItem[] {
  return projects.flatMap((project) => {
    const dir = projectMemoryDir(tool, project);
    return dir ? scanDirectory(dir, tool, "rule", project.id, null) : [];
  });
}

export function scanAllMemories(tools: ToolConfig[], projects: ProjectWorkspace[]): DiscoveredItem[] {
  return tools.flatMap((tool) => [...scanMemories(tool, projects), ...scanProjectMemories(tool, projects)]);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches a markdown link whose target is exactly this file (optionally "./"-prefixed). */
function linkPattern(fileName: string): RegExp {
  return new RegExp(`\\]\\(\\s*<?(?:\\./)?${escapeRegExp(fileName)}>?(?:\\s+"[^"]*")?\\s*\\)`);
}

export function indexLinksTo(indexText: string, fileName: string): boolean {
  return linkPattern(fileName).test(indexText);
}

/** Drops every index line linking to fileName. Returns the removed lines (joined), or null when
 *  there's no index or nothing linked to it. */
function removeIndexLines(indexPath: string, fileName: string): string | null {
  if (!existsSync(indexPath)) return null;
  const text = readFileSync(indexPath, "utf-8");
  const pattern = linkPattern(fileName);
  const lines = text.split("\n");
  const removed = lines.filter((line) => pattern.test(line));
  if (removed.length === 0) return null;
  writeFileSync(indexPath, lines.filter((line) => !pattern.test(line)).join("\n"));
  return removed.join("\n");
}

function appendIndexLine(indexPath: string, fileName: string, line: string): void {
  if (!existsSync(indexPath)) return;
  const text = readFileSync(indexPath, "utf-8");
  if (indexLinksTo(text, fileName)) return;
  const separator = text === "" || text.endsWith("\n") ? "" : "\n";
  writeFileSync(indexPath, `${text}${separator}${line}\n`);
}

function readSidecar(memoryDir: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(memoryDir, DISABLED_DIRNAME, DISABLED_INDEX_SIDECAR), "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeSidecar(memoryDir: string, entries: Record<string, string>): void {
  const path = join(memoryDir, DISABLED_DIRNAME, DISABLED_INDEX_SIDECAR);
  if (Object.keys(entries).length === 0) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  writeFileSync(path, JSON.stringify(entries, null, 2) + "\n");
}

/** Fallback pointer for a memory with no saved index line (e.g. one disabled by hand). */
function generatedIndexLine(filePath: string, fileName: string): string {
  let meta = { name: "", description: "" };
  try {
    meta = parseSourceMeta(readFileSync(filePath, "utf-8").slice(0, 4000));
  } catch {
    // Fall back to the filename alone.
  }
  const title = meta.name || fileName.replace(/\.md$/, "");
  return `- [${title}](${fileName})${meta.description ? `: ${meta.description}` : ""}`;
}

/** toggleItemEnabled, plus keeping the folder's MEMORY.md in step: disabling removes the
 *  memory's pointer line (stashing it so it can come back verbatim), enabling restores it. The
 *  file move happens first, so a failed move leaves the index untouched. The index file itself
 *  toggles like any other file, which switches off every memory in that folder at once. */
export function toggleMemoryEnabled(item: ItemMetadata): void {
  if (isMemoryIndex(item)) {
    toggleItemEnabled(item);
    return;
  }
  const { willDisable, fromPath, toPath } = previewToggle(item);
  toggleItemEnabled(item);
  const memoryDir = dirname(willDisable ? fromPath : toPath);
  const fileName = basename(willDisable ? fromPath : toPath);
  const indexPath = join(memoryDir, MEMORY_INDEX_FILENAME);
  const sidecar = readSidecar(memoryDir);

  if (willDisable) {
    const removed = removeIndexLines(indexPath, fileName);
    if (removed !== null) writeSidecar(memoryDir, { ...sidecar, [fileName]: removed });
  } else {
    appendIndexLine(indexPath, fileName, sidecar[fileName] ?? generatedIndexLine(toPath, fileName));
    delete sidecar[fileName];
    writeSidecar(memoryDir, sidecar);
  }
}

/** Index cleanup after a memory file is deleted: drops its pointer (enabled) or its stashed
 *  pointer (disabled), so neither MEMORY.md nor the sidecar points at a file that's gone. */
export function forgetMemoryIndexEntry(item: ItemMetadata): void {
  if (isMemoryIndex(item)) return;
  const stablePath = stableEntryPath(item.sourcePath);
  const memoryDir = dirname(stablePath);
  const fileName = basename(stablePath);
  if (item.enabled) {
    removeIndexLines(join(memoryDir, MEMORY_INDEX_FILENAME), fileName);
  } else {
    const sidecar = readSidecar(memoryDir);
    delete sidecar[fileName];
    writeSidecar(memoryDir, sidecar);
  }
}

/** An enabled memory the folder's index never points to: the agent only reads the index up
 *  front, so this file is effectively invisible. Missing index targets need no check here; they
 *  surface as broken links on the index file itself (see integrity.ts's findBrokenLinks). */
export function checkMemoryIndexed(item: Pick<ItemMetadata, "sourcePath" | "enabled">): string[] {
  if (!item.enabled || isMemoryIndex(item)) return [];
  const indexPath = join(dirname(item.sourcePath), MEMORY_INDEX_FILENAME);
  if (!existsSync(indexPath)) return [];
  try {
    if (indexLinksTo(readFileSync(indexPath, "utf-8"), basename(item.sourcePath))) return [];
  } catch {
    return [];
  }
  return [`Not listed in ${MEMORY_INDEX_FILENAME}, so it's never loaded`];
}
