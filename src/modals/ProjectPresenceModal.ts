import { App, Modal, Notice, setIcon } from "obsidian";
import { homedir } from "os";
import { ProjectWorkspace } from "../types";
import { errorMessage } from "../errors";
import { projectIcon } from "../rescan";

export interface ProjectPresenceOptions {
  /** Shown under the description, for a caveat that only applies to this item. */
  note?: string;
  /** Offers a "Global" row, for an item kept outside the tool's user folder, that symlinks it
   *  there so every session sees it; checked when that link already exists. */
  userScope?: { present: boolean; onAdd: () => Promise<void>; onRemove: () => Promise<void> };
  /** Where the item really sits: a workspace, the tool's user folder itself, or a folder that's
   *  neither. Shown apart from the checkboxes, locked, since it isn't a link and can't be unlinked. */
  keptIn?: { kind: "project"; id: string } | { kind: "global" } | { kind: "folder"; path: string };
}

export class ProjectPresenceModal extends Modal {
  constructor(
    app: App,
    private itemName: string,
    private projects: ProjectWorkspace[],
    private presentProjectIds: Set<string>,
    private onAdd: (project: ProjectWorkspace) => Promise<void>,
    private onRemove: (project: ProjectWorkspace) => Promise<void>,
    private options: ProjectPresenceOptions = {}
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    const { userScope, note, keptIn } = this.options;
    const sourceProjectId = keptIn?.kind === "project" ? keptIn.id : undefined;
    contentEl.addClass("skillmanager-modal");
    this.setTitle("Workspaces");
    contentEl.createEl("p", {
      text: userScope
        ? `Check Global to symlink "${this.itemName}" into your user folder so every session loads it, or a project to symlink it into that project's local folder. The original is never copied, so it can't drift out of sync. Uncheck one to remove just that symlink; nothing is deleted.`
        : `Check a project to symlink "${this.itemName}" into its local folder. The original is never copied, so it can't drift out of sync. Uncheck it to remove just that symlink; nothing is deleted.`,
      cls: "setting-item-description",
    });
    if (note) contentEl.createEl("p", { text: note, cls: "setting-item-description mod-warning" });

    // Where the item really sits: not a link, so it's stated rather than offered as a checkbox.
    const project = sourceProjectId ? this.projects.find((p) => p.id === sourceProjectId) : undefined;
    const home = homedir();
    const source =
      keptIn?.kind === "global"
        ? { icon: "globe", label: "Global" }
        : keptIn?.kind === "folder"
          ? { icon: "folder", label: keptIn.path.startsWith(home) ? "~" + keptIn.path.slice(home.length) : keptIn.path }
          : project
            ? { icon: projectIcon(project.id), label: project.name }
            : null;
    if (source) {
      contentEl.createDiv({ cls: "skillmanager-picker-section", text: "Kept in" });
      const row = contentEl.createDiv({ cls: "skillmanager-collection-picker-row is-source" });
      row.setAttr("aria-label", `${source.label}, where "${this.itemName}" is kept. It isn't a link, so it can't be unlinked.`);
      // An invisible checkbox sizes the slot, so the lock lines up with the rows below in any theme.
      const lock = row.createSpan({ cls: "skillmanager-picker-lock" });
      lock.createEl("input", { type: "checkbox", attr: { tabindex: "-1", "aria-hidden": "true", disabled: "" } });
      setIcon(lock.createSpan({ cls: "skillmanager-picker-lock-icon" }), "lock");
      setIcon(row.createSpan({ cls: "skillmanager-collection-picker-icon" }), source.icon);
      row.createSpan({ text: source.label, cls: keptIn?.kind === "folder" ? "skillmanager-picker-path" : "" });
      contentEl.createDiv({ cls: "skillmanager-picker-section", text: "Linked into" });
    }

    if (userScope) this.renderRow("globe", "Global", userScope.present, userScope.onAdd, userScope.onRemove);

    const targets = this.projects.filter((p) => p.id !== sourceProjectId);
    if (targets.length === 0 && !userScope) {
      contentEl.createEl("p", { text: "No workspaces registered yet. Add some in plugin settings." });
      return;
    }

    for (const project of targets) {
      this.renderRow(
        projectIcon(project.id),
        project.name,
        this.presentProjectIds.has(project.id),
        () => this.onAdd(project),
        () => this.onRemove(project)
      );
    }
  }

  private renderRow(icon: string, label: string, checked: boolean, onAdd: () => Promise<void>, onRemove: () => Promise<void>) {
    const row = this.contentEl.createDiv({ cls: "skillmanager-collection-picker-row" });
    const checkbox = row.createEl("input", { type: "checkbox" });
    checkbox.checked = checked;
    checkbox.addEventListener("change", () => {
      void (async () => {
        const wantAdd = checkbox.checked;
        try {
          if (wantAdd) await onAdd();
          else await onRemove();
        } catch (e) {
          checkbox.checked = !wantAdd;
          new Notice("Failed: " + errorMessage(e));
        }
      })();
    });
    const iconEl = row.createSpan({ cls: "skillmanager-collection-picker-icon" });
    setIcon(iconEl, icon);
    row.createSpan({ text: ` ${label}` });
  }

  onClose() {
    this.contentEl.empty();
  }
}
