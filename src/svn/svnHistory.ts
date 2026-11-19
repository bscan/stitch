// SVN file history over HTTP, shaped like the git trunk view:
//   - top level: `svn log -v` of the file from its BASE revision, following copies;
//   - a revision that changed the file and set properties on it or a parent folder
//     may be a merge; it gets `svn log -g` for that one revision, lazily (count()
//     and expand()), and is expandable when that lists merged revisions.
// The file's path is tracked through copies and renames using the changed paths,
// so every row knows the path and revision of the file before it changed.
import * as path from "path";
import { ChangedFile, Commit } from "../backend";
import { decodeText, LineSpan, mapRange } from "../history/patch";
import { Filters, matchesFilters } from "../history/scope";
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
export const RECENT_YOUNGEST_MS = 60_000;

const isUnder = (p: string, dir: string) => dir === "/" || p.startsWith(dir + "/");

/** How `item` changed the file at `p`, and where it came from. */
export function locate(item: LogItem, p: string): Located {
  const exact = item.paths.find((c) => c.path === p);
  if (exact && (exact.action === "A" || exact.action === "R") && exact.copyFromPath && exact.copyFromRev !== undefined) {
    const from = exact.copyFromPath;
    return {
      action: exact.action,
      src: { path: from, rev: exact.copyFromRev },
      renamed: from !== p && item.paths.some((c) => c.action === "D" && c.path === from),
    };
  }
  const parent = parentAdd(item.paths, p);
  const viaParent = (action: ChangedPath["action"]): Located =>
    parent?.copyFromPath && parent.copyFromRev !== undefined
      ? {
          action,
          src: { path: parent.copyFromPath + p.slice(parent.path.length), rev: parent.copyFromRev },
          renamed: item.paths.some((c) => c.action === "D" && c.path === parent.copyFromPath),
        }
      : { action, renamed: false };
  // Edited in the revision that copied a parent folder (folder move, branch creation):
  // svn lists it as M at its new path, but before it was at the copy source.
  // An exact A/R without copyfrom is a new file and D a deletion: no source.
  if (exact) return exact.action === "M" ? viaParent("M") : { action: exact.action, renamed: false };
  // Copied or added along with a parent folder (e.g. branch creation).
  if (parent) return viaParent("A");
  return { action: "M", renamed: false };
}

/** The nearest parent folder of `p` that `paths` added or replaced (with or without history). */
function parentAdd(paths: ChangedPath[], p: string): ChangedPath | undefined {
  return paths
    .filter((c) => (c.action === "A" || c.action === "R") && isUnder(p, c.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
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
  if (rel === "") base = file; // the history of the working copy's root folder
  else if (file === rel) base = "";
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
export function changedFiles(item: LogItem, keep?: string, max = Infinity, folder = false): { files: ChangedFile[]; total: number } {
  const deleted = new Set(item.paths.filter((d) => d.action === "D").map((d) => d.path));
  const moved = new Set(item.paths.filter((c) => c.copyFromPath && deleted.has(c.copyFromPath)).map((c) => c.copyFromPath!));
  const adds = item.paths.filter((c) => c.action === "A" || c.action === "R");
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
      continue;
    }
    // Edited where a parent folder was copied to in this revision: diff against the
    // copy source, and call it moved/copied like toCommit() does.
    const parent = c.action === "M" ? parentAdd(adds, c.path) : undefined;
    if (parent?.copyFromPath && parent.copyFromRev !== undefined) {
      files.push({
        path: strip(c.path),
        status: moved.has(parent.copyFromPath) ? "R" : "C",
        oldPath: strip(parent.copyFromPath + c.path.slice(parent.path.length)),
        fromRev: String(parent.copyFromRev),
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
  if (folder && own !== undefined) {
    // A folder's history: the files under the folder are kept first, then others up to `max`.
    const under = (f: ChangedFile) => own === "" || f.path.startsWith(own + "/");
    const inside = files.filter(under);
    const kept = [...inside.slice(0, max), ...files.filter((f) => !under(f)).slice(0, Math.max(0, max - inside.length))];
    return { files: kept.sort((a, b) => a.path.localeCompare(b.path)), total };
  }
  const kept = files.slice(0, max);
  const mine = files.find((f) => f.path === own);
  if (mine && !kept.includes(mine)) {
    kept[kept.length - 1] = mine; // still sorted: it comes after every other kept file
  }
  return { files: kept, total };
}

/** Revisions that changed the file's properties but not its text (no need to GET them in a line search). */
const propsOnly = new WeakSet<Commit>();

/** `folder`: `p` is a folder (a folder's history), whose own files are kept when a big revision is trimmed. */
export function toCommit(item: LogItem, p: string, folder = false): { commit: Commit; before?: At } {
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
  const { files, total } = changedFiles(item, p, MAX_FILES, folder);
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
  if (item.paths.find((c) => c.path === p)?.textMods === false) propsOnly.add(commit);
  return { commit, before: before && before.rev > 0 ? before : undefined };
}

/** What an SVN history shows besides one file's full log. */
export interface SvnQuery {
  /** A folder's history (also a working copy's: its root folder): rows list every file they changed. */
  folder?: boolean;
  /** Author and message are matched here, page by page; lines are followed revision by revision. */
  filters?: Filters;
}

/** Revisions per log request when searching by author or message. */
const SCAN_PAGE = 100;
/** How many revisions one search step (until "Search further") may look at: author or message… */
export const SCAN_CAP = 1000;
/** …and lines, where each revision costs a GET. A line search always finds the revision that added the lines, so this is only a safety limit… */
export const LINES_CAP = 1000;
/** A line search looks at least this many revisions per step (about 3 s at 14 ms a GET)… */
export const LINES_MIN = 200;
/** …and, past that, this many after its first match (related changes tend to be close together). */
export const LINES_AFTER_MATCH = 20;
/** Revisions a line search looks at per page (the view shows progress in between). */
const LINES_STEP = 5;

/** Paging state: the next log page, or a line search in progress (kept in the source, by id). */
interface SvnNext {
  at?: At;
  walk?: number;
}

/** A line search: the revisions not looked at yet, the file's text in the newest of them, and the lines. */
interface Walk {
  queue: Commit[];
  at?: At;
  text?: string;
  range: LineSpan;
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
    private readonly minIntervalMs: () => number = () => 0,
    readonly query: SvnQuery = {}
  ) {}

  /** Line searches in progress, by the id in SvnNext.walk. */
  private readonly walks = new Map<number, Walk>();
  private walkIds = 0;

  get scoped(): boolean {
    return !!this.query.folder;
  }

  private get filters(): Filters {
    return this.query.filters ?? {};
  }

  get searchCap(): number | undefined {
    const f = this.filters;
    return f.lines ? LINES_CAP : f.author || f.message ? SCAN_CAP : undefined;
  }

  get searchMin(): number | undefined {
    return this.filters.lines ? LINES_MIN : undefined;
  }

  get searchAfterMatch(): number | undefined {
    return this.filters.lines ? LINES_AFTER_MATCH : undefined;
  }

  /** The last top(): when, for which limit, and its result or failure. */
  private last?: { at: number; limit: number; page?: TopPage; error?: unknown };
  /** When needsReload() last asked the server. */
  private checkedAt = 0;

  get key(): string {
    const f = this.filters;
    const filtered = f.lines || f.author || f.message ? `:${JSON.stringify([f.lines?.range, f.author?.text, f.author?.exact, f.message])}` : "";
    return `svn:${this.peg}:${this.query.folder ? "dir:" : ""}${this.reposPath}${filtered}`;
  }

  private async page(at: At, limit: number, signal?: AbortSignal, end = 0): Promise<SourcePage> {
    const items = await this.client.log(this.info, at.path, at.rev, { start: at.rev, end, limit }, signal);
    const commits: Commit[] = [];
    let cur: string | undefined = at.path;
    let next: At | undefined;
    for (const item of items) {
      if (cur === undefined) break;
      const { commit, before } = toCommit(item, cur, this.query.folder);
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
    const what = this.query.folder ? "folder" : "file";
    const base = {
      label: `your working copy: r${this.peg}`,
      tooltip:
        `Your working copy has this ${what} at r${this.peg} (BASE). The revisions above are on the server but not in your working copy yet; svn update brings them in.` +
        (this.query.folder
          ? ` r${this.peg} is the folder's own revision: a working copy can be mixed-revision, so files in it may be at other revisions.`
          : ""),
      rowTooltip: "On the server, not in your working copy yet.",
    };
    try {
      const page = await this.page({ path: "/" + this.reposPath, rev: youngest }, limit, signal, this.peg + 1);
      const f = this.filters;
      const commits = f.author || f.message ? page.commits.filter((c) => matchesFilters(c, f)) : page.commits;
      return { ...base, commits, truncated: page.next !== undefined };
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
      const start: At = { path: "/" + this.reposPath, rev: this.peg };
      const [page, incoming] = await Promise.all([
        this.filters.lines ? this.startWalk(start, this.filters.lines.range, signal) : this.step({ at: start }, limit, signal),
        // Incoming revisions aren't filtered by lines (their line numbers differ from BASE's).
        this.filters.lines ? undefined : this.incoming(limit, signal),
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
    return this.step(next as SvnNext, limit, signal);
  }

  /** The next page: plain, or the next stretch of an author/message search or a line search. */
  private async step(next: SvnNext, limit: number, signal?: AbortSignal): Promise<SourcePage> {
    if (next.walk !== undefined) return this.walkStep(next.walk, signal);
    const at = next.at!;
    const f = this.filters;
    if (!f.author && !f.message) {
      const page = await this.page(at, limit, signal);
      return { commits: page.commits, next: page.next && { at: page.next } };
    }
    const page = await this.page(at, SCAN_PAGE, signal);
    const last = page.commits[page.commits.length - 1];
    return {
      commits: page.commits.filter((c) => matchesFilters(c, f)),
      next: page.next && { at: page.next },
      searched: { scanned: page.commits.length, through: last ? `r${last.rev}` : `r${at.rev}` },
    };
  }

  /** Starts a line search at BASE; nothing to search when no line of the range is committed. */
  private startWalk(at: At, range: LineSpan | undefined, signal?: AbortSignal): Promise<SourcePage> {
    if (!range) return Promise.resolve({ commits: [] });
    return this.walkStep(this.saveWalk({ queue: [], at, range }), signal);
  }

  /**
   * Looks at the next few revisions of a line search, newest first: each one's text
   * against its predecessor's (one GET each), keeping the revisions that changed the
   * lines and following the lines back. The search ends when every line was added.
   */
  private async walkStep(id: number, signal?: AbortSignal): Promise<SourcePage> {
    const saved = this.walks.get(id);
    if (!saved) throw new Error("This line search is no longer available; Refresh starts it again.");
    // A copy: the saved state stays valid for a page that is served again (the remembered top()).
    const w: Walk = { ...saved, queue: [...saved.queue] };
    const kept: Commit[] = [];
    // Author and message filters apply on top of the lines (all filters must match).
    const keep = (c: Commit) => {
      if (matchesFilters(c, this.filters)) kept.push(c);
    };
    let scanned = 0;
    let through = "";
    let done = false;
    const text = async (rev: string, p: string) => decodeText(await this.client.get(this.info, Number(rev), p, {}, signal));
    while (scanned < LINES_STEP) {
      if (w.queue.length === 0) {
        if (!w.at) {
          done = true;
          break;
        }
        const page = await this.page(w.at, 50, signal);
        w.queue = page.commits;
        w.at = page.next as At | undefined;
        if (w.queue.length === 0) {
          done = true;
          break;
        }
      }
      const c = w.queue[0];
      w.text ??= await text(c.rev, c.path);
      scanned++;
      through = `r${c.rev}`;
      if (w.text === undefined) {
        done = true; // binary: lines mean nothing
        break;
      }
      const before = c.parents[0];
      if (!before || c.oldPath === undefined || c.status === "D") {
        keep(c); // added here: every line of the range comes from this revision
        done = true;
        break;
      }
      const older = propsOnly.has(c) ? w.text : await text(before, c.oldPath);
      if (older === undefined) {
        keep(c); // was binary before
        done = true;
        break;
      }
      const m = mapRange(w.text, older, w.range);
      if (m.changed) keep(c);
      w.queue.shift();
      w.text = older;
      if (!m.range) {
        done = true;
        break;
      }
      w.range = m.range;
    }
    return { commits: kept, next: done ? undefined : { walk: this.saveWalk(w) }, searched: { scanned, through } };
  }

  private saveWalk(w: Walk): number {
    const id = ++this.walkIds;
    this.walks.set(id, w);
    // Each state holds a revision's text; only recent ones can still be asked for, and the
    // one the remembered first page continues with (top() may serve that page again).
    const pinned = (this.last?.page?.next as SvnNext | undefined)?.walk;
    for (const old of [...this.walks.keys()]) {
      if (this.walks.size <= 16) break;
      if (old !== pinned) this.walks.delete(old);
    }
    return id;
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
      const { commit } = toCommit(item, p, this.query.folder);
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
