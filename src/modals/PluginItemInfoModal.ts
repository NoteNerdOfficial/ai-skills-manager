import { App, Modal, Notice } from "obsidian";
import { errorMessage } from "../errors";
import { ItemMetadata, PluginSource, ToolConfig } from "../types";

/** Shown in place of actually toggling a plugin-bundled item's card (see LibraryView's
 *  explainPluginToggle) — the tool has no concept of disabling one skill inside a plugin, so this
 *  explains why, offers the real whole-plugin toggle right here, and — when the plugin's repo is
 *  known — a way to get an independently-toggleable copy instead of fighting the plugin boundary. */
export class PluginItemInfoModal extends Modal {
  constructor(
    app: App,
    private item: ItemMetadata | null,
    private plugin: PluginSource,
    private tool: ToolConfig,
    private onTogglePlugin?: () => void | Promise<void>,
    private onInstallStandalone?: () => void,
    private onDiscoverRepo?: () => void
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("skillmanager-modal");
    if (this.item) {
      contentEl.createEl("h3", { text: `"${this.item.name}" can't be toggled on its own` });
      contentEl.createEl("p", {
        cls: "skillmanager-modal-meta",
        text: this.onTogglePlugin
          ? `It's bundled in the "${this.plugin.name}" plugin. ${this.tool.name} only supports enabling or disabling a plugin as a whole — there's no way to turn off just one skill inside it.`
          : `It's bundled in the "${this.plugin.name}" plugin managed by ${this.tool.name}. AI Skills Manager can show its contents, but cannot enable or disable this plugin here.`,
      });
    } else {
      contentEl.createEl("h3", { text: `Options for "${this.plugin.name}"` });
      contentEl.createEl("p", {
        cls: "skillmanager-modal-meta",
        text: this.onTogglePlugin
          ? `This is a packaged plugin managed by ${this.tool.name}. You can enable or disable the whole plugin here, but its bundled items move together — they can't be toggled individually.`
          : `This plugin is managed by ${this.tool.name}. AI Skills Manager can show its contents, but cannot enable or disable the package here.`,
      });
    }
    if (this.item && this.onInstallStandalone) {
      contentEl.createEl("p", {
        cls: "skillmanager-modal-meta",
        text: `Want to manage "${this.item.name}" by itself instead? Install a standalone copy from the plugin's own GitHub repo. That copy lives outside the plugin, toggles individually, and can be updated through AI Skills Manager.`,
      });
    }
    if (!this.item && this.onDiscoverRepo) {
      contentEl.createEl("p", {
        cls: "skillmanager-modal-meta",
        text: "For individual control, add the plugin's known GitHub repository to Discover and install only the items you want. Copies installed through AI Skills Manager can be managed and updated independently.",
      });
    }

    const actions = contentEl.createDiv({ cls: "skillmanager-modal-actions" });
    actions.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
    if (this.item && this.onInstallStandalone) {
      const installBtn = actions.createEl("button", { text: "Install standalone copy…" });
      installBtn.addEventListener("click", () => {
        this.close();
        this.onInstallStandalone?.();
      });
    }
    if (!this.item && this.onDiscoverRepo) {
      const discoverBtn = actions.createEl("button", { text: "Add repo to Discover…" });
      discoverBtn.addEventListener("click", () => {
        this.close();
        this.onDiscoverRepo?.();
      });
    }
    if (this.onTogglePlugin) {
      const pluginToggleBtn = actions.createEl("button", {
        text: this.plugin.enabled ? `Disable "${this.plugin.name}"` : `Enable "${this.plugin.name}"`,
        cls: "mod-warning",
      });
      pluginToggleBtn.addEventListener("click", () => {
        void (async () => {
          try {
            await this.onTogglePlugin?.();
          } catch (e) {
            new Notice(`Couldn't toggle "${this.plugin.name}": ` + errorMessage(e));
            return;
          }
          this.close();
        })();
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
