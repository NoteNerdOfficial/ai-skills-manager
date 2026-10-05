import { buildDiffLines, DiffLine } from "./buildDiffLines";

export interface DiffStats {
  added: number;
  removed: number;
}

/** Line-granular +/- counts (the conventional "N lines changed" stat) — derived from the same
 *  line structure the body renders, so the header stat and the rendered diff can never disagree
 *  with each other. */
export function computeDiffStats(oldText: string, newText: string): DiffStats {
  const lines = buildDiffLines(oldText, newText);
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.marker === "+") added++;
    else if (line.marker === "-") removed++;
  }
  return { added, removed };
}

/** Renders a gutter-numbered diff into `wrapper`: a scrollable body (one row per line with a line
 *  number, a +/-/blank marker, and its content — word-level emphasis highlights only the specific
 *  text that changed within a line, see buildDiffLines) plus a fixed minimap strip along the right
 *  edge. The minimap must be a *sibling* of the scrolling element, not a child of it — an
 *  absolutely-positioned child scrolls along with its scrollable parent's content, which would
 *  slide the tick marks out of sync with what they're pointing at. `wrapper` is what carries
 *  position:relative so the minimap (and the scroll body's own overlay chrome) anchor to the
 *  whole diff area, not just the scrolled content. */
export function renderDiffBody(wrapper: HTMLElement, oldText: string, newText: string): HTMLElement {
  wrapper.addClass("skillmanager-diff-body-wrapper");
  const scrollBody = wrapper.createDiv({ cls: "skillmanager-diff-body skillmanager-diff-gutter-body" });
  const lines = buildDiffLines(oldText, newText);
  for (const line of lines) {
    renderDiffLine(scrollBody, line);
  }
  renderMinimap(wrapper, scrollBody, lines);
  return scrollBody;
}

/** Collapses each run of unchanged lines longer than `keep * 2 + 2` down to `keep` lines of
 *  context on either side, behind a row that expands it in place. Works on the rows
 *  renderDiffBody already drew, so the shared renderer and its line numbers stay untouched. */
export function foldUnchanged(scrollBody: HTMLElement, keep = 3): void {
  const rows = Array.from(scrollBody.children) as HTMLElement[];
  let runStart = 0;
  const flush = (end: number) => {
    const lead = runStart === 0 ? 0 : keep;
    const tail = end === rows.length ? 0 : keep;
    const hidden = rows.slice(runStart + lead, end - tail);
    if (hidden.length < 4) return;
    for (const row of hidden) row.hide();
    const fold = createEl("button", {
      cls: "skillmanager-diff-fold",
      text: `${hidden.length} unchanged lines`,
      attr: { "aria-label": `Show ${hidden.length} unchanged lines` },
    });
    fold.addEventListener("click", () => {
      for (const row of hidden) row.show();
      fold.remove();
    });
    scrollBody.insertBefore(fold, hidden[0]);
  };
  for (let i = 0; i <= rows.length; i++) {
    const isContext = i < rows.length && rows[i].hasClass("skillmanager-diff-line-context");
    if (isContext) continue;
    if (i > runStart) flush(i);
    runStart = i + 1;
  }
}

/** The first row of each contiguous block of added/removed lines, in order: the stops for
 *  next/previous change navigation. */
export function changeHunks(scrollBody: HTMLElement): HTMLElement[] {
  const starts: HTMLElement[] = [];
  let inHunk = false;
  for (const child of Array.from(scrollBody.children) as HTMLElement[]) {
    if (!child.hasClass("skillmanager-diff-line")) continue;
    const changed = !child.hasClass("skillmanager-diff-line-context");
    if (changed && !inHunk) starts.push(child);
    inHunk = changed;
  }
  return starts;
}

/** Change-position ticks (fixed, one per changed line) plus a translucent viewport indicator that
 *  tracks the scroll body's actual scrollTop/scrollHeight — shows which slice of the diff is
 *  currently on screen, not just where the changes are. Only relevant once content overflows;
 *  hidden when it doesn't (nothing to scroll to). */
export function renderMinimap(wrapper: HTMLElement, scrollBody: HTMLElement, lines: DiffLine[]): void {
  if (lines.length === 0) return;
  const total = lines.length;
  const minimap = wrapper.createDiv({ cls: "skillmanager-diff-minimap" });
  for (const line of lines) {
    if (line.marker === " ") continue;
    const tick = minimap.createDiv({
      cls: `skillmanager-diff-minimap-tick skillmanager-diff-minimap-tick-${line.marker === "+" ? "add" : "remove"}`,
    });
    tick.style.top = `${((line.lineNumber - 1) / total) * 100}%`;
  }

  const viewport = minimap.createDiv({ cls: "skillmanager-diff-minimap-viewport" });
  const updateViewport = () => {
    const { scrollTop, scrollHeight, clientHeight } = scrollBody;
    if (scrollHeight <= clientHeight) {
      viewport.hide();
      return;
    }
    viewport.show();
    viewport.style.top = `${(scrollTop / scrollHeight) * 100}%`;
    viewport.style.height = `${Math.max((clientHeight / scrollHeight) * 100, 4)}%`;
  };
  scrollBody.addEventListener("scroll", updateViewport);
  updateViewport();
}

function renderDiffLine(container: HTMLElement, line: DiffLine): void {
  const marker = line.marker === "+" ? "add" : line.marker === "-" ? "remove" : "context";
  const row = container.createDiv({ cls: `skillmanager-diff-line skillmanager-diff-line-${marker}` });

  row.createSpan({ cls: "skillmanager-diff-gutter-num", text: String(line.lineNumber) });
  row.createSpan({ cls: "skillmanager-diff-marker", text: line.marker });

  const content = row.createSpan({ cls: "skillmanager-diff-content" });
  for (const segment of line.segments) {
    if (segment.emphasis) {
      content.createSpan({
        cls: line.marker === "-" ? "skillmanager-diff-remove" : "skillmanager-diff-add",
        text: segment.text,
      });
    } else {
      content.appendChild(activeDocument.createTextNode(segment.text));
    }
  }
}
