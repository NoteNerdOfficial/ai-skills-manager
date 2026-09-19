import { diffLines, diffWordsWithSpace } from "diff";

export interface DiffLineSegment {
  text: string;
  /** true = this specific word/phrase changed within an otherwise-shared
   *  line (render with strong color); false = shared/context text within
   *  that same line (render plain, even though the line itself is marked
   *  +/-). */
  emphasis: boolean;
}

export interface DiffLine {
  /** Sequential gutter number, 1-based, incrementing once per rendered
   *  row regardless of +/-/context -- matches the simple single-column
   *  numbering style (not separate old/new line-number columns). */
  lineNumber: number;
  marker: "+" | "-" | " ";
  segments: DiffLineSegment[];
}

/**
 * Produces a gutter-numbered, line-structured diff, while still surfacing
 * word-level detail within changed lines rather than coloring whole lines
 * outright. diffLines() gives the line-level +/-/context structure needed
 * for gutter numbers and markers; for a "replacement" (a contiguous
 * removed block immediately followed by a contiguous added block) where
 * both sides have the same number of lines -- the common case of editing
 * existing lines in place -- diffWordsWithSpace() is run per corresponding
 * line pair so only the actually-changed words get emphasis, with shared
 * text rendered plain on both the removed and added row. Blocks that don't
 * line up 1:1 (pure insertions/deletions, or an uneven replacement) fall
 * back to whole-line emphasis, which is still correct, just less precise.
 */
export function buildDiffLines(oldText: string, newText: string): DiffLine[] {
  const parts = diffLines(oldText, newText);
  const lines: DiffLine[] = [];
  let lineNumber = 1;

  const pushWholeLines = (text: string, marker: "+" | "-" | " ", emphasis: boolean) => {
    for (const lineText of splitLines(text)) {
      lines.push({ lineNumber: lineNumber++, marker, segments: [{ text: lineText, emphasis }] });
    }
  };

  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (!part) break;

    if (!part.added && !part.removed) {
      pushWholeLines(part.value, " ", false);
      i++;
      continue;
    }

    const nextPart = parts[i + 1];
    if (part.removed && nextPart?.added) {
      const removedLines = splitLines(part.value);
      const addedLines = splitLines(nextPart.value);

      if (removedLines.length === addedLines.length) {
        for (let k = 0; k < removedLines.length; k++) {
          const removedLine = removedLines[k];
          const addedLine = addedLines[k];
          if (removedLine === undefined || addedLine === undefined) continue;
          const wordParts = diffWordsWithSpace(removedLine, addedLine);
          lines.push({ lineNumber: lineNumber++, marker: "-", segments: buildSegments(wordParts, "removed") });
          lines.push({ lineNumber: lineNumber++, marker: "+", segments: buildSegments(wordParts, "added") });
        }
      } else {
        for (const lineText of removedLines) {
          lines.push({ lineNumber: lineNumber++, marker: "-", segments: [{ text: lineText, emphasis: true }] });
        }
        for (const lineText of addedLines) {
          lines.push({ lineNumber: lineNumber++, marker: "+", segments: [{ text: lineText, emphasis: true }] });
        }
      }
      i += 2;
      continue;
    }

    if (part.removed) {
      pushWholeLines(part.value, "-", true);
      i++;
      continue;
    }

    // part.added, with no preceding removed block already consumed above
    pushWholeLines(part.value, "+", true);
    i++;
  }

  return lines;
}

export function buildSegments(
  wordParts: ReturnType<typeof diffWordsWithSpace>,
  side: "removed" | "added"
): DiffLineSegment[] {
  const segments: DiffLineSegment[] = [];
  for (const part of wordParts) {
    if (side === "removed") {
      if (part.added) continue;
      segments.push({ text: part.value, emphasis: !!part.removed });
    } else {
      if (part.removed) continue;
      segments.push({ text: part.value, emphasis: !!part.added });
    }
  }
  return segments;
}

// diffLines' trailing split artifact: a value ending in "\n" produces a
// phantom empty final segment when naively split -- drop it so line counts
// match the visual line count.
export function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}
