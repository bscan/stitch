// "Copy Diff": a commit's message and details plus a unified diff of one file,
// as text for the clipboard. Pure functions (no vscode), so they're unit-tested.
//
// The diff is computed here rather than asked of git or the server: SVN has no
// binary to ask, and git's `diff` isn't on the read-only allowlist. Both
// backends already serve file content at a revision, which is all this needs.

import { Commit, Side } from "../backend";

export type Vcs = "git" | "svn";

const CONTEXT = 3;
/** Above this many differing lines Myers' trace gets large: the changed middle is shown as one replacement. */
const MAX_EDIT_DISTANCE = 4000;
const BINARY_SNIFF_BYTES = 8000;

/** Text of a file, or undefined for binary content (a NUL byte, as git decides). */
export function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Not UTF-8: old SVN repos are full of Windows-1252. Latin-1 keeps every byte as one character.
    return Buffer.from(bytes).toString("latin1");
  }
}

interface Lines {
  lines: string[];
  /** The last line has no newline after it. */
  noEol: boolean;
}

function splitLines(text: string): Lines {
  if (text === "") return { lines: [], noEol: false };
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
    return { lines, noEol: false };
  }
  return { lines, noEol: true };
}

type Op = "=" | "-" | "+";

/**
 * Myers' O(ND) diff over two arrays of keys. Returns the edit script, or
 * undefined when the edit distance passes `limit`.
 */
function myers(a: string[], b: string[], limit: number): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v[k] for k in [-d-1, d+1] as it was before step d.
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    if (d > limit) return undefined;
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const snap = trace[d];
    const at = (k: number) => snap[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push("=");
      x--;
      y--;
    }
    if (d > 0) ops.push(x === prevX ? "+" : "-");
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/** Edit script for two line lists: common ends trimmed, then Myers on the middle. */
function editScript(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const middle: Op[] = myers(am, bm, MAX_EDIT_DISTANCE) ?? [...am.map((): Op => "-"), ...bm.map((): Op => "+")];
  return [...Array<Op>(pre).fill("="), ...middle, ...Array<Op>(suf).fill("=")];
}

const NO_EOL_KEY = "\n"; // can't occur inside a line, so "x" without a newline never equals "x" with one

const range = (start0: number, len: number) =>
  // 1-based start; an empty range names the line before it (0 at the top), as diff does.
  `${len === 0 ? start0 : start0 + 1}${len === 1 ? "" : `,${len}`}`;

/**
 * The hunks of a unified diff (`@@ … @@` onwards), or "" when the texts are equal.
 * Lines keep any `\r`, so CRLF files diff line by line like git shows them.
 */
export function unifiedHunks(oldText: string, newText: string, context = CONTEXT): string {
  const A = splitLines(oldText);
  const B = splitLines(newText);
  const keys = (l: Lines) => l.lines.map((s, i) => (l.noEol && i === l.lines.length - 1 ? s + NO_EOL_KEY : s));
  const ops = editScript(keys(A), keys(B));

  // Positions of each op in both files.
  const ai: number[] = [];
  const bi: number[] = [];
  let x = 0;
  let y = 0;
  for (const op of ops) {
    ai.push(x);
    bi.push(y);
    if (op !== "+") x++;
    if (op !== "-") y++;
  }

  const out: string[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i] === "=") {
      i++;
      continue;
    }
    // A hunk: from `context` lines before this change to `context` after the last change
    // that isn't separated from the previous one by more than 2 × context equal lines.
    const start = Math.max(0, i - context);
    let end = i;
    let j = i;
    while (j < ops.length) {
      if (ops[j] !== "=") {
        end = j + 1;
        j++;
        continue;
      }
      let run = 0;
      while (j + run < ops.length && ops[j + run] === "=") run++;
      if (j + run >= ops.length || run > 2 * context) break;
      j += run;
    }
    const stop = Math.min(ops.length, end + context);
    let aLen = 0;
    let bLen = 0;
    const body: string[] = [];
    for (let k = start; k < stop; k++) {
      const op = ops[k];
      const fromA = op !== "+";
      const lines = fromA ? A : B;
      const idx = fromA ? ai[k] : bi[k];
      if (op !== "+") aLen++;
      if (op !== "-") bLen++;
      body.push((op === "=" ? " " : op) + lines.lines[idx]);
      const lastA = op !== "+" && A.noEol && ai[k] === A.lines.length - 1;
      const lastB = op !== "-" && B.noEol && bi[k] === B.lines.length - 1;
      if (lastA || lastB) body.push("\\ No newline at end of file");
    }
    out.push(`@@ -${range(ai[start], aLen)} +${range(bi[start], bLen)} @@`, ...body);
    i = stop;
  }
  return out.length ? out.join("\n") + "\n" : "";
}

/** One side's content for formatDiff: text, or undefined if the file is binary. */
export interface SideText {
  side: Side;
  text: string | undefined;
}

export interface DiffInput {
  vcs: Vcs;
  commit: Commit;
  left: SideText;
  right: SideText;
  /** Timezone offset in minutes, as Date.getTimezoneOffset() (tests pass a fixed one). */
  tzOffset?: number;
}

const strip = (p: string) => p.replace(/^\/+/, "");
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The date's fields in the local zone (or the given offset), plus "+0100". */
function local(date: Date, tzOffset = date.getTimezoneOffset()) {
  const d = new Date(date.getTime() - tzOffset * 60000);
  const east = -tzOffset;
  const zone = `${east < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(east) / 60))}${pad(Math.abs(east) % 60)}`;
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth(),
    day: d.getUTCDate(),
    wd: d.getUTCDay(),
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
    zone,
  };
}

/** git log's default: "Sun Nov 8 10:00:00 2026 +0100". */
export function gitDate(date: Date, tzOffset?: number): string {
  const l = local(date, tzOffset);
  return `${DAYS[l.wd]} ${MONTHS[l.mo]} ${l.day} ${l.time} ${l.y} ${l.zone}`;
}

/** svn log's: "2026-11-08 10:00:00 +0100 (Sun, 08 Nov 2026)". */
export function svnDate(date: Date, tzOffset?: number): string {
  const l = local(date, tzOffset);
  return `${l.y}-${pad(l.mo + 1)}-${pad(l.day)} ${l.time} ${l.zone} (${DAYS[l.wd]}, ${pad(l.day)} ${MONTHS[l.mo]} ${l.y})`;
}

function message(c: Commit): string {
  return c.body ? `${c.subject}\n\n${c.body}` : c.subject;
}

function gitHeader(c: Commit, tz?: number): string {
  const lines = [`commit ${c.rev}`];
  if (c.parents.length > 1) lines.push(`Merge: ${c.parents.map((p) => p.slice(0, 7)).join(" ")}`);
  lines.push(c.email ? `Author: ${c.author} <${c.email}>` : `Author: ${c.author}`);
  lines.push(`Date:   ${gitDate(c.date, tz)}`, "");
  for (const l of message(c).split("\n")) lines.push(l ? `    ${l}` : "");
  return lines.join("\n") + "\n";
}

function gitPatch(left: SideText, right: SideText): string {
  const a = strip(left.side.path);
  const b = strip(right.side.path);
  const lines = [`diff --git a/${a} b/${b}`];
  // No "new file mode" lines: the mode isn't known, and `--- /dev/null` says it anyway.
  if (left.side.kind !== "empty" && right.side.kind !== "empty" && a !== b) lines.push(`rename from ${a}`, `rename to ${b}`);
  if (left.text === undefined || right.text === undefined) {
    lines.push(`Binary files ${left.side.kind === "empty" ? "/dev/null" : `a/${a}`} and ${right.side.kind === "empty" ? "/dev/null" : `b/${b}`} differ`);
    return lines.join("\n") + "\n";
  }
  const hunks = unifiedHunks(left.text, right.text);
  if (!hunks) return lines.join("\n") + "\n";
  lines.push(left.side.kind === "empty" ? "--- /dev/null" : `--- a/${a}`);
  lines.push(right.side.kind === "empty" ? "+++ /dev/null" : `+++ b/${b}`);
  return lines.join("\n") + "\n" + hunks;
}

const RULE = "-".repeat(72);

function svnHeader(c: Commit, tz?: number): string {
  const msg = message(c);
  const n = msg.split("\n").length;
  return [RULE, `r${c.rev} | ${c.author} | ${svnDate(c.date, tz)} | ${n} line${n === 1 ? "" : "s"}`, "", msg, RULE].join("\n") + "\n";
}

function svnPatch(left: SideText, right: SideText): string {
  const label = (s: SideText) => `${strip(s.side.path)}\t(${s.side.kind === "rev" ? `revision ${s.side.rev}` : "nonexistent"})`;
  const lines = [`Index: ${strip(right.side.path)}`, "=".repeat(67)];
  if (left.text === undefined || right.text === undefined) {
    lines.push("Cannot display: file marked as a binary type.");
    return lines.join("\n") + "\n";
  }
  lines.push(`--- ${label(left)}`, `+++ ${label(right)}`);
  return lines.join("\n") + "\n" + unifiedHunks(left.text, right.text);
}

/** The commit's details and message, a blank line, then the file's diff. */
export function formatDiff(input: DiffInput): string {
  const { vcs, commit, left, right, tzOffset } = input;
  return vcs === "git"
    ? `${gitHeader(commit, tzOffset)}\n${gitPatch(left, right)}`
    : `${svnHeader(commit, tzOffset)}\n${svnPatch(left, right)}`;
}
