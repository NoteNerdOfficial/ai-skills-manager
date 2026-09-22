import { App, Modal, Setting } from "obsidian";
import { Collection, ItemMetadata, SkillManagerPluginSettings } from "../types";

export class AddToCollectionModal extends Modal {
  private newName = "";

  constructor(
    app: App,
    private settings: SkillManagerPluginSettings,
    private item: ItemMetadata,
    private onToggle: (collection: Collection, add: boolean) => Promise<void>,
    private onCreate: (name: string) => Promise<void>
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("skillmanager-modal");
    contentEl.createEl("h3", { text: "Add to collection" });

    if (this.settings.collections.length === 0) {
      contentEl.createEl("p", { text: "No collections yet.", cls: "setting-item-description" });
    }

    for (const collection of this.settings.collections) {
      const row = contentEl.createDiv({ cls: "skillmanager-collection-picker-row" });
      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.checked = this.item.collections.includes(collection.id);
      checkbox.addEventListener("change", () => {
        void this.onToggle(collection, checkbox.checked);
      });
      row.createSpan({ text: ` ${collection.name}` });
    }

    new Setting(contentEl)
      .setName("New collection")
      .addText((text) =>
        text.setPlaceholder("Name").onChange((value) => {
          this.newName = value;
        })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Create")
          .setCta()
          .onClick(async () => {
            if (!this.newName.trim()) return;
            await this.onCreate(this.newName.trim());
            this.close();
          })
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}
