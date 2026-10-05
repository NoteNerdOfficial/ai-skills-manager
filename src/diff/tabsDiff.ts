import { Menu, setIcon } from "obsidian";
import { existsSync, readFileSync } from "fs";
import { basename } from "path";
import { diffLines } from "diff";
import { buildDiffLines, DiffLine } from "./buildDiffLines";
import { TabsDiffFile } from "./companions";
import { renderFoldedDiff } from "./renderDiff";

interface PreparedFile {
  binary: boolean;
  oldText: string;
  newText: string;
  stats: { added: number; removed: number } | null;
  lines?: DiffLine[];
}

/** Which file is open, where change navigation lands when it crosses into another file, and
 *  each file's read + diffed contents, so switching tabs never rereads or rediffs anything. Make
 *  a fresh one (newTabsDiffState) whenever the files being compared change. */
export interface TabsDiffState {
  fileIndex: number;
  landOn: "first" | "last" | null;
  prepared: Map<string, PreparedFile>;
}

export function newTabsDiffState(): TabsDiffState {
  return { fileIndex: 0, landOn: null, prepared: new Map() };
}

export interface TabsDiffOptions {
  files: TabsDiffFile[];
  state: TabsDiffState;
  rerender: () => void;
  back: { label: string; icon?: string; onClick: () => void };
  primary: { label: string; onClick: () => void };
}

function prepare(state: TabsDiffState, f: TabsDiffFile): PreparedFile {
  const cached = state.prepared.get(f.file);
  if (cached) return cached;
  const read = (path: string) => (existsSync(path) ? readFileSync(path) : Buffer.alloc(0));
  const oldBuf = read(f.oldPath);
  const newBuf = read(f.newPath);
  const binary = oldBuf.includes(0) || newBuf.includes(0);
  const oldText = binary ? "" : oldBuf.toString("utf-8");
  const newText = binary ? "" : newBuf.toString("utf-8");
  let stats: PreparedFile["stats"] = null;
  if (!binary) {
    stats = { added: 0, removed: 0 };
    for (const part of diffLines(oldText, newText)) {
      if (part.added) stats.added += part.count ?? 0;
      else if (part.removed) stats.removed += part.count ?? 0;
    }
  }
  const prepared: PreparedFile = { binary, oldText, newText, stats };
  state.prepared.set(f.file, prepared);
  return prepared;
}

/**
 * One changed file at a time: file tabs pinned along the top, the diff, and a dock pinned along
 * the bottom with a back action, a change stepper and the primary action, so neither navigation
 * nor the action ever scrolls away. Shared by the history version view and the GitHub
 * update/restore review.
 *
 * Long unchanged stretches fold (see renderFoldedDiff). Stepping past a file's last change
 * carries on into the next file, so J/K alone walks every change; [ and ] switch files.
 */
export function renderTabsDiff(panel: HTMLElement, opts: TabsDiffOptions): void {
  const { files, state } = opts;
  const index = Math.min(state.fileIndex, files.length - 1);
  const current = files[index];
  const prepared = prepare(state, current);
  const goToFile = (next: number, landOn: "first" | "last" | null = null) => {
    if (next < 0 || next >= files.length || next === index) return;
    state.fileIndex = next;
    state.landOn = landOn;
    opts.rerender();
  };
  const renderStats = (parent: HTMLElement, p: PreparedFile) => {
    const el = parent.createSpan({ cls: "skillmanager-vtab-stats" });
    if (!p.stats) el.setText("binary");
    else {
      if (p.stats.added) el.createSpan({ cls: "skillmanager-diff-stat-add", text: `+${p.stats.added}` });
      if (p.stats.removed) el.createSpan({ cls: "skillmanager-diff-stat-remove", text: `−${p.stats.removed}` });
    }
  };

  // ---- file tabs ----
  const strip = panel.createDiv({ cls: "skillmanager-vtabs" });
  const scroller = strip.createDiv({ cls: "skillmanager-vtabs-scroll", attr: { role: "tablist", "aria-label": "Changed files" } });
  files.forEach((f, i) => {
    const tab = scroller.createEl("button", {
      cls: `skillmanager-vtab${i === index ? " is-active" : ""}`,
      attr: { role: "tab", "aria-selected": String(i === index), title: `${f.file} (${f.status})` },
    });
    tab.createSpan({ cls: `skillmanager-vtab-dot is-${f.status}` });
    tab.createSpan({ cls: "skillmanager-vtab-name", text: basename(f.file) });
    renderStats(tab, prepare(state, f));
    tab.addEventListener("click", () => goToFile(i));
  });
  // A plain mouse wheel only scrolls vertically; turn it sideways so the strip scrolls without
  // a trackpad or Shift.
  scroller.addEventListener(
    "wheel",
    (evt) => {
      if (Math.abs(evt.deltaY) <= Math.abs(evt.deltaX) || scroller.scrollWidth <= scroller.clientWidth) return;
      scroller.scrollLeft += evt.deltaY;
      evt.preventDefault();
    },
    { passive: false }
  );
  // Fade whichever edge still has tabs hidden past it.
  const syncFades = () => {
    strip.toggleClass("has-more-left", scroller.scrollLeft > 1);
    strip.toggleClass("has-more-right", scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1);
  };
  scroller.addEventListener("scroll", syncFades);
  window.requestAnimationFrame(() => {
    scroller.querySelector(".is-active")?.scrollIntoView({ inline: "nearest", block: "nearest" });
    syncFades();
  });

  if (files.length > 1) {
    const allBtn = strip.createEl("button", { cls: "skillmanager-vtabs-all", attr: { "aria-label": `All ${files.length} changed files` } });
    setIcon(allBtn.createSpan({ cls: "skillmanager-vdiff-btn-icon" }), "list");
    allBtn.createSpan({ text: `${files.length} files` });
    allBtn.addEventListener("click", (evt) => {
      const menu = new Menu();
      files.forEach((f, i) => {
        const stats = prepare(state, f).stats;
        const detail = f.status !== "modified" ? f.status : stats ? `+${stats.added} −${stats.removed}` : "binary";
        menu.addItem((item) => item.setTitle(`${f.file}  ${detail}`).setChecked(i === index).onClick(() => goToFile(i)));
      });
      menu.showAtMouseEvent(evt);
    });
  }

  const path = panel.createDiv({ cls: "skillmanager-vdiff-path" });
  path.createSpan({ cls: `skillmanager-diff-companion-badge is-${current.status}`, text: current.status });
  path.createSpan({ cls: "skillmanager-vdiff-path-name", text: current.file });

  // ---- diff ----
  const body = panel.createDiv({ cls: "skillmanager-vdiff-file" });
  let hunks: HTMLElement[] = [];
  if (prepared.binary) {
    body.createDiv({ cls: "skillmanager-tree-hint", text: "Binary file, no preview." });
  } else {
    prepared.lines ??= buildDiffLines(prepared.oldText, prepared.newText);
    hunks = renderFoldedDiff(body.createDiv(), prepared.lines);
  }

  // ---- dock ----
  const dock = panel.createDiv({ cls: "skillmanager-vdock", attr: { tabindex: "-1" } });
  const backBtn = dock.createEl("button", { cls: "skillmanager-btn-neutral skillmanager-vdiff-back" });
  if (opts.back.icon) setIcon(backBtn.createSpan({ cls: "skillmanager-vdiff-btn-icon" }), opts.back.icon);
  backBtn.createSpan({ text: opts.back.label });
  backBtn.addEventListener("click", opts.back.onClick);

  const stepper = dock.createDiv({ cls: "skillmanager-vdock-stepper" });
  const stepBtn = (icon: string, label: string, onClick: () => void) => {
    const btn = stepper.createEl("button", { cls: "skillmanager-icon-btn skillmanager-vdiff-step", attr: { "aria-label": label } });
    setIcon(btn, icon);
    btn.addEventListener("click", onClick);
    return btn;
  };
  let at = -1;
  const prevBtn = stepBtn("chevron-up", "Previous change (K)", () => move(-1));
  const counter = stepper.createSpan({ cls: "skillmanager-vdiff-counter", attr: { "aria-live": "polite" } });
  const nextBtn = stepBtn("chevron-down", "Next change (J)", () => move(1));
  dock.createEl("button", { cls: "mod-cta", text: opts.primary.label }).addEventListener("click", opts.primary.onClick);

  const sync = () => {
    if (hunks.length === 0) counter.setText(prepared.binary ? "Binary file" : "No line changes");
    else counter.setText(at < 0 ? `${hunks.length} change${hunks.length === 1 ? "" : "s"}` : `${at + 1} / ${hunks.length}`);
    prevBtn.disabled = index === 0 && at <= 0;
    nextBtn.disabled = index === files.length - 1 && at >= hunks.length - 1;
  };
  const focusHunk = (i: number, smooth = true) => {
    for (const row of Array.from(body.querySelectorAll(".is-focused-change"))) row.removeClass("is-focused-change");
    at = i;
    for (let row: Element | null = hunks[i]; row && row.hasClass("skillmanager-diff-line") && !row.hasClass("skillmanager-diff-line-context"); row = row.nextElementSibling) {
      row.addClass("is-focused-change");
    }
    hunks[i].scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
    sync();
  };
  const move = (dir: 1 | -1) => {
    const next = at + dir;
    if (next >= 0 && next < hunks.length) focusHunk(next);
    else if (dir === 1 && next >= hunks.length) goToFile(index + 1, "first");
    else if (dir === -1 && next < 0) goToFile(index - 1, "last");
  };
  sync();

  panel.addEventListener("keydown", (evt) => {
    if (evt.metaKey || evt.ctrlKey || evt.altKey) return;
    const target = evt.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    const key = evt.key.toLowerCase();
    if (key === "j") move(1);
    else if (key === "k") move(-1);
    else if (key === "]") goToFile(index + 1);
    else if (key === "[") goToFile(index - 1);
    else return;
    evt.preventDefault();
  });

  if (state.landOn && hunks.length > 0) {
    const target = state.landOn === "first" ? 0 : hunks.length - 1;
    state.landOn = null;
    window.requestAnimationFrame(() => focusHunk(target, false));
  }
  // Keys work straight away, without first clicking into the panel.
  window.requestAnimationFrame(() => dock.focus({ preventScroll: true }));
}
