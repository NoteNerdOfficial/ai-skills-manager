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
        if (fm?.entryId) items.push(this.fromFrontmatter(fm));
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

  /** Deletes shadow notes for items no longer found by the latest scan (e.g. a project-local
   *  symlink that was just removed), so removed items don't linger forever. */
  async pruneMissing(validEntryIds: Set<string>): Promise<void> {
    const folder = this.app.vault.getAbstractFileByPath(normalizePath(this.folder));
    if (!(folder instanceof TFolder)) return;
    for (const file of folder.children) {
      if (file instanceof TFile && file.extension === "md") {
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        const entryId = typeof fm?.entryId === "string" ? fm.entryId : null;
        if (entryId && !validEntryIds.has(entryId)) {
          await this.app.fileManager.trashFile(file);
        }
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
