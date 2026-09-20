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
    private onDisable: (item: ItemMetadata) => void
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("skillspace-modal");
    contentEl.createEl("h3", { text: "Possible overlap" });
    contentEl.createEl("p", {
      text: `These two look like they cover the same job (${Math.round(this.score * 100)}% description overlap). Consider keeping one.`,
      cls: "skillspace-modal-meta",
    });

    for (const item of [this.a, this.b]) {
      const row = contentEl.createDiv({ cls: "skillspace-dash-overlap-row" });
      row.createEl("strong", { text: item.name });
      row.createDiv({ text: `${item.tool} · ${item.type}`, cls: "skillspace-modal-meta" });
      row.createEl("p", { text: item.description || "(no description)" });
      const actions = row.createDiv({ cls: "skillspace-modal-actions" });
      actions
        .createEl("button", { text: `Disable "${item.name}"`, cls: "mod-warning" })
        .addEventListener("click", () => {
          this.onDisable(item);
          this.close();
        });
    }

    const closeActions = contentEl.createDiv({ cls: "skillspace-modal-actions" });
    closeActions.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}
