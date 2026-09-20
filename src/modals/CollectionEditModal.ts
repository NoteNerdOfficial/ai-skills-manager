import { App, Modal, Setting, setIcon } from "obsidian";
import { Collection, ItemMetadata } from "../types";

export class CollectionEditModal extends Modal {
  private name: string;
  private selected: Set<string>;
  private rows: { row: HTMLElement; name: string }[] = [];

  constructor(
    app: App,
    private existing: Collection | null,
    private items: ItemMetadata[],
    private onSave: (collection: Collection) => Promise<void>
  ) {
    super(app);
    this.name = existing?.name ?? "";
    this.selected = new Set(existing?.itemIds ?? []);
  }

  onOpen() {
    const { contentEl } = this;
    this.rows = [];
    contentEl.addClass("skillspace-modal");
    contentEl.createEl("h3", { text: this.existing ? "Edit collection" : "New collection" });

    new Setting(contentEl).setName("Name").addText((text) =>
      text.setValue(this.name).onChange((value) => {
        this.name = value;
      })
    );

    contentEl.createEl("p", { text: "Members", cls: "setting-item-description" });

    if (this.items.length > 0) {
      const searchWrap = contentEl.createDiv({ cls: "skillspace-search-wrap" });
      const searchIcon = searchWrap.createSpan({ cls: "skillspace-search-icon" });
      setIcon(searchIcon, "search");
      const searchInput = searchWrap.createEl("input", {
        type: "text",
        placeholder: "Filter skills…",
        cls: "skillspace-search",
      });
      const clearBtn = searchWrap.createEl("button", {
        cls: "skillspace-icon-btn skillspace-search-clear",
        attr: { "aria-label": "Clear search" },
      });
      setIcon(clearBtn, "x");
      const updateClearBtn = () => clearBtn.toggle(searchInput.value.length > 0);
      updateClearBtn();

      searchInput.addEventListener("input", () => {
        updateClearBtn();
        this.filterRows(searchInput.value);
      });
      clearBtn.addEventListener("click", () => {
        searchInput.value = "";
        updateClearBtn();
        this.filterRows("");
        searchInput.focus();
      });
    }

    const list = contentEl.createDiv({ cls: "skillspace-collection-picker" });
    if (this.items.length === 0) {
      list.createEl("p", { text: "No items yet — rescan tools from the library view first." });
    }
    for (const item of this.items) {
      const row = list.createDiv({ cls: "skillspace-collection-picker-row" });
      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.checked = this.selected.has(item.entryId);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.selected.add(item.entryId);
        else this.selected.delete(item.entryId);
      });
      row.createSpan({ text: ` ${item.name}` });
      this.rows.push({ row, name: item.name.toLowerCase() });
    }

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Save")
        .setCta()
        .onClick(async () => {
          if (!this.name.trim()) return;
          const collection: Collection = {
            id: this.existing?.id ?? `col-${Date.now()}`,
            name: this.name.trim(),
            itemIds: Array.from(this.selected),
          };
          await this.onSave(collection);
          this.close();
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }

  private filterRows(query: string) {
    const q = query.trim().toLowerCase();
    for (const { row, name } of this.rows) {
      row.toggle(!q || name.includes(q));
    }
  }
}
