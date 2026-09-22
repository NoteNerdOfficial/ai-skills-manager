import { App, Modal, Setting } from "obsidian";
import { ProjectWorkspace } from "../types";

export class ProjectEditModal extends Modal {
  private name: string;
  private path: string;

  constructor(
    app: App,
    private existing: ProjectWorkspace | null,
    private onSave: (project: ProjectWorkspace) => Promise<void>
  ) {
    super(app);
    this.name = existing?.name ?? "";
    this.path = existing?.path ?? "";
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("skillmanager-modal");
    contentEl.createEl("h3", { text: this.existing ? "Edit workspace" : "New workspace" });
    contentEl.createEl("p", {
      text: "A project folder to scan for project-local skills (e.g. <project>/.claude/skills), in addition to the current vault, which is always included automatically.",
      cls: "setting-item-description",
    });

    new Setting(contentEl).setName("Name").addText((text) =>
      text.setValue(this.name).onChange((value) => {
        this.name = value;
      })
    );
    new Setting(contentEl).setName("Path").addText((text) =>
      text
        .setPlaceholder("~/path/to/project")
        .setValue(this.path)
        .onChange((value) => {
          this.path = value;
        })
    );

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Save")
        .setCta()
        .onClick(async () => {
          if (!this.name.trim() || !this.path.trim()) return;
          const project: ProjectWorkspace = {
            id: this.existing?.id ?? `proj-${Date.now()}`,
            name: this.name.trim(),
            path: this.path.trim(),
          };
          await this.onSave(project);
          this.close();
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}
