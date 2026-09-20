import { App, Modal, Notice, setIcon } from "obsidian";
import { ProjectWorkspace } from "../types";
import { errorMessage } from "../errors";
import { projectIcon } from "../rescan";

export class ProjectPresenceModal extends Modal {
  constructor(
    app: App,
    private itemName: string,
    private projects: ProjectWorkspace[],
    private presentProjectIds: Set<string>,
    private onAdd: (project: ProjectWorkspace) => Promise<void>,
    private onRemove: (project: ProjectWorkspace) => Promise<void>
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("skillspace-modal");
    contentEl.createEl("h3", { text: "Workspaces" });
    contentEl.createEl("p", {
      text: `Check a project to symlink "${this.itemName}" into its local skills folder. The original is never copied, so it can't drift out of sync. Uncheck it to remove just that symlink; nothing is deleted.`,
      cls: "setting-item-description",
    });

    if (this.projects.length === 0) {
      contentEl.createEl("p", { text: "No workspaces registered yet. Add some in plugin settings." });
      return;
    }

    for (const project of this.projects) {
      const row = contentEl.createDiv({ cls: "skillspace-collection-picker-row" });
      const checkbox = row.createEl("input", { type: "checkbox" });
      checkbox.checked = this.presentProjectIds.has(project.id);
      checkbox.addEventListener("change", () => {
        void (async () => {
          const wantAdd = checkbox.checked;
          try {
            if (wantAdd) await this.onAdd(project);
            else await this.onRemove(project);
          } catch (e) {
            checkbox.checked = !wantAdd;
            new Notice("Failed: " + errorMessage(e));
          }
        })();
      });
      const iconEl = row.createSpan({ cls: "skillspace-collection-picker-icon" });
      setIcon(iconEl, projectIcon(project.id));
      row.createSpan({ text: ` ${project.name}` });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
