import { App, Modal, Notice, Setting } from "obsidian";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "fs";
import { basename, join } from "path";
import { ItemType, ProjectWorkspace, SkillManagerPluginSettings, TYPE_LABELS } from "../types";
import { candidateTypesForTool, makeEntryId, parseSourceMeta, resolveToolDir } from "../scanners";
import { shallowCloneRepo } from "../git";
import { ShadowNoteStore } from "../store";
import { errorMessage } from "../errors";
import { RescanResult } from "../rescan";

const GLOBAL_SCOPE = "__global__";

export interface ParsedGitHubUrl {
  repoUrl: string;
  ref: string;
  subpath: string;
}

/** Accepts a bare repo URL or a GitHub "tree" URL (which encodes a branch/tag and a subpath) and
 *  splits out the three fields the install form needs. Returns null for anything that isn't a
 *  github.com URL with at least an owner/repo — the caller falls back to leaving the ref/subpath
 *  fields for the user to fill in by hand. */
export function parseGitHubUrl(input: string): ParsedGitHubUrl | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.hostname !== "github.com" && !url.hostname.endsWith(".github.com")) return null;

  const segments = url.pathname.split("/").filter(Boolean);
  const [owner, repoRaw, treeKeyword, ref, ...rest] = segments;
  if (!owner || !repoRaw) return null;

  const repoUrl = `https://github.com/${owner}/${repoRaw.replace(/\.git$/, "")}.git`;
  if (treeKeyword === "tree" && ref) {
    return { repoUrl, ref, subpath: rest.join("/") };
  }
  return { repoUrl, ref: "", subpath: "" };
}

export interface InstallFromGitHubPrefill {
  repoUrl: string;
  ref: string;
  subpath: string;
  type: ItemType;
}

export class InstallFromGitHubModal extends Modal {
  private repoUrlInput = "";
  private ref = "";
  private subpath = "";
  private refTouched = false;
  private subpathTouched = false;
  private toolId: string;
  private type: ItemType;
  private installScope: string = GLOBAL_SCOPE;
  private statusEl: HTMLElement | null = null;
  private installing = false;

  constructor(
    app: App,
    private settings: SkillManagerPluginSettings,
    private projects: ProjectWorkspace[],
    private store: ShadowNoteStore,
    private rescan: () => Promise<RescanResult>,
    /** Pre-fills the form from a Discover catalog entry — the URL fields start already touched,
     *  so typing in the repo URL field afterwards won't silently overwrite a deliberately-chosen
     *  ref/subpath the way it would for a freshly-opened, blank modal. */
    private prefill?: InstallFromGitHubPrefill,
    /** Called after a successful install — Discover uses this to drop the matching catalog
     *  entry, since it's now a real installed item rather than just a candidate. */
    private onInstalled?: () => void,
    /** Steers the default Tool selection away from this tool id — used when re-installing an
     *  already-installed item into a *different* tool ("Add to another tool…"), so the modal
     *  doesn't just default back to the tool it's already in. The Tool dropdown still lists
     *  every tool, so picking the same one again (e.g. under a different type) stays possible. */
    private excludeToolId?: string,
    /** Skips the "Install into" scope dropdown entirely, always installing at that tool's global
     *  scope — used by "Add to another tool…" so a cross-tool copy always lands somewhere it can
     *  later be linked into a project via the normal picker, rather than landing directly in one
     *  project as a dead-end duplicate. The normal Discover/manual-URL install keeps the picker
     *  (installing straight into one project is a legitimate first-time choice there). */
    private lockToGlobal?: boolean,
    /** Defaults the Tool dropdown to this tool id instead of the first tool that supports any
     *  type — used when opening the modal from a specific tool's own filtered library page
     *  ("Install into <tool>"), so the tool you were already looking at is what's pre-selected.
     *  Only affects the initial default; ignored once a Discover `prefill` is present, since that
     *  already has its own more specific tool-selection logic keyed off the discovered type. */
    private preferredToolId?: string
  ) {
    super(app);
    const preferredTool = preferredToolId
      ? settings.tools.find((t) => t.id === preferredToolId && candidateTypesForTool(t).length > 0)
      : undefined;
    const firstTool = preferredTool ?? settings.tools.find((t) => candidateTypesForTool(t).length > 0) ?? settings.tools[0];
    this.toolId = firstTool.id;
    this.type = candidateTypesForTool(firstTool)[0] ?? "skill";
    if (prefill) {
      this.repoUrlInput = prefill.repoUrl;
      this.ref = prefill.ref;
      this.subpath = prefill.subpath;
      this.refTouched = true;
      this.subpathTouched = true;
      // Prefer a tool that actually has a configured path for the discovered type, rather than
      // leaving whichever tool happened to default-select (it may not support this type at all).
      // Among those, prefer one that isn't excludeToolId, falling back to it if it's the only match.
      const toolForType =
        settings.tools.find((t) => candidateTypesForTool(t).includes(prefill.type) && t.id !== excludeToolId) ??
        settings.tools.find((t) => candidateTypesForTool(t).includes(prefill.type));
      if (toolForType) {
        this.toolId = toolForType.id;
        this.type = prefill.type;
      }
    }
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("skillmanager-modal");
    contentEl.createEl("h3", { text: "Install from GitHub" });

    new Setting(contentEl)
      .setName("Repository URL")
      .setDesc("A github.com repo URL, optionally with /tree/<branch>/<subpath> for a specific folder.")
      .addText((text) => {
        text.setPlaceholder("https://github.com/owner/repo");
        if (this.prefill) text.setValue(this.prefill.repoUrl);
        text.onChange((value) => {
          this.repoUrlInput = value;
          const parsed = parseGitHubUrl(value);
          if (!parsed) return;
          if (!this.refTouched) {
            refText?.setValue(parsed.ref);
            this.ref = parsed.ref;
          }
          if (!this.subpathTouched) {
            subpathText?.setValue(parsed.subpath);
            this.subpath = parsed.subpath;
          }
        });
      });

    let refText: { setValue: (v: string) => void } | undefined;
    new Setting(contentEl)
      .setName("Branch or tag")
      .setDesc("Leave blank to track the repo's default branch.")
      .addText((text) => {
        refText = text;
        if (this.prefill) text.setValue(this.prefill.ref);
        text.onChange((value) => {
          this.ref = value;
          this.refTouched = true;
        });
      });

    let subpathText: { setValue: (v: string) => void } | undefined;
    new Setting(contentEl)
      .setName("Subpath")
      .setDesc("Folder within the repo to install. Leave blank to install the repo root itself.")
      .addText((text) => {
        subpathText = text;
        if (this.prefill) text.setValue(this.prefill.subpath);
        text.onChange((value) => {
          this.subpath = value;
          this.subpathTouched = true;
        });
      });

    let typeDropdownEl: HTMLSelectElement | null = null;
    new Setting(contentEl).setName("Tool").addDropdown((dropdown) => {
      for (const tool of this.settings.tools) {
        if (candidateTypesForTool(tool).length === 0) continue;
        dropdown.addOption(tool.id, tool.name);
      }
      dropdown.setValue(this.toolId).onChange((value) => {
        this.toolId = value;
        const tool = this.settings.tools.find((t) => t.id === value);
        const types = tool ? candidateTypesForTool(tool) : [];
        this.type = types[0] ?? "skill";
        if (typeDropdownEl) {
          typeDropdownEl.empty();
          for (const type of types) {
            typeDropdownEl.createEl("option", { value: type, text: TYPE_LABELS[type] });
          }
          typeDropdownEl.value = this.type;
        }
      });
    });

    new Setting(contentEl).setName("Type").addDropdown((dropdown) => {
      typeDropdownEl = dropdown.selectEl;
      const tool = this.settings.tools.find((t) => t.id === this.toolId);
      for (const type of tool ? candidateTypesForTool(tool) : []) {
        dropdown.addOption(type, TYPE_LABELS[type]);
      }
      dropdown.setValue(this.type).onChange((value) => {
        this.type = value as ItemType;
      });
    });

    if (!this.lockToGlobal) {
      new Setting(contentEl).setName("Install into").addDropdown((dropdown) => {
        dropdown.addOption(GLOBAL_SCOPE, "Global");
        for (const project of this.projects) {
          dropdown.addOption(project.id, project.name);
        }
        dropdown.setValue(this.installScope).onChange((value) => {
          this.installScope = value;
        });
      });
    }

    this.statusEl = contentEl.createDiv({ cls: "skillmanager-modal-meta" });

    new Setting(contentEl)
      .addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((btn) =>
        btn
          .setButtonText("Install")
          .setCta()
          .onClick(() => void this.install())
      );
  }

  private setStatus(text: string) {
    this.statusEl?.setText(text);
  }

  private async install() {
    if (this.installing) return;
    if (!this.repoUrlInput.trim()) {
      new Notice("Enter a repository URL first.");
      return;
    }
    const tool = this.settings.tools.find((t) => t.id === this.toolId);
    if (!tool) {
      new Notice("Pick a tool to install into.");
      return;
    }
    const project = this.installScope === GLOBAL_SCOPE ? null : this.projects.find((p) => p.id === this.installScope) ?? null;
    const destDir = resolveToolDir(tool, this.type, project);
    if (!destDir) {
      new Notice(`${tool.name} has no configured ${this.type} location${project ? " for a project" : ""}.`);
      return;
    }

    const repoUrl = parseGitHubUrl(this.repoUrlInput)?.repoUrl ?? this.repoUrlInput.trim();
    const ref = this.ref.trim();
    const subpath = this.subpath.trim().replace(/^\/|\/$/g, "");

    this.installing = true;
    this.setStatus("Cloning repository…");
    let clone: ReturnType<typeof shallowCloneRepo> | null = null;
    try {
      clone = shallowCloneRepo(repoUrl, ref || undefined);
      rmSync(join(clone.dir, ".git"), { recursive: true, force: true });

      const sourceRoot = subpath ? join(clone.dir, subpath) : clone.dir;
      if (!existsSync(sourceRoot)) {
        throw new Error(`"${subpath}" doesn't exist in this repo${ref ? ` at ${ref}` : ""}.`);
      }
      const sourceStat = statSync(sourceRoot);
      const isDirectory = sourceStat.isDirectory();
      const unitName = subpath ? basename(subpath) : basename(repoUrl, ".git");
      const destPath = join(destDir, unitName);

      if (existsSync(destPath)) {
        throw new Error(`"${unitName}" already exists at ${destDir}.`);
      }

      mkdirSync(destDir, { recursive: true });
      if (isDirectory) {
        cpSync(sourceRoot, destPath, { recursive: true });
      } else {
        copyFileSync(sourceRoot, destPath);
      }

      const primaryFile = isDirectory ? join(destPath, "SKILL.md") : destPath;
      const meta = existsSync(primaryFile) ? parseSourceMeta(readFileSync(primaryFile, "utf-8").slice(0, 4000)) : { name: "", description: "" };
      const baseName = isDirectory ? unitName : unitName.replace(/\.(?:instructions|prompt)\.md$|\.md$/, "");
      const name = meta.name || baseName;
      // entryId must be derived from baseName (the file/folder name), matching scanEntries
      // (src/scanners.ts) exactly — the scanner never uses the frontmatter name for entryId,
      // only for the display `name` field. Using `name` here instead of `baseName` meant any
      // flat-file install (agent/command/rule) whose frontmatter name differed from its filename
      // — the common case, e.g. "backend.agent.md" declaring "Backend Developer" — computed a
      // different entryId than the one rescan() actually creates, so the sourceRepo/ref/subpath/
      // commit fields below silently updated a shadow note key that wasn't backing the real item.
      const entryId = makeEntryId(tool.id, this.type, project?.id ?? null, null, baseName);

      this.setStatus("Scanning…");
      await this.rescan();
      await this.store.update(entryId, {
        sourceRepo: repoUrl,
        sourceRef: ref,
        sourceSubpath: subpath,
        sourceCommit: clone.commit,
      });
      await this.rescan();

      new Notice(`Installed "${name}" into ${tool.name}.`);
      this.onInstalled?.();
      this.close();
    } catch (e) {
      new Notice(`Install failed: ${errorMessage(e)}`);
      this.setStatus("");
    } finally {
      clone?.cleanup();
      this.installing = false;
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
