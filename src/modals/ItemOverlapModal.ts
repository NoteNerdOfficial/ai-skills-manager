import { App, Modal } from "obsidian";
import { ItemMetadata } from "../types";

/** Shows two enabled items whose name+description text looks like a near-duplicate, side by
 *  side, so the user can judge whether they're really doing the same job before disabling one. */
export class ItemOverlapModal extends Modal {
  constructor(
    app: App,
    private a: ItemMetadata,
    private b: ItemMetadata,
    private score: number,
    private sameName: boolean,
    private onDisable: (item: ItemMetadata) => void,
    private onDelete: (item: ItemMetadata) => void,
    private onOpenItem: (item: ItemMetadata) => void
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("skillmanager-modal");
    contentEl.createEl("h3", { text: "Possible overlap" });
    const reason = this.sameName
      ? "they share the same name"
      : `${Math.round(this.score * 100)}% description overlap`;
    contentEl.createEl("p", {
      text: `These two look like they cover the same job (${reason}). Consider keeping one.`,
      cls: "skillmanager-modal-meta",
    });

    for (const item of [this.a, this.b]) {
      const row = contentEl.createDiv({ cls: "skillmanager-dash-overlap-row" });
      const nameEl = row.createEl("strong", { text: item.name, cls: "skillmanager-dash-overlap-name" });
      nameEl.addEventListener("click", () => {
        this.onOpenItem(item);
        this.close();
      });
      row.createDiv({ text: `${item.tool} · ${item.type}`, cls: "skillmanager-modal-meta" });
      // Two rows can otherwise both read "claude-code · skill" and look like the exact same file
      // — this is what tells them apart when one is actually a symlink to somewhere else.
      if (item.realPath !== item.sourcePath) {
        row.createDiv({
          text: `→ symlinked from ${item.realPath}`,
          cls: "skillmanager-modal-meta skillmanager-detail-path-target",
        });
      }
      row.createEl("p", { text: item.description || "(no description)" });
      const actions = row.createDiv({ cls: "skillmanager-modal-actions" });
      actions
        .createEl("button", { text: `Disable "${item.name}"`, cls: "mod-warning" })
        .addEventListener("click", () => {
          this.onDisable(item);
          this.close();
        });
      actions.createEl("button", { text: "Delete" }).addEventListener("click", () => {
        this.close();
        this.onDelete(item);
      });
    }

    const closeActions = contentEl.createDiv({ cls: "skillmanager-modal-actions" });
    closeActions.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}
