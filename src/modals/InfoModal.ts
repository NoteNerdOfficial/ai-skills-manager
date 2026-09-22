import { App, Modal } from "obsidian";

/** Generic "here's the detail" popup for a link/icon that's too small to carry a full paragraph
 *  inline — currently just the Dashboard's "Why this matters" context-cost explainer, kept
 *  generic rather than baked into that one call site. */
export class InfoModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private message: string
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("skillmanager-modal");
    contentEl.createEl("h3", { text: this.title });
    contentEl.createEl("p", { text: this.message, cls: "skillmanager-modal-meta" });

    const actions = contentEl.createDiv({ cls: "skillmanager-modal-actions" });
    actions.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}
