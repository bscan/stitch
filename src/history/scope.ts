// What the Stitch History view shows: a scope (a file, a folder, or a whole
// working copy) and filters (lines, author, message). Pure functions, no vscode.
//
// The view is either *following* (the normal view: the active editor's file, or
// its working copy with `stitch.history.follow: "workingCopy"`, no filters) or
// *held* (anything else), which ignores editor switches until Clear. The exception is
// a line filter: switching to another file ends it (see releasedBy).
import * as path from "path";
import { Commit } from "../backend";
import { VcsKind } from "../resolver";

export type ScopeKind = "file" | "folder" | "workingCopy";

export interface Scope {
  kind: ScopeKind;
  vcs: VcsKind;
  /** The working copy (repository) root the scope is in. */
  root: string;
  /** Absolute local path: the file, the folder, or the root itself for a working copy. */
  path: string;
}

/** 1-based, inclusive line numbers. */
export interface LineRange {
  start: number;
  end: number;
}

export interface Filters {
  /**
   * File scope only. `range` is in the file as committed (BASE/HEAD), mapped from
   * the editor selection; it is absent when every selected line is uncommitted.
   */
  lines?: { range?: LineRange; editor: LineRange; uncommitted: boolean };
  /** `exact`: from "Only this author" (git: the email, svn: the name); otherwise a case-insensitive substring. */
  author?: { text: string; exact?: boolean; label?: string };
  /** Case-insensitive substring of the message. */
  message?: string;
}

export interface HistorySpec {
  scope: Scope;
  filters: Filters;
}

export type FollowMode = "file" | "workingCopy";

export const hasFilters = (f: Filters): boolean => !!(f.lines || f.author || f.message);

/** Identifies a spec (source caches, tree ids, comparing with the normal view). */
export function specKey(s: HistorySpec): string {
  const f = s.filters;
  return JSON.stringify([
    s.scope.kind,
    s.scope.vcs,
    s.scope.root,
    s.scope.path,
    f.lines?.range ?? (f.lines ? "none" : null),
    f.author ? [f.author.text, !!f.author.exact] : null,
    f.message ?? null,
  ]);
}

export const sameSpec = (a: HistorySpec | undefined, b: HistorySpec | undefined): boolean =>
  !!a && !!b && specKey(a) === specKey(b);

/** The normal view for the active file in its working copy. */
export function normalSpec(file: string, vcs: VcsKind, root: string, follow: FollowMode): HistorySpec {
  return follow === "workingCopy"
    ? { scope: { kind: "workingCopy", vcs, root, path: root }, filters: {} }
    : { scope: { kind: "file", vcs, root, path: file }, filters: {} };
}

/** Scope with a path: a folder that is the working-copy root is the working-copy scope. */
export function folderScope(vcs: VcsKind, root: string, dir: string): Scope {
  return samePath(dir, root) ? { kind: "workingCopy", vcs, root, path: root } : { kind: "folder", vcs, root, path: dir };
}

/** Same folder or file. path.relative compares Windows paths case-insensitively ("c:\\x" from VS Code, "C:/x" from git). */
export function samePath(a: string, b: string): boolean {
  return path.relative(a, b) === "";
}

/** Whether `p` is `dir` or inside it. */
export function isInside(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Whether a file is part of what the scope shows. */
export function scopeContains(scope: Scope, file: string): boolean {
  return scope.kind === "file" ? samePath(scope.path, file) : isInside(file, scope.path);
}

/**
 * Whether switching the editor to `file` ends a held view: only a line filter does,
 * and only for another file. Lines are a look at one spot of one file; other filters
 * and scopes stay until Clear. Anything stacked on the lines goes with them.
 */
export function releasedBy(held: HistorySpec, file: string): boolean {
  return !!held.filters.lines && !scopeContains(held.scope, file);
}

/**
 * The scopes the filter menu offers for a file, narrowest first: the file, each
 * folder from its own up to (not including) the working-copy root, then the working copy.
 */
export function scopesFor(file: string, vcs: VcsKind, root: string): Scope[] {
  const out: Scope[] = [{ kind: "file", vcs, root, path: file }];
  let dir = path.dirname(file);
  while (isInside(dir, root) && !samePath(dir, root)) {
    out.push({ kind: "folder", vcs, root, path: dir });
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  out.push({ kind: "workingCopy", vcs, root, path: root });
  return out;
}

/** "a.txt", "src/history" (relative to the working copy), "stitch" (the working copy's folder name). */
export function scopeName(scope: Scope): string {
  if (scope.kind === "workingCopy") return path.basename(scope.root) || scope.root;
  if (scope.kind === "file") return path.basename(scope.path);
  return path.relative(scope.root, scope.path).split(path.sep).join("/");
}

/** Repository-relative path with "/" separators ("" for the root). */
export function relPath(scope: Scope): string {
  return path.relative(scope.root, scope.path).split(path.sep).join("/");
}

export function linesText(r: LineRange): string {
  return r.start === r.end ? `line ${r.start}` : `lines ${r.start}–${r.end}`;
}

/** The filters in words: "author brian · message “fix” · lines 10–20". */
export function filterSummary(f: Filters): string {
  const bits: string[] = [];
  if (f.lines) bits.push(linesText(f.lines.editor));
  if (f.author) bits.push(`author ${f.author.label ?? f.author.text}`);
  if (f.message) bits.push(`message “${f.message}”`);
  return bits.join(" · ");
}

/** The last row of a filtered history once nothing older matches: "No more commits by brian". */
export function endText(f: Filters, vcs: VcsKind): string {
  const what = vcs === "svn" ? "revisions" : "commits";
  if (f.lines && !f.author && !f.message) return `No older ${what} changed these lines`;
  const bits: string[] = [];
  if (f.author) bits.push(`by ${f.author.label ?? f.author.text}`);
  if (f.message) bits.push(`matching “${f.message}”`);
  if (f.lines) bits.push(`changing ${linesText(f.lines.editor)}`);
  return `No more ${what} ${bits.join(" ")}`;
}

const lower = (s: string) => s.toLocaleLowerCase();

/**
 * Whether a commit passes the author and message filters (svn filters on the
 * client; git asks git). The line filter is checked elsewhere.
 */
export function matchesFilters(c: Commit, f: Filters): boolean {
  if (f.author) {
    const a = f.author;
    if (a.exact ? c.author !== a.text && c.email !== a.text : !lower(`${c.author} ${c.email}`).includes(lower(a.text))) {
      return false;
    }
  }
  if (f.message) {
    const msg = c.body ? `${c.subject}\n${c.body}` : c.subject;
    if (!lower(msg).includes(lower(f.message))) return false;
  }
  return true;
}
