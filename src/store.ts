import { App, TFile, TFolder, normalizePath } from "obsidian";
import { slug } from "./format";
import { DiscoveredItem, ItemMetadata, ItemType } from "./types";

/**
 * Persists per-item metadata (tags, favorite, collection membership) as frontmatter-only
 * "shadow" notes in a vault folder, instead of the hidden plugin data.json. This is what makes
 * the library state sync via the user's existing vault sync and be queryable from Dataview/Bases.
 *
 * Keyed by entryId, not the item's current file path — enabling/disabling an item physically
 * moves its file, so the path can't be used as a stable identity.
 */
/** How long a missing item's note is kept before it's trashed (see pruneMissing). */
const MISSING_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class ShadowNoteStore {
  constructor(
    private app: App,
    private folder: string
  ) {}

  setFolder(folder: string) {
    this.folder = folder;
  }

  private async ensureFolder(): Promise<void> {
    const path = normalizePath(this.folder);
    if (!this.app.vault.getAbstractFileByPath(path)) {
      await this.app.vault.createFolder(path);
    }
  }

  private notePath(entryId: string): string {
    return normalizePath(`${this.folder}/${slug(entryId)}.md`);
  }

  async list(): Promise<ItemMetadata[]> {
    const folder = this.app.vault.getAbstractFileByPath(normalizePath(this.folder));
    if (!(folder instanceof TFolder)) return [];

    const items: ItemMetadata[] = [];
    for (const file of folder.children) {
      if (file instanceof TFile && file.extension === "md") {
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        // A note kept for a missing item (see pruneMissing) stays out of the library until it's back.
        if (fm?.entryId && !fm.missingSince) items.push(this.fromFrontmatter(fm));
      }
    }
    return items;
  }

  async ensureItem(discovered: DiscoveredItem): Promise<ItemMetadata> {
    await this.ensureFolder();
    const path = this.notePath(discovered.entryId);
    const existing = this.app.vault.getAbstractFileByPath(path);
    const file = existing instanceof TFile ? existing : await this.app.vault.create(path, "---\n---\n");

    let metadata!: ItemMetadata;
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      // Source-derived fields track the file on disk; user-owned fields are seeded once.
      fm.entryId = discovered.entryId;
      fm.sourcePath = discovered.sourcePath;
      fm.realPath = discovered.realPath;
      fm.tool = discovered.tool;
      fm.type = discovered.type;
      fm.projectId = discovered.projectId;
      fm.pluginId = discovered.pluginId;
      fm.name = discovered.name;
      fm.description = discovered.description;
      fm.enabled = discovered.enabled;
      delete fm.missingSince;
      if (fm.tags === undefined) fm.tags = [];
      if (fm.favorite === undefined) fm.favorite = false;
      if (fm.collections === undefined) fm.collections = [];
      metadata = this.fromFrontmatter(fm);
    });
    return metadata;
  }

  async update(entryId: string, changes: Partial<ItemMetadata>): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(this.notePath(entryId));
    if (!(file instanceof TFile)) return;
    await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
      Object.assign(fm, changes);
    });
  }

  /** Carries a note over to an item's new entryId when the ID scheme changes but the item itself
   *  didn't (e.g. 0.1.7 started folding the path into entryId). Without this, the old note looks
   *  orphaned, pruneMissing trashes it, and the item's tags, favorite, collections and GitHub
   *  source info are lost. Matched on tool/type/project/plugin plus the source path with any
   *  disabled-folder segment stripped, so an item that's since been toggled still matches. */
  async adoptRenamed(discovered: DiscoveredItem[], stablePath: (sourcePath: string) => string): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(normalizePath(this.folder));
    if (!(folder instanceof TFolder)) return;
    const key = (tool: unknown, type: unknown, projectId: unknown, pluginId: unknown, sourcePath: string) =>
      [tool, type, projectId ?? "", pluginId ?? "", stablePath(sourcePath)].join("\u0000");
    const discoveredIds = new Set(discovered.map((d) => d.entryId));
    const byKey = new Map(discovered.map((d) => [key(d.tool, d.type, d.projectId, d.pluginId, d.sourcePath), d]));
    for (const file of [...folder.children]) {
      if (!(file instanceof TFile) || file.extension !== "md") continue;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (typeof fm?.entryId !== "string" || discoveredIds.has(fm.entryId) || typeof fm.sourcePath !== "string") continue;
      const match = byKey.get(key(fm.tool, fm.type, fm.projectId, fm.pluginId, fm.sourcePath));
      if (!match) continue;
      const newPath = this.notePath(match.entryId);
      if (this.app.vault.getAbstractFileByPath(newPath)) continue;
      await this.app.fileManager.renameFile(file, newPath);
      await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
        frontmatter.entryId = match.entryId;
      });
    }
  }

  /** Handles notes for items the latest scan didn't find (deleted, or a project-local symlink
   *  that was just removed). The first time, the note is only marked with `missingSince` and
   *  hidden from the library, so an item that comes back (e.g. Put Back from the Trash) keeps its
   *  tags, favorite, collections and GitHub source info. It's trashed once it has been missing
   *  for MISSING_RETENTION_MS, so removed items still don't linger forever. */
  async pruneMissing(validEntryIds: Set<string>): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(normalizePath(this.folder));
    if (!(folder instanceof TFolder)) return;
    const now = Date.now();
    for (const file of [...folder.children]) {
      if (!(file instanceof TFile) || file.extension !== "md") continue;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const entryId = typeof fm?.entryId === "string" ? fm.entryId : null;
      if (!entryId || validEntryIds.has(entryId)) continue;
      const missingSince = typeof fm?.missingSince === "string" ? Date.parse(fm.missingSince) : NaN;
      if (Number.isNaN(missingSince)) {
        await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
          frontmatter.missingSince = new Date(now).toISOString();
        });
      } else if (now - missingSince > MISSING_RETENTION_MS) {
        await this.app.fileManager.trashFile(file);
      }
    }
  }

  private fromFrontmatter(fm: Record<string, unknown>): ItemMetadata {
    const asString = (value: unknown): string => (typeof value === "string" ? value : "");
    return {
      entryId: asString(fm.entryId),
      sourcePath: asString(fm.sourcePath),
      realPath: asString(fm.realPath) || asString(fm.sourcePath),
      tool: asString(fm.tool),
      type: (fm.type as ItemType) ?? "skill",
      projectId: typeof fm.projectId === "string" ? fm.projectId : null,
      pluginId: typeof fm.pluginId === "string" ? fm.pluginId : null,
      name: asString(fm.name),
      description: asString(fm.description),
      enabled: fm.enabled !== false,
      tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : [],
      favorite: Boolean(fm.favorite),
      collections: Array.isArray(fm.collections) ? (fm.collections as string[]) : [],
      sourceRepo: typeof fm.sourceRepo === "string" ? fm.sourceRepo : undefined,
      sourceRef: typeof fm.sourceRef === "string" ? fm.sourceRef : undefined,
      sourceSubpath: typeof fm.sourceSubpath === "string" ? fm.sourceSubpath : undefined,
      sourceCommit: typeof fm.sourceCommit === "string" ? fm.sourceCommit : undefined,
    };
  }
}
