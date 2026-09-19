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
export function renderDiffBody(wrapper: HTMLElement, oldText: string, newText: string): void {
  wrapper.addClass("skillspace-diff-body-wrapper");
  const scrollBody = wrapper.createDiv({ cls: "skillspace-diff-body skillspace-diff-gutter-body" });
  const lines = buildDiffLines(oldText, newText);
  for (const line of lines) {
    renderDiffLine(scrollBody, line);
  }
  renderMinimap(wrapper, scrollBody, lines);
}

/** Change-position ticks (fixed, one per changed line) plus a translucent viewport indicator that
 *  tracks the scroll body's actual scrollTop/scrollHeight — shows which slice of the diff is
 *  currently on screen, not just where the changes are. Only relevant once content overflows;
 *  hidden when it doesn't (nothing to scroll to). */
export function renderMinimap(wrapper: HTMLElement, scrollBody: HTMLElement, lines: DiffLine[]): void {
  if (lines.length === 0) return;
  const total = lines.length;
  const minimap = wrapper.createDiv({ cls: "skillspace-diff-minimap" });
  for (const line of lines) {
    if (line.marker === " ") continue;
    const tick = minimap.createDiv({
      cls: `skillspace-diff-minimap-tick skillspace-diff-minimap-tick-${line.marker === "+" ? "add" : "remove"}`,
    });
    tick.style.top = `${((line.lineNumber - 1) / total) * 100}%`;
  }

  const viewport = minimap.createDiv({ cls: "skillspace-diff-minimap-viewport" });
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
  const row = container.createDiv({ cls: `skillspace-diff-line skillspace-diff-line-${marker}` });

  row.createSpan({ cls: "skillspace-diff-gutter-num", text: String(line.lineNumber) });
  row.createSpan({ cls: "skillspace-diff-marker", text: line.marker });

  const content = row.createSpan({ cls: "skillspace-diff-content" });
  for (const segment of line.segments) {
    if (segment.emphasis) {
      content.createSpan({
        cls: line.marker === "-" ? "skillspace-diff-remove" : "skillspace-diff-add",
        text: segment.text,
      });
    } else {
      content.appendChild(activeDocument.createTextNode(segment.text));
    }
  }
}
