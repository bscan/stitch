// Undoing one gutter-diff hunk: works out the edit that puts the original lines back
// into the editor text. Pure string work, so it can be tested without VS Code.

/** One hunk as VS Code's quick diff peek passes it (1-based lines; an end of 0 means "no lines on this side"). */
export interface LineChange {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

/** Replace `modified.slice(start, end)` with `text`. */
export interface TextReplacement {
  start: number;
  end: number;
  text: string;
}

/** Splits text into lines the way VS Code counts them, each with its line ending (the last has none). */
export function lineSegments(text: string): string[] {
  const segs: string[] = [];
  const re = /\r\n|\r|\n/g;
  let from = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    segs.push(text.slice(from, m.index + m[0].length));
    from = m.index + m[0].length;
  }
  segs.push(text.slice(from));
  return segs;
}

const eolOf = (seg: string) => /(\r\n|\r|\n)$/.exec(seg)?.[0] ?? "";

/** The edit to `modified` that reverts `change` to the lines it has in `original`. */
export function revertHunk(original: string, modified: string, change: LineChange): TextReplacement {
  const orig = lineSegments(original);
  const mod = lineSegments(modified);
  const offsets: number[] = [0];
  for (const s of mod) offsets.push(offsets[offsets.length - 1] + s.length);
  const atLine = (i: number) => offsets[Math.max(0, Math.min(i, mod.length))];

  const isInsertion = change.originalEndLineNumber === 0;
  const isDeletion = change.modifiedEndLineNumber === 0;

  if (isInsertion) {
    // Lines were added: remove them. If they run to the end of the text, also drop the
    // line ending before them, which the original didn't have.
    const s = change.modifiedStartLineNumber - 1;
    const e = change.modifiedEndLineNumber;
    if (e >= mod.length && s > 0) {
      return { start: atLine(s) - eolOf(mod[s - 1]).length, end: atLine(e), text: "" };
    }
    return { start: atLine(s), end: atLine(e), text: "" };
  }

  const os = change.originalStartLineNumber - 1;
  const oe = change.originalEndLineNumber;
  let text = orig.slice(os, oe).join("");
  const origRunsToEnd = oe >= orig.length;

  if (isDeletion) {
    // Lines were removed after modified line `ms`: put them back there.
    const at = change.modifiedStartLineNumber;
    if (origRunsToEnd && at >= mod.length) {
      // Restoring the original's last line at the very end: it needs the line ending
      // that the original had before it.
      return { start: atLine(at), end: atLine(at), text: (os > 0 ? eolOf(orig[os - 1]) : "") + text };
    }
    return { start: atLine(at), end: atLine(at), text };
  }

  const ms = change.modifiedStartLineNumber - 1;
  const me = change.modifiedEndLineNumber;
  const modRunsToEnd = me >= mod.length;
  if (origRunsToEnd && !modRunsToEnd) {
    // Text follows the hunk in the editor, so keep a line ending between them.
    text += eolOf(mod[me - 1]);
  }
  return { start: atLine(ms), end: atLine(me), text };
}
