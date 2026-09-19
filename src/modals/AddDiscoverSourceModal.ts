import { App, Modal, Notice, Setting } from "obsidian";
import { SkillSpacePluginSettings } from "../types";
import { dedupeDiscoverCatalog, discoverGitSkills, discoverSourceId, fetchGithubStars } from "../discover";
import { errorMessage } from "../errors";
import { parseGitHubUrl } from "./InstallFromGitHubModal";

/** Clones a repo, finds every skill/agent/command/rule under the given subpath (or the whole
 *  repo), and adds them to the Discover catalog — a browsable candidate list, not an install.
 *  Deliberately no Tool/Type/Install-into pickers here (see InstallFromGitHubModal for those); a
 *  catalog entry doesn't need a destination until its own "+" button is used. */
export class AddDiscoverSourceModal extends Modal {
  private repoUrlInput = "";
  private ref = "";
  private subpath = "";
  private refTouched = false;
  private subpathTouched = false;
  private statusEl: HTMLElement | null = null;
  private submitting = false;

  constructor(
    app: App,
    private settings: SkillSpacePluginSettings,
    private saveSettings: () => Promise<void>,
    /** True if this repoUrl/subpath is already installed as a real item — filters it out of the
     *  catalog rather than showing an "install" card for something already in the library. */
    private isInstalled: (repoUrl: string, subpath: string) => boolean,
    private onAdded: () => void
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("skillspace-modal");
    contentEl.createEl("h3", { text: "Add a GitHub source to Discover" });
    contentEl.createDiv({
      cls: "skillspace-modal-meta",
      text: "Finds every skill, agent, command, and rule in the repo (or just the given folder) and adds them to Discover to browse and install later — nothing is installed yet.",
    });

    let refText: { setValue: (v: string) => void } | undefined;
    let subpathText: { setValue: (v: string) => void } | undefined;

    new Setting(contentEl)
      .setName("Repository URL")
      .setDesc("A github.com repo URL, optionally with /tree/<branch>/<subpath> for a specific folder.")
      .addText((text) => {
        text.setPlaceholder("https://github.com/owner/repo").onChange((value) => {
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

    new Setting(contentEl)
      .setName("Branch or tag")
      .setDesc("Leave blank to track the repo's default branch.")
      .addText((text) => {
        refText = text;
        text.onChange((value) => {
          this.ref = value;
          this.refTouched = true;
        });
      });

    new Setting(contentEl)
      .setName("Subpath")
      .setDesc("Folder within the repo to search. Leave blank to search the whole repo.")
      .addText((text) => {
        subpathText = text;
        text.onChange((value) => {
          this.subpath = value;
          this.subpathTouched = true;
        });
      });

    this.statusEl = contentEl.createDiv({ cls: "skillspace-modal-meta" });

    new Setting(contentEl)
      .addButton((btn) => btn.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((btn) =>
        btn
          .setButtonText("Search repo")
          .setCta()
          .onClick(() => void this.submit())
      );
  }

  private setStatus(text: string) {
    this.statusEl?.setText(text);
  }

  private async submit() {
    if (this.submitting) return;
    if (!this.repoUrlInput.trim()) {
      new Notice("Enter a repository URL first.");
      return;
    }

    const repoUrl = parseGitHubUrl(this.repoUrlInput)?.repoUrl ?? this.repoUrlInput.trim();
    const ref = this.ref.trim();
    const subpath = this.subpath.trim().replace(/^\/|\/$/g, "");

    this.submitting = true;
    this.setStatus("Cloning repository…");
    try {
      const allFound = await discoverGitSkills(repoUrl, ref, subpath);
      const found = allFound.filter((entry) => !this.isInstalled(entry.repoUrl, entry.subpath));

      this.setStatus("Fetching repo info…");
      const starCount = await fetchGithubStars(repoUrl);
      const starsFetchedAt = starCount !== null ? Date.now() : null;
      for (const entry of found) {
        entry.starCount = starCount;
        entry.starsFetchedAt = starsFetchedAt;
      }

      // Re-adding the same repo/subpath updates existing entries in place (by id) instead of
      // duplicating them; genuinely new skills found this time are appended.
      const byId = new Map(this.settings.discoverCatalog.map((e) => [e.id, e]));
      for (const entry of found) byId.set(entry.id, entry);
      this.settings.discoverCatalog = dedupeDiscoverCatalog(Array.from(byId.values()));

      // Tracked separately from the catalog entries themselves so "Refresh all" still knows
      // this repo exists even after every item it found gets installed or removed.
      const sourceId = discoverSourceId(repoUrl, ref, subpath);
      if (!this.settings.discoverSources.some((s) => s.id === sourceId)) {
        this.settings.discoverSources.push({ id: sourceId, repoUrl, ref, subpath, addedAt: Date.now() });
      }

      await this.saveSettings();

      const skipped = allFound.length - found.length;
      new Notice(
        `Found ${found.length} item${found.length === 1 ? "" : "s"} in this repo.` +
          (skipped > 0 ? ` (${skipped} already installed, not shown.)` : "")
      );
      this.onAdded();
      this.close();
    } catch (e) {
      new Notice(`Couldn't add source: ${errorMessage(e)}`);
      this.setStatus("");
    } finally {
      this.submitting = false;
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}
