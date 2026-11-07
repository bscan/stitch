// Parsing for `git log --name-status -z --format=LOG_FORMAT`. Pure functions.
import { Commit } from "../backend";

// Each record starts with \x1e; header fields are NUL-terminated. With -z the
// name-status part that follows is NUL-separated tokens:
//   STATUS \0 PATH \0            (A, M, D, T, …)
//   STATUS \0 OLD \0 NEW \0      (R###, C###)
export const LOG_FORMAT = "%x1e%H%x00%P%x00%an%x00%ae%x00%at%x00%D%x00%s%x00%b%x00";
const HEADER_FIELDS = 8;

export interface Change {
  status: string;
  path: string;
  oldPath?: string;
}

export interface RawCommit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  refs: string[];
  subject: string;
  body: string;
  changes: Change[];
}

const STATUS = /^[ACDMRTUXB]\d*$/;

export function parseLog(out: Buffer | string): RawCommit[] {
  const text = typeof out === "string" ? out : out.toString("utf8");
  const result: RawCommit[] = [];
  for (const rec of text.split("\x1e")) {
    if (!rec.trim()) continue;
    const parts = rec.split("\0");
    if (parts.length < HEADER_FIELDS) continue;
    const [hash, parents, author, email, time, refs, subject, body] = parts;
    const tokens = parts
      .slice(HEADER_FIELDS)
      .map((t) => t.replace(/^\n+/, ""))
      .filter((t) => t !== "");
    result.push({
      hash,
      parents: parents ? parents.split(" ") : [],
      author,
      email,
      time: Number(time),
      refs: refs ? refs.split(", ") : [],
      subject,
      body: body.trim(),
      changes: parseChanges(tokens),
    });
  }
  return result;
}

function parseChanges(tokens: string[]): Change[] {
  const changes: Change[] = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i];
    if (!STATUS.test(status)) {
      i++;
      continue;
    }
    if (status[0] === "R" || status[0] === "C") {
      if (i + 2 >= tokens.length) break;
      changes.push({ status, oldPath: tokens[i + 1], path: tokens[i + 2] });
      i += 3;
    } else {
      if (i + 1 >= tokens.length) break;
      changes.push({ status, path: tokens[i + 1] });
      i += 2;
    }
  }
  return changes;
}

// Subjects git writes for `git pull` (or merging the remote-tracking branch of
// the branch you're on). In these merges the first parent is the local work and
// the real trunk is the second parent.
const PULL_MERGE = /^Merge (branch '[^']+' of \S+|remote-tracking branch '[^']+')/;

/**
 * Converts raw commits (newest first, all from one walk that followed `startPath`)
 * into Commits, tracking the file's path through renames.
 */
export function toCommits(raws: RawCommit[], startPath: string): Commit[] {
  let current = startPath;
  return raws.map((r) => {
    const change =
      r.changes.find((c) => c.path === current) ??
      (r.changes.length === 1 ? r.changes[0] : undefined);
    const path = change?.path ?? current;
    let oldPath: string | undefined;
    if (r.parents.length === 0 || change?.status.startsWith("A")) {
      oldPath = undefined;
    } else if (change?.oldPath !== undefined) {
      oldPath = change.oldPath;
    } else {
      oldPath = path;
    }
    current = oldPath ?? path;
    const isMerge = r.parents.length > 1;
    return {
      rev: r.hash,
      shortRev: r.hash.slice(0, 8),
      parents: r.parents,
      author: r.author,
      email: r.email,
      date: new Date(r.time * 1000),
      subject: r.subject,
      body: r.body,
      refs: r.refs,
      isMerge,
      isPullMerge: isMerge && PULL_MERGE.test(r.subject),
      path,
      oldPath,
      status: change?.status,
    };
  });
}
