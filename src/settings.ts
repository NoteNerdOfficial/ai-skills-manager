import { existsSync } from "fs";
import { join } from "path";
import { App, FileSystemAdapter, Notice, PluginSettingTab, Setting } from "obsidian";
import type SkillSpacePlugin from "./main";
import { errorMessage } from "./errors";
import { expandHome, toProjectRelative } from "./scanners";
import { EnabledFilter, ItemType, SortOrder } from "./types";
import { SORT_OPTIONS } from "./views/LibraryView";

const TYPE_LABELS: Record<ItemType, string> = {
  skill: "Skills",
  agent: "Agents",
  command: "Commands",
  rule: "Rules",
};

const ENABLED_FILTER_OPTIONS: { key: EnabledFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "enabled", label: "Enabled only" },
  { key: "disabled", label: "Disabled only" },
];

const AUTO_RESCAN_OPTIONS: { minutes: number; label: string }[] = [
  { minutes: 0, label: "Off" },
  { minutes: 5, label: "Every 5 minutes" },
  { minutes: 15, label: "Every 15 minutes" },
  { minutes: 30, label: "Every 30 minutes" },
  { minutes: 60, label: "Every hour" },
];

/** Appends a small "found"/"not found" indicator to a path field's control row, confirming
 *  whether what's actually typed resolves to a real directory — the thing a raw text field with
 *  no feedback can't tell you (a typo saves silently and looks identical to a correct path).
 *  `resolve` turns the field's raw value into the absolute path to check, or null to skip
 *  checking (e.g. no vault base path available for a project-scoped field). Returns an updater
 *  to call on every change; also called once up front for the field's initial value. */
function attachPathStatus(controlEl: HTMLElement, resolve: (rawPath: string) => string | null) {
  const el = controlEl.createSpan({ cls: "skillspace-path-status" });
  return (rawPath: string) => {
    const trimmed = rawPath.trim();
    if (!trimmed) {
      el.setText("");
      el.title = "";
      el.className = "skillspace-path-status";
      return;
    }
    const resolved = resolve(trimmed);
    const found = resolved !== null && existsSync(resolved);
    el.setText(found ? "found" : "not found");
    el.title = resolved ?? "";
    el.className = `skillspace-path-status ${found ? "is-found" : "is-missing"}`;
  };
}

export class SkillSpaceSettingTab extends PluginSettingTab {
  plugin: SkillSpacePlugin;

  constructor(app: App, plugin: SkillSpacePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Storage folder")
      .setDesc(
        "Vault folder where AI Skills Manager keeps its metadata notes (tags, enabled, favorite, collections) for each discovered item."
      )
      .addText((text) =>
        text
          .setPlaceholder("AI Skills Manager")
          .setValue(this.plugin.settings.storageFolder)
          .onChange(async (value) => {
            this.plugin.settings.storageFolder = value.trim() || "AI Skills Manager";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("Library view").setHeading();

    new Setting(containerEl)
      .setName("Auto-rescan")
      .setDesc(
        "Periodically re-scan every configured tool and project in the background, independent of opening the library or clicking Scan tools."
      )
      .addDropdown((dropdown) => {
        for (const { minutes, label } of AUTO_RESCAN_OPTIONS) dropdown.addOption(String(minutes), label);
        dropdown.setValue(String(this.plugin.settings.autoRescanMinutes)).onChange(async (value) => {
          this.plugin.settings.autoRescanMinutes = Number(value);
          await this.plugin.saveSettings();
          this.plugin.applyAutoRescanInterval();
        });
      });

    new Setting(containerEl)
      .setName("Default sort order")
      .setDesc("Sort order the library view opens with.")
      .addDropdown((dropdown) => {
        for (const { key, label } of SORT_OPTIONS) dropdown.addOption(key, label);
        dropdown.setValue(this.plugin.settings.defaultSortOrder).onChange(async (value) => {
          this.plugin.settings.defaultSortOrder = value as SortOrder;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Default enabled/disabled filter")
      .setDesc("Enabled/disabled filter the library view opens with.")
      .addDropdown((dropdown) => {
        for (const { key, label } of ENABLED_FILTER_OPTIONS) dropdown.addOption(key, label);
        dropdown.setValue(this.plugin.settings.defaultEnabledFilter).onChange(async (value) => {
          this.plugin.settings.defaultEnabledFilter = value as EnabledFilter;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Show every tool and project in the sidebar")
      .setDesc(
        "Off by default: the sidebar's \"Global workspace\" and \"Project workspaces\" lists only show rows with at least one discovered item, so they don't fill up with rows that always read 0. Turn on to see every configured tool and registered project, whether or not anything's been found for it yet."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showEmptySidebarRows).onChange(async (value) => {
          this.plugin.settings.showEmptySidebarRows = value;
          await this.plugin.saveSettings();
          this.plugin.refreshOpenViews();
        })
      );

    new Setting(containerEl)
      .setName("Tools")
      .setHeading()
      .addButton((btn) =>
        btn
          .setIcon("refresh-cw")
          .setTooltip("Scan tools")
          .onClick(async () => {
            btn.setDisabled(true);
            try {
              const { items } = await this.plugin.rescanEverywhere();
              new Notice(`Scan complete — ${items.length} item${items.length === 1 ? "" : "s"} found.`);
            } catch (e) {
              new Notice("Scan failed: " + errorMessage(e));
            } finally {
              btn.setDisabled(false);
            }
          })
      );
    containerEl.createEl("p", {
      text: "Filesystem paths AI Skills Manager scans for skills, agents, commands, and rules. Leave a field blank to skip it for that tool. A greyed-out path shown as placeholder text is an educated guess for a convention that isn't confirmed — type it in only once you've verified it actually exists. \"found\"/\"not found\" next to a field confirms whether what's typed resolves to a real directory on disk right now (project-scoped fields are checked against the current vault).",
      cls: "setting-item-description",
    });

    const vaultAdapter = this.app.vault.adapter;
    const vaultPath = vaultAdapter instanceof FileSystemAdapter ? vaultAdapter.getBasePath() : null;

    for (const tool of this.plugin.settings.tools) {
      const details = containerEl.createEl("details", { cls: "skillspace-tool-details" });
      details.createEl("summary", { text: tool.name, cls: "skillspace-tool-summary" });

      for (const type of Object.keys(TYPE_LABELS) as ItemType[]) {
        const setting = new Setting(details).setName(TYPE_LABELS[type]);
        const updateStatus = attachPathStatus(setting.controlEl, (p) => expandHome(p));
        setting.addText((text) =>
          text
            .setPlaceholder(tool.unconfirmedPaths?.[type] ?? "~/.example/path")
            .setValue(tool.paths[type] ?? "")
            .onChange(async (value) => {
              if (value.trim()) {
                tool.paths[type] = value.trim();
              } else {
                delete tool.paths[type];
              }
              await this.plugin.saveSettings();
              updateStatus(value);
            })
        );
        updateStatus(tool.paths[type] ?? "");
      }

      new Setting(details)
        .setName("Project-scoped paths")
        .setDesc(
          "Optional override for this tool's layout inside a project folder, relative to the project root. Leave blank to use the default shown as a placeholder (the global path above, with the home directory stripped)."
        );
      for (const type of Object.keys(TYPE_LABELS) as ItemType[]) {
        const globalPath = tool.paths[type];
        const setting = new Setting(details).setName(TYPE_LABELS[type]);
        const updateStatus = attachPathStatus(setting.controlEl, (p) =>
          vaultPath ? join(vaultPath, p) : null
        );
        setting.addText((text) =>
          text
            .setPlaceholder(globalPath ? toProjectRelative(globalPath) : "(not scanned globally)")
            .setValue(tool.projectPaths?.[type] ?? "")
            .onChange(async (value) => {
              if (value.trim()) {
                tool.projectPaths = tool.projectPaths ?? {};
                tool.projectPaths[type] = value.trim();
              } else if (tool.projectPaths) {
                delete tool.projectPaths[type];
                if (Object.keys(tool.projectPaths).length === 0) delete tool.projectPaths;
              }
              await this.plugin.saveSettings();
              updateStatus(value);
            })
        );
        updateStatus(tool.projectPaths?.[type] ?? "");
      }
    }

    new Setting(containerEl).setName("Project workspaces").setHeading();
    containerEl.createEl("p", {
      text: "Extra project folders to scan for project-local skills (e.g. <project>/.claude/skills), in addition to the current vault, which is always included automatically.",
      cls: "setting-item-description",
    });

    for (const project of this.plugin.settings.projectWorkspaces) {
      new Setting(containerEl)
        .setName(project.name)
        .setDesc(project.path)
        .addButton((btn) =>
          btn
            .setIcon("trash")
            .setTooltip("Remove")
            .onClick(async () => {
              this.plugin.settings.projectWorkspaces = this.plugin.settings.projectWorkspaces.filter(
                (p) => p.id !== project.id
              );
              await this.plugin.saveSettings();
              // Removing a project changes what performRescan actually scans (getAllProjects
              // reads projectWorkspaces directly) — a display-only refresh would leave its stale
              // items/sidebar row sitting there until the next manual rescan.
              await this.plugin.rescanEverywhere();
              this.display();
            })
        );
    }

    let newProjectName = "";
    let newProjectPath = "";
    new Setting(containerEl)
      .setName("Add project")
      .addText((text) =>
        text.setPlaceholder("Name").onChange((value) => {
          newProjectName = value;
        })
      )
      .addText((text) =>
        text.setPlaceholder("~/path/to/project").onChange((value) => {
          newProjectPath = value;
        })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Add")
          .setCta()
          .onClick(async () => {
            if (!newProjectName.trim() || !newProjectPath.trim()) return;
            this.plugin.settings.projectWorkspaces.push({
              id: `proj-${Date.now()}`,
              name: newProjectName.trim(),
              path: newProjectPath.trim(),
            });
            await this.plugin.saveSettings();
            await this.plugin.rescanEverywhere();
            this.display();
          })
      );
  }
}
