import { App, Modal, Notice, Setting, TextAreaComponent } from "obsidian";
import { existsSync } from "fs";
import { ItemType, SkillManagerPluginSettings, TYPE_LABELS } from "../types";
import { expandHome } from "../scanners";
import { slug } from "../format";
import { RescanResult } from "../rescan";

/** Same idea as the removed Settings-tab attachPathStatus, kept local to this modal now that
 *  tool configuration lives on the "All tools" page instead. */
function attachPathStatus(controlEl: HTMLElement) {
  const el = controlEl.createSpan({ cls: "skillmanager-path-status" });
  return (rawPath: string) => {
    const trimmed = rawPath.trim();
    if (!trimmed) {
      el.setText("");
      el.title = "";
      el.className = "skillmanager-path-status";
      return;
    }
    const resolved = expandHome(trimmed);
    const found = existsSync(resolved);
    el.setText(found ? "found" : "not found");
    el.title = resolved;
    el.className = `skillmanager-path-status ${found ? "is-found" : "is-missing"}`;
  };
}

export class AddToolModal extends Modal {
  private name = "";
  private paths: Partial<Record<ItemType, string>> = {};
  private mcpConfigPath = "";
  private projectMcpConfigPath = "";
  private mcpConfigKey = "";
  /** Raw inline SVG markup — same field/rendering contract as ToolConfig.svgIcon (parsed with
   *  DOMParser and appended directly, see LibraryView.renderIcon), not a PNG/JPG data URI or
   *  image URL. Empty means fall back to the generic default icon. */
  private svgIcon = "";

  constructor(
    app: App,
    private settings: SkillManagerPluginSettings,
    private saveSettings: () => Promise<void>,
    private rescan: () => Promise<RescanResult>
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("skillmanager-modal");
    contentEl.createEl("h3", { text: "Add tool" });

    new Setting(contentEl).setName("Name").addText((text) =>
      text.setPlaceholder("My Tool").onChange((value) => {
        this.name = value;
      })
    );

    this.renderLogoField(contentEl);

    for (const type of Object.keys(TYPE_LABELS) as ItemType[]) {
      const setting = new Setting(contentEl).setName(TYPE_LABELS[type]);
      const updateStatus = attachPathStatus(setting.controlEl);
      setting.addText((text) =>
        text.setPlaceholder("~/.example/path").onChange((value) => {
          if (value.trim()) {
            this.paths[type] = value.trim();
          } else {
            delete this.paths[type];
          }
          updateStatus(value);
        })
      );
    }

    contentEl.createEl("h4", { text: "MCP servers (optional)" });
    contentEl.createDiv({
      cls: "setting-item-description",
      text: "Point at this tool's MCP server config file(s), if it has any, so they show up on the MCP servers page.",
    });
    new Setting(contentEl).setName("Global config").addText((text) =>
      text.setPlaceholder("~/.example/mcp.json").onChange((value) => {
        this.mcpConfigPath = value.trim();
      })
    );
    new Setting(contentEl).setName("Project config").addText((text) =>
      text.setPlaceholder(".example/mcp.json").onChange((value) => {
        this.projectMcpConfigPath = value.trim();
      })
    );
    new Setting(contentEl).setName("Server list key (advanced)").addText((text) =>
      text.setPlaceholder("mcpServers").onChange((value) => {
        this.mcpConfigKey = value.trim();
      })
    );

    new Setting(contentEl)
      .addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((btn) =>
        btn
          .setButtonText("Add tool")
          .setCta()
          .onClick(() => void this.save())
      );
  }

  /** Logo: a textarea for pasting raw SVG markup directly, plus a file picker that reads a
   *  chosen .svg file into that same textarea (FileReader, text — never a PNG/JPG, since
   *  renderIcon only knows how to parse-and-append SVG markup, not raster images/data URIs). A
   *  live preview next to the field re-parses on every change so a malformed paste is obvious
   *  immediately rather than only failing silently later when the card tries to render it. */
  private renderLogoField(contentEl: HTMLElement) {
    const setting = new Setting(contentEl)
      .setName("Logo (optional)")
      .setDesc("Paste SVG markup, or choose a .svg file. Falls back to a generic icon if left blank.");

    const preview = setting.controlEl.createSpan({ cls: "skillmanager-tool-logo-preview" });
    const updatePreview = () => {
      preview.empty();
      if (!this.svgIcon.trim()) return;
      try {
        const parsed = new DOMParser().parseFromString(this.svgIcon, "image/svg+xml");
        if (parsed.querySelector("parsererror")) return;
        const svgEl = parsed.documentElement;
        if (svgEl.tagName.toLowerCase() !== "svg") return;
        preview.appendChild(svgEl);
      } catch {
        // Leave the preview empty — the textarea below still shows exactly what was typed/pasted,
        // so there's nothing extra to surface here beyond "it didn't parse."
      }
    };

    const fileInput = setting.controlEl.createEl("input", {
      type: "file",
      cls: "skillmanager-file-input-hidden",
      attr: { accept: ".svg,image/svg+xml" },
    });
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        // readAsText always yields a string result (or null on failure) — never the
        // ArrayBuffer branch of FileReader.result's type, which only readAsArrayBuffer produces.
        if (typeof reader.result !== "string") return;
        this.svgIcon = reader.result;
        textArea.setValue(this.svgIcon);
        updatePreview();
      };
      reader.readAsText(file);
    });
    setting.addButton((btn) => btn.setButtonText("Choose file…").onClick(() => fileInput.click()));

    let textArea!: TextAreaComponent;
    new Setting(contentEl).setClass("skillmanager-tool-logo-textarea").addTextArea((ta) => {
      textArea = ta;
      ta.setPlaceholder('<svg xmlns="http://www.w3.org/2000/svg" ...>...</svg>').onChange((value) => {
        this.svgIcon = value;
        updatePreview();
      });
    });
  }

  private async save() {
    const trimmedName = this.name.trim();
    if (!trimmedName) {
      new Notice("Give the tool a name first.");
      return;
    }
    const id = `${slug(trimmedName)}-${Date.now()}`;
    const svgIcon = this.svgIcon.trim() || undefined;
    this.settings.tools.push({
      id,
      name: trimmedName,
      icon: "terminal",
      svgIcon,
      paths: this.paths,
      custom: true,
      mcpConfigPath: this.mcpConfigPath || undefined,
      projectMcpConfigPath: this.projectMcpConfigPath || undefined,
      mcpConfigKey: this.mcpConfigKey || undefined,
    });
    await this.saveSettings();
    await this.rescan();
    new Notice(`Added "${trimmedName}".`);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}
