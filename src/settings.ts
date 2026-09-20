import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type SkillSpacePlugin from "./main";
import { errorMessage } from "./errors";
import { EnabledFilter, SortOrder } from "./types";
import { SORT_OPTIONS } from "./views/LibraryView";

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

const RELATED_PLUGINS: { name: string; desc: string; url: string }[] = [
  {
    name: "Convert to Markdown",
    desc: "Converts PDFs, Word/PowerPoint/Excel files, web pages, and more into Markdown locally, with no cloud services or API keys. Useful for turning existing documentation into new skills, agents, or rules before adding them to a tool.",
    url: "https://community.obsidian.md/plugins/convert-to-markdown",
  },
  {
    name: "Terminus",
    desc: "A real terminal inside Obsidian with Claude Code support, including a pending-changes panel for reviewing and accepting file edits. Handy for running the CLI tools whose skills and agents AI Skills Manager is managing, without leaving the vault.",
    url: "https://community.obsidian.md/plugins/terminus",
  },
  {
    name: "Unhidden",
    desc: "Most tools keep their skills, agents, and commands in dot-folders like .claude or .codex, which Obsidian hides from the file explorer, search, and Bases by default. Unhidden reveals them so those folders show up alongside everything else in your vault.",
    url: "https://community.obsidian.md/plugins/unhidden",
  },
  {
    name: "Working Tabs",
    desc: "Groups open tabs by task and timeframe instead of folder structure. Helps keep the notes, terminals, and library views open while authoring or reviewing several skills at once from sprawling into a mess of unrelated tabs.",
    url: "https://community.obsidian.md/plugins/working-tabs",
  },
];

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
        "Off by default: the sidebar's \"Tools\" and \"Workspaces\" lists only show rows with at least one discovered item, so they don't fill up with rows that always read 0. Turn on to see every configured tool and registered project, whether or not anything's been found for it yet."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showEmptySidebarRows).onChange(async (value) => {
          this.plugin.settings.showEmptySidebarRows = value;
          await this.plugin.saveSettings();
          this.plugin.refreshOpenViews();
        })
      );

    new Setting(containerEl)
      .setName("Rescan tools")
      .setDesc(
        "Per-tool paths (which folders AI Skills Manager scans for skills, agents, commands, and rules), enabling/disabling a tool, and adding a custom one now live on the \"All tools\" page, at the top of the Tools section in the library sidebar."
      )
      .addButton((btn) =>
        btn
          .setIcon("refresh-cw")
          .setTooltip("Scan tools")
          .onClick(async () => {
            btn.setDisabled(true);
            try {
              const { items } = await this.plugin.rescanEverywhere();
              new Notice(`Scan complete: ${items.length} item${items.length === 1 ? "" : "s"} found.`);
            } catch (e) {
              new Notice("Scan failed: " + errorMessage(e));
            } finally {
              btn.setDisabled(false);
            }
          })
      );

    new Setting(containerEl).setName("Workspaces").setHeading();
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

    new Setting(containerEl).setName("Support").setHeading();
    new Setting(containerEl)
      .setName("Report a bug or request a feature")
      .setDesc("Opens a new issue on the AI Skills Manager GitHub repo.")
      .addButton((btn) =>
        btn.setButtonText("Open GitHub issues").onClick(() => {
          window.open("https://github.com/NoteNerdOfficial/ai-skills-manager/issues/new", "_blank");
        })
      );

    new Setting(containerEl).setName("Related plugins").setHeading();
    containerEl.createEl("p", {
      text: "Other community plugins that pair well with AI Skills Manager.",
      cls: "setting-item-description",
    });
    for (const plugin of RELATED_PLUGINS) {
      new Setting(containerEl)
        .setName(plugin.name)
        .setDesc(plugin.desc)
        .addButton((btn) =>
          btn.setButtonText("View plugin").onClick(() => {
            window.open(plugin.url, "_blank");
          })
        );
    }
  }
}
