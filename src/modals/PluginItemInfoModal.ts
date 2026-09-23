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
    private onInstallStandalone?: () => void
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
      contentEl.createEl("h3", { text: `"${this.plugin.name}" can't be toggled here` });
      contentEl.createEl("p", {
        cls: "skillmanager-modal-meta",
        text: `This plugin is managed by ${this.tool.name}. Use ${this.tool.name} to enable or disable it as a whole.`,
      });
    }
    if (this.item && this.onInstallStandalone) {
      contentEl.createEl("p", {
        cls: "skillmanager-modal-meta",
        text: `Want to manage "${this.item.name}" by itself instead? Install it separately via Discover, straight from the plugin's own repo. That copy lives outside the plugin and toggles individually like any other skill.`,
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
