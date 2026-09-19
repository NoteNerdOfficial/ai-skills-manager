import { App, Modal } from "obsidian";

/** Generic Cancel/confirm prompt for a destructive action — currently just card deletion, but
 *  kept generic rather than baked into that one call site. */
export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private message: string,
    private confirmLabel: string,
    private onConfirm: () => void | Promise<void>
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("skillspace-modal");
    contentEl.createEl("h3", { text: this.title });
    contentEl.createEl("p", { text: this.message, cls: "skillspace-modal-meta" });

    const actions = contentEl.createDiv({ cls: "skillspace-modal-actions" });
    actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    actions
      .createEl("button", { text: this.confirmLabel, cls: "mod-warning" })
      .addEventListener("click", () => {
        void (async () => {
          await this.onConfirm();
          this.close();
        })();
      });
  }

  onClose() {
    this.contentEl.empty();
  }
}
