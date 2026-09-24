import { App, Modal } from "obsidian";

/** Explains a repository-only commit and lets the user acknowledge it without replacing the
 * normal file preview with a context-only diff. */
export class UnchangedUpdateModal extends Modal {
  constructor(
    app: App,
    private itemName: string,
    private onDone: () => void | Promise<void>
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("skillmanager-modal");
    contentEl.createEl("h3", { text: `No file changes for “${this.itemName}”` });
    contentEl.createEl("p", {
      text: "The source repository has a newer commit, but this command or skill file is unchanged. The repository update has been accepted and your local file was left as-is.",
      cls: "skillmanager-modal-meta",
    });

    const actions = contentEl.createDiv({ cls: "skillmanager-modal-actions" });
    actions.createEl("button", { text: "Done", cls: "mod-cta" }).addEventListener("click", () => {
      void (async () => {
        await this.onDone();
        this.close();
      })();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}
