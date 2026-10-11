import { App, Modal, Setting } from "obsidian";
import { ProjectWorkspace, ToolConfig } from "../types";

export class ProjectEditModal extends Modal {
  private name: string;
  private path: string;
  private sourceRepoToolId: string | undefined;

  constructor(
    app: App,
    private existing: ProjectWorkspace | null,
    private onSave: (project: ProjectWorkspace) => Promise<void>,
    private tools: ToolConfig[] = []
  ) {
    super(app);
    this.name = existing?.name ?? "";
    this.path = existing?.path ?? "";
    this.sourceRepoToolId = existing?.sourceRepoToolId;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("skillmanager-modal");
    this.setTitle(this.existing ? "Edit workspace" : "New workspace");
    contentEl.createEl("p", {
      text: "A project folder to scan for project-local skills (e.g. <project>/.claude/skills), in addition to the current vault, which is always included automatically. Turn on Source repo for a repo that keeps them at its top level.",
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

    // Tools whose items a repo can hold: any with a skills, agents or commands folder.
    const repoTools = this.tools.filter((t) => !t.disabled && (t.paths.skill || t.paths.agent || t.paths.command));
    if (repoTools.length > 0) {
      let toolSetting: Setting | null = null;
      new Setting(contentEl)
        .setName("Source repo")
        .setDesc("For a folder that houses skills, agents, commands or mods at its top level rather than in a tool's project folders. They're listed under this workspace, and links to them lead back here.")
        .addToggle((toggle) =>
          toggle.setValue(!!this.sourceRepoToolId).onChange((on) => {
            this.sourceRepoToolId = on ? (this.sourceRepoToolId ?? (repoTools.find((t) => t.devModsPath) ?? repoTools[0]).id) : undefined;
            toolSetting?.settingEl.toggle(on);
          })
        );
      toolSetting = new Setting(contentEl)
        .setName("Listed as")
        .setDesc("The tool its items are shown under.")
        .addDropdown((dropdown) => {
          for (const tool of repoTools) dropdown.addOption(tool.id, tool.name);
          dropdown.setValue(this.sourceRepoToolId ?? (repoTools.find((t) => t.devModsPath) ?? repoTools[0]).id).onChange((value) => {
            this.sourceRepoToolId = value;
          });
        });
      toolSetting.settingEl.toggle(!!this.sourceRepoToolId);
    }

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Save")
        .setCta()
        .onClick(async () => {
          if (!this.name.trim() || !this.path.trim()) return;
          const project: ProjectWorkspace = {
            ...this.existing,
            id: this.existing?.id ?? `proj-${Date.now()}`,
            name: this.name.trim(),
            path: this.path.trim(),
            sourceRepoToolId: this.sourceRepoToolId,
          };
          if (!project.sourceRepoToolId) delete project.sourceRepoToolId;
          await this.onSave(project);
          this.close();
        })
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}
