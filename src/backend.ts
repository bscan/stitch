// Types shared by the history view and the VCS backends. No vscode imports,
// so everything that uses only these types can be unit-tested with plain mocha.

export interface Commit {
  /** Full revision id (git hash, or SVN revision number as a string). */
  rev: string;
  shortRev: string;
  /** Parent revisions; the first is the first parent. Empty for a root commit. */
  parents: string[];
  author: string;
  email: string;
  date: Date;
  subject: string;
  body: string;
  /** Branch/tag decorations, e.g. ["HEAD -> main", "tag: v1.0"]. */
  refs: string[];
  isMerge: boolean;
  /** A merge whose subject looks like `git pull` created it (parents are swapped). */
  isPullMerge: boolean;
  /** Repo-relative path of the file in this commit. */
  path: string;
  /** Repo-relative path of the file in the first parent; undefined if the file doesn't exist there. */
  oldPath?: string;
  /** Name-status letter(s) for the file in this commit: A, M, D, R087, … (absent for merges on old git). */
  status?: string;
  /**
   * Every file the commit changed (git: against its first parent), once known.
   * svn fills it from the log; git fills it later, a page at a time.
   */
  files?: ChangedFile[];
}

/** One file changed by a commit. Paths are repository-relative, without a leading slash. */
export interface ChangedFile {
  path: string;
  /** A (added), M, D, R (renamed/moved), C (copied with history), T (type change). */
  status: string;
  /** Path before the commit, for a rename or copy. */
  oldPath?: string;
  /** svn: the revision of the "before" side (rev − 1, or the copy source's revision). git: absent (first parent). */
  fromRev?: string;
}

/**
 * One side of a diff: a file at a revision, SVN BASE (the pristine copy in .svn,
 * keywords expanded), or nothing (added/deleted/root).
 */
export type Side =
  | { kind: "rev"; rev: string; path: string }
  | { kind: "base"; path: string }
  | { kind: "empty"; path: string };

/** The two sides of one changed file of a commit (see Commit.files). */
export function fileDiff(c: Commit, f: ChangedFile): { left: Side; right: Side } {
  const before = f.fromRev ?? c.parents[0];
  const left: Side =
    f.status.startsWith("A") || !before
      ? { kind: "empty", path: f.oldPath ?? f.path }
      : { kind: "rev", rev: before, path: f.oldPath ?? f.path };
  const right: Side = f.status.startsWith("D") ? { kind: "empty", path: f.path } : { kind: "rev", rev: c.rev, path: f.path };
  return { left, right };
}

/** The two sides to show for "Diff with Previous" on a commit: first parent ↔ commit. */
export function previousDiff(c: Commit): { left: Side; right: Side } {
  const parent = c.parents[0];
  const left: Side =
    parent && c.oldPath !== undefined && !c.status?.startsWith("A")
      ? { kind: "rev", rev: parent, path: c.oldPath }
      : { kind: "empty", path: c.oldPath ?? c.path };
  const right: Side = c.status?.startsWith("D")
    ? { kind: "empty", path: c.path }
    : { kind: "rev", rev: c.rev, path: c.path };
  return { left, right };
}
