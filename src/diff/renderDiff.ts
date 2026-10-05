import { DiffLine } from "./buildDiffLines";

export type DiffSegment = { kind: "rows" | "fold"; from: number; to: number };

/** Splits a diff into the stretches to draw and the unchanged stretches to fold away: every run
 *  of unchanged lines keeps `keep` lines of context next to each change and folds the rest, unless
 *  fewer than `minFold` lines would fold. `to` is exclusive. */
export function foldSegments(lines: DiffLine[], keep = 3, minFold = 4): DiffSegment[] {
  const segments: DiffSegment[] = [];
  const push = (kind: DiffSegment["kind"], from: number, to: number) => {
    if (to <= from) return;
    const last = segments[segments.length - 1];
    if (last && last.kind === kind && last.to === from) last.to = to;
    else segments.push({ kind, from, to });
  };
  let i = 0;
  while (i < lines.length) {
    if (lines[i].marker !== " ") {
      push("rows", i, i + 1);
      i++;
      continue;
    }
    let end = i;
    while (end < lines.length && lines[end].marker === " ") end++;
    const lead = i === 0 ? 0 : keep;
    const tail = end === lines.length ? 0 : keep;
    if (end - i - lead - tail >= minFold) {
      push("rows", i, i + lead);
      push("fold", i + lead, end - tail);
      push("rows", end - tail, end);
    } else {
      push("rows", i, end);
    }
    i = end;
  }
  return segments;
}

/** How many folded lines one click on a fold row draws, so expanding a huge unchanged stretch
 *  never builds thousands of rows at once. */
const FOLD_CHUNK = 300;

/** Like renderDiffBody, but only builds rows for changes and the context around them. Folded
 *  stretches are drawn on demand from their row (FOLD_CHUNK lines per click), which keeps a
 *  13,000-line file with a few changes as cheap to open as a short one. Returns the first row of
 *  each change, in order, for next/previous navigation. No minimap: folding makes its
 *  line-proportional ticks misleading. */
export function renderFoldedDiff(wrapper: HTMLElement, lines: DiffLine[], keep = 3): HTMLElement[] {
  wrapper.addClass("skillmanager-diff-body-wrapper");
  const body = wrapper.createDiv({ cls: "skillmanager-diff-body skillmanager-diff-gutter-body" });
  const hunks: HTMLElement[] = [];
  for (const segment of foldSegments(lines, keep)) {
    if (segment.kind === "rows") {
      for (let i = segment.from; i < segment.to; i++) {
        const row = renderDiffLine(body, lines[i]);
        if (lines[i].marker !== " " && (i === 0 || lines[i - 1].marker === " ")) hunks.push(row);
      }
      continue;
    }
    let from = segment.from;
    const fold = body.createEl("button", { cls: "skillmanager-diff-fold" });
    const label = () => {
      const hidden = segment.to - from;
      fold.setText(hidden > FOLD_CHUNK ? `${hidden.toLocaleString()} unchanged lines · show ${FOLD_CHUNK}` : `${hidden.toLocaleString()} unchanged lines`);
      fold.setAttr("aria-label", `Show ${Math.min(hidden, FOLD_CHUNK)} of ${hidden} unchanged lines`);
    };
    label();
    fold.addEventListener("click", () => {
      const to = Math.min(segment.to, from + FOLD_CHUNK);
      const chunk = createFragment((frag) => {
        for (let i = from; i < to; i++) renderDiffLine(frag as unknown as HTMLElement, lines[i]);
      });
      fold.before(chunk);
      from = to;
      if (from >= segment.to) fold.remove();
      else label();
    });
  }
  return hunks;
}

function renderDiffLine(container: HTMLElement, line: DiffLine): HTMLElement {
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
  return row;
}
