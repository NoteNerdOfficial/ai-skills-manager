import { App, Modal } from "obsidian";

/** Generic Cancel/confirm prompt for a destructive action — currently just card deletion, but
 *  kept generic rather than baked into that one call site. */
export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private message: string,
    private confirmLabel: string,
    private onConfirm: () => void | Promise<void>,
    /** "cta" for a constructive confirm (e.g. Enable), so red stays reserved for real risk. */
    private variant: "warning" | "cta" = "warning"
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("skillmanager-modal");
    this.setTitle(this.title);
    contentEl.createEl("p", { text: this.message, cls: "skillmanager-modal-meta" });

    const actions = contentEl.createDiv({ cls: "skillmanager-modal-actions" });
    actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    actions
      .createEl("button", { text: this.confirmLabel, cls: this.variant === "cta" ? "mod-cta" : "mod-warning" })
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
