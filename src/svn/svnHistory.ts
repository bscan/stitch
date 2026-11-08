// SVN file history over HTTP, shaped like the git trunk view:
//   - top level: `svn log -v` of the file from its BASE revision, following copies;
//   - a revision that changed the file and set properties on it or a parent folder
//     may be a merge; it gets `svn log -g` for that one revision, lazily (count()
//     and expand()), and is expandable when that lists merged revisions.
// The file's path is tracked through copies and renames using the changed paths,
// so every row knows the path and revision of the file before it changed.
import * as path from "path";
import { ChangedFile, Commit } from "../backend";
import { HistorySource, Incoming, Level, Next, SourcePage, TopPage } from "../history/source";
import { ChangedPath, DavClient, DavError, LogItem, RepoInfo } from "./dav";

interface At {
  /** Absolute repository path ("/trunk/a.txt"). */
  path: string;
  rev: number;
}

interface Located {
  action: ChangedPath["action"];
  /** Where the file came from, when this revision copied it. */
  src?: At;
  renamed: boolean;
}

/** How old a youngest-revision answer may be for the incoming list (ms). */
export const RECENT_YOUNGEST_MS = 10_000;

const isUnder = (p: string, dir: string) => dir === "/" || p.startsWith(dir + "/");

/** How `item` changed the file at `p`, and where it came from. */
export function locate(item: LogItem, p: string): Located {
  const exact = item.paths.find((c) => c.path === p);
  if (exact) {
    if ((exact.action === "A" || exact.action === "R") && exact.copyFromPath && exact.copyFromRev !== undefined) {
      const from = exact.copyFromPath;
      return {
        action: exact.action,
        src: { path: from, rev: exact.copyFromRev },
        renamed: from !== p && item.paths.some((c) => c.action === "D" && c.path === from),
      };
    }
    return { action: exact.action, renamed: false };
  }
  // Copied or added along with a parent folder (e.g. branch creation).
  const parent = item.paths
    .filter((c) => (c.action === "A" || c.action === "R") && isUnder(p, c.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (parent) {
    if (parent.copyFromPath && parent.copyFromRev !== undefined) {
      return {
        action: "A",
        src: { path: parent.copyFromPath + p.slice(parent.path.length), rev: parent.copyFromRev },
        renamed: item.paths.some((c) => c.action === "D" && c.path === parent.copyFromPath),
      };
    }
    return { action: "A", renamed: false };
  }
  return { action: "M", renamed: false };
}

/** A revision that set properties on the file or a parent folder may have been a merge (svn:mergeinfo). */
export function mayBeMerge(item: LogItem, p: string): boolean {
  return item.paths.some((c) => c.propMods === true && (c.path === p || isUnder(p, c.path)));
}

const strip = (p: string) => p.replace(/^\/+/, "");

/**
 * Where a repository path shows up on disk, for diff tab paths. The working copy
 * root is checked out from some repository folder (e.g. "trunk/scripts/debug"),
 * found by taking the local file's path under the root off its repository path.
 * Paths inside that folder map into the working copy; others (a branch, or a
 * path outside the checkout) are shown as the repository path ("/branches/x/a.txt").
 */
export function svnDisplayPath(root: string, localFile: string, reposPath: string, sidePath: string): string {
  const rel = path.relative(root, localFile).split(path.sep).join("/");
  const file = strip(reposPath);
  const side = strip(sidePath);
  let base: string | undefined;
  if (file === rel) base = "";
  else if (file.endsWith("/" + rel)) base = file.slice(0, -rel.length - 1);
  if (base === undefined) return "/" + side;
  if (base === "") return path.join(root, side);
  if (side.startsWith(base + "/")) return path.join(root, side.slice(base.length + 1));
  return "/" + side;
}

/** At most this many of a revision's changed files are kept per row (a big merge or import lists thousands). */
export const MAX_FILES = 100;

/**
 * The files a revision changed (folders left out), sorted by path, and how many
 * there are. A copy whose source the same revision deleted is a move: listed once,
 * as R, without the deletion. Beyond `max`, only the first files are kept, and
 * `keep` (the history's own file, a repository path) always is.
 */
export function changedFiles(item: LogItem, keep?: string, max = Infinity): { files: ChangedFile[]; total: number } {
  const deleted = new Set(item.paths.filter((d) => d.action === "D").map((d) => d.path));
  const moved = new Set(item.paths.filter((c) => c.copyFromPath && deleted.has(c.copyFromPath)).map((c) => c.copyFromPath!));
  const files: ChangedFile[] = [];
  for (const c of item.paths) {
    if (c.kind === "dir") continue;
    if (c.action === "D" && moved.has(c.path)) continue;
    const copied = (c.action === "A" || c.action === "R") && c.copyFromPath && c.copyFromRev !== undefined;
    if (copied) {
      files.push({
        path: strip(c.path),
        status: moved.has(c.copyFromPath!) ? "R" : "C",
        oldPath: strip(c.copyFromPath!),
        fromRev: String(c.copyFromRev),
      });
    } else {
      // "R" in svn's log is "replaced": without history that's a new file.
      const status = c.action === "M" ? "M" : c.action === "D" ? "D" : "A";
      files.push({ path: strip(c.path), status, fromRev: String(item.rev - 1) });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const total = files.length;
  if (total <= max) return { files, total };
  const own = keep === undefined ? undefined : strip(keep);
  const kept = files.slice(0, max);
  const mine = files.find((f) => f.path === own);
  if (mine && !kept.includes(mine)) {
    kept[kept.length - 1] = mine; // still sorted: it comes after every other kept file
  }
  return { files: kept, total };
}

export function toCommit(item: LogItem, p: string): { commit: Commit; before?: At } {
  const loc = locate(item, p);
  const added = (loc.action === "A" || loc.action === "R") && !loc.src;
  const before: At | undefined = loc.src ?? (added ? undefined : { path: p, rev: item.rev - 1 });
  const message = (item.message ?? "").replace(/\r\n?/g, "\n");
  const nl = message.indexOf("\n");
  let status: string;
  if (loc.action === "D") status = "D";
  else if (added) status = "A";
  else if (loc.src && loc.src.path !== p) status = loc.renamed ? "R" : "C";
  else status = "M";
  const { files, total } = changedFiles(item, p, MAX_FILES);
  const commit: Commit = {
    rev: String(item.rev),
    shortRev: `r${item.rev}`,
    parents: before && before.rev > 0 ? [String(before.rev)] : [],
    author: item.author ?? "(no author)",
    email: "",
    date: item.date ?? new Date(0),
    subject: (nl < 0 ? message : message.slice(0, nl)).trim() || "(no message)",
    body: nl < 0 ? "" : message.slice(nl + 1).trim(),
    refs: [],
    isMerge: item.hasChildren || mayBeMerge(item, p),
    isPullMerge: false,
    path: strip(p),
    oldPath: before && before.rev > 0 ? strip(before.path) : undefined,
    status,
    files,
    ...(total > files.length ? { filesTotal: total } : {}),
  };
  return { commit, before: before && before.rev > 0 ? before : undefined };
}

/**
 * The file's path in a merged revision. The merged revisions are on the merge
 * source (a branch), so the file has another path there: prefer a changed file
 * with the same name and the longest common path suffix, then a folder copy
 * that contains the file (branch creation).
 */
export function pathInMerged(item: LogItem, target: string): string | undefined {
  const segs = target.split("/");
  const suffix = (p: string) => {
    const s = p.split("/");
    let n = 0;
    while (n < s.length && n < segs.length && s[s.length - 1 - n] === segs[segs.length - 1 - n]) n++;
    return n;
  };
  const files = item.paths
    .filter((c) => c.kind !== "dir" && path.posix.basename(c.path) === path.posix.basename(target))
    .sort((a, b) => suffix(b.path) - suffix(a.path));
  if (files[0]) return files[0].path;
  for (const c of item.paths) {
    if (c.copyFromPath && isUnder(target, c.copyFromPath)) return c.path + target.slice(c.copyFromPath.length);
  }
  return undefined;
}

export class SvnSource implements HistorySource {
  readonly vcs = "svn";
  /** Merged revisions per merge row, fetched once (log -g of one revision). */
  private readonly merged = new Map<string, Promise<{ items: LogItem[]; path: string }>>();

  constructor(
    private readonly client: DavClient,
    readonly info: RepoInfo,
    /** Working-copy root (for stitch: URIs). */
    readonly root: string,
    /** Repository path of the file at `peg`, without a leading slash. */
    readonly reposPath: string,
    readonly peg: number,
    /**
     * Minimum time between server fetches of this file's history (ms). Within it,
     * top() returns the last result (or failure) again; Refresh makes a new source.
     */
    private readonly minIntervalMs: () => number = () => 0
  ) {}

  /** The last top(): when, for which limit, and its result or failure. */
  private last?: { at: number; limit: number; page?: TopPage; error?: unknown };
  /** When needsReload() last asked the server. */
  private checkedAt = 0;

  get key(): string {
    return `svn:${this.peg}:${this.reposPath}`;
  }

  private async page(at: At, limit: number, signal?: AbortSignal, end = 0): Promise<SourcePage> {
    const items = await this.client.log(this.info, at.path, at.rev, { start: at.rev, end, limit }, signal);
    const commits: Commit[] = [];
    let cur: string | undefined = at.path;
    let next: At | undefined;
    for (const item of items) {
      if (cur === undefined) break;
      const { commit, before } = toCommit(item, cur);
      commits.push(commit);
      next = before;
      cur = before?.path;
    }
    return { commits, next: items.length >= limit && next ? next : undefined };
  }

  /** Youngest revision seen on the server by the last top(). */
  private youngestSeen?: number;

  /**
   * Revisions after BASE that changed the file, newest first: the server's history
   * of the same path, from its youngest revision down to BASE + 1.
   */
  private async incoming(limit: number, signal?: AbortSignal): Promise<Incoming | undefined> {
    // Right after the OPTIONS that opened the repository (or a reload check), its answer is current enough.
    const youngest = await this.client.youngest(this.info, signal, RECENT_YOUNGEST_MS);
    this.youngestSeen = youngest;
    if (youngest <= this.peg) return undefined;
    const base = {
      label: `your working copy: r${this.peg}`,
      tooltip: `Your working copy has this file at r${this.peg} (BASE). The revisions above are on the server but not in your working copy yet; svn update brings them in.`,
      rowTooltip: "On the server, not in your working copy yet.",
    };
    try {
      const page = await this.page({ path: "/" + this.reposPath, rev: youngest }, limit, signal, this.peg + 1);
      return { ...base, commits: page.commits, truncated: page.next !== undefined };
    } catch (e) {
      if (e instanceof DavError && e.kind === "notFound") {
        const name = path.posix.basename(this.reposPath);
        const note = `${name} isn't at this path in r${youngest} (moved or deleted on the server)`;
        return { ...base, commits: [], truncated: false, note, description: note, tooltip: note };
      }
      throw e;
    }
  }

  /** Whether the server got new revisions since the history was loaded (cheap: one OPTIONS). */
  async serverMoved(signal?: AbortSignal): Promise<boolean> {
    if (this.youngestSeen === undefined) return false;
    return (await this.client.youngest(this.info, signal)) !== this.youngestSeen;
  }

  async top(limit: number, signal?: AbortSignal): Promise<TopPage> {
    const last = this.last;
    if (last && last.limit === limit && Date.now() - last.at < this.minIntervalMs()) {
      if (last.error !== undefined) throw last.error;
      return last.page!;
    }
    try {
      const [page, incoming] = await Promise.all([
        this.page({ path: "/" + this.reposPath, rev: this.peg }, limit, signal),
        this.incoming(limit, signal),
      ]);
      const result: TopPage = { ...page, level: undefined, incoming };
      this.last = { at: Date.now(), limit, page: result };
      return result;
    } catch (e) {
      // A cancelled load (the user moved on) isn't a result; anything else is remembered, so
      // switching back to this file doesn't hit a failing server again right away.
      if (!(e instanceof DavError && e.kind === "cancelled")) this.last = { at: Date.now(), limit, error: e };
      throw e;
    }
  }

  /**
   * Whether the history should be reloaded because the server has new revisions.
   * Asks the server (one OPTIONS) at most once per interval, counting the last fetch.
   */
  async needsReload(signal?: AbortSignal): Promise<boolean> {
    if (this.youngestSeen === undefined) return false;
    if (Date.now() - Math.max(this.last?.at ?? 0, this.checkedAt) < this.minIntervalMs()) return false;
    this.checkedAt = Date.now();
    const moved = await this.serverMoved(signal).catch(() => false);
    if (moved) this.last = undefined;
    return moved;
  }

  more(next: Next, limit: number, signal?: AbortSignal): Promise<SourcePage> {
    return this.page(next as At, limit, signal);
  }

  /** Merged revisions of a row: fetched for top-level rows, already known for nested ones. */
  private children(merge: Commit, signal?: AbortSignal): Promise<{ items: LogItem[]; path: string }> {
    const key = `${merge.rev}:${merge.path}`;
    let p = this.merged.get(key);
    if (!p) {
      const p2 = "/" + merge.path;
      p = this.client
        .log(this.info, p2, Number(merge.rev), { start: Number(merge.rev), end: Number(merge.rev), limit: 1, includeMerged: true }, signal)
        .then((items) => ({ items: items[0]?.children ?? [], path: p2 }));
      p.catch(() => this.merged.delete(key));
      this.merged.set(key, p);
    }
    return p;
  }

  async count(merge: Commit, _level?: Level, signal?: AbortSignal): Promise<number> {
    return (await this.children(merge, signal)).items.length;
  }

  async expand(merge: Commit, _level?: Level, _limit?: number, signal?: AbortSignal): Promise<SourcePage & { level: Level }> {
    const { items, path: target } = await this.children(merge, signal);
    const commits = items.map((item) => {
      const p = pathInMerged(item, target) ?? target;
      const { commit } = toCommit(item, p);
      commit.isMerge = item.hasChildren; // the server says which merged revisions were merges themselves
      if (item.subtractive) commit.body = `(reverse merge)${commit.body ? "\n\n" + commit.body : ""}`;
      // Nested merges: their merged revisions came in the same response.
      if (item.hasChildren) {
        this.merged.set(`${commit.rev}:${commit.path}`, Promise.resolve({ items: item.children, path: p }));
      }
      return commit;
    });
    return { commits, level: undefined };
  }

  /** Bytes of the file at a revision. */
  get(rev: string, p: string, keywords = false): Promise<Buffer> {
    return this.client.get(this.info, Number(rev), p, { keywords });
  }
}
