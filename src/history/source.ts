// What the Stitch History view needs from a backend. Each level of the tree is a
// paged list of commits; merges can be expanded into another level. `Level` is
// opaque to the view: the backend's own context for a level (git: the exclusion
// list of the first-parent walk; svn: nothing).
import { Commit } from "../backend";
import { GitRepo, PageRequest } from "../git/gitBackend";
import { log } from "../log";
import { relativeTime } from "./format";

export type Level = unknown;
export type Next = unknown;

export interface SourcePage {
  commits: Commit[];
  /** Pass to more() for the next page of the same level; absent on the last page. */
  next?: Next;
}

export interface HistorySource {
  readonly vcs: "git" | "svn";
  /** Local root that `stitch:` URIs for this source are relative to. */
  readonly root: string;
  /** Distinguishes this history from others in tree ids (file + starting point). */
  readonly key: string;
  // Each takes an AbortSignal: the view aborts everything in flight when it switches files.
  top(limit: number, signal?: AbortSignal): Promise<TopPage>;
  more(next: Next, limit: number, signal?: AbortSignal): Promise<SourcePage>;
  /** The commits a merge brought in, as a new level. */
  expand(merge: Commit, level: Level, limit: number, signal?: AbortSignal): Promise<SourcePage & { level: Level }>;
  /** How many commits expand() would list in total (0: nothing to expand). */
  count(merge: Commit, level: Level, signal?: AbortSignal): Promise<number>;
  /** Fills Commit.files for commits that don't have it yet (sources that can't list them up front). */
  files?(commits: Commit[], signal?: AbortSignal): Promise<void>;
}

/**
 * Commits upstream has and you don't, shown above a separator row:
 * svn: server revisions newer than the working copy's BASE;
 * git: commits on the branch's upstream (as of the last fetch) not in the branch.
 */
export interface Incoming {
  commits: Commit[];
  /** More incoming commits exist than were listed. */
  truncated: boolean;
  /** Level context for the incoming commits (git: exclusions, so merges expand to what's new). */
  level?: Level;
  /** Separator row text, e.g. "your working copy: r1234". */
  label: string;
  /** Next to the separator label (freshness, or why nothing is listed). */
  description?: string;
  tooltip: string;
  /** Tooltip line on each incoming row. */
  rowTooltip: string;
  /** The list is empty for a reason worth showing (e.g. the file moved on the server). */
  note?: string;
}

/**
 * git: the row between the top-level commits the upstream doesn't have ("unpushed")
 * and the ones it has. Present when the branch has unpushed commits; the view places
 * it where the marks end, which can be on a later page.
 */
export interface PushedLine {
  /** Separator row text, e.g. "upstream: origin/main". */
  label: string;
  description?: string;
  tooltip: string;
}

export type TopPage = SourcePage & { level: Level; incoming?: Incoming; pushedLine?: PushedLine };


interface GitNext {
  req: PageRequest;
  exclude: string[];
}

/** What a git history depends on: the starting ref's commit and its upstream (name and commit). */
interface GitState {
  head: string;
  up?: { name: string; hash: string };
}

const stateKey = (s: GitState) => `${s.head} ${s.up?.name ?? ""} ${s.up?.hash ?? ""}`;

/** The commits of the ref that its upstream doesn't have, and the tooltip line for their rows. */
interface Unpushed {
  revs: Set<string>;
  note: string;
  upName: string;
}

/** The incoming part of a remembered page, minus the text that depends on the time of the last fetch. */
interface IncomingData {
  incoming: Incoming;
  upName: string;
  branch: string;
}

/**
 * Git history of one file from one starting ref. top() remembers its result for as
 * long as the ref and its upstream stay where they were (checked with rev-parse on
 * every top()), so switching back to a file runs no `git log`. The changed files
 * the view fills into the commits, and merge counts, are kept with it. invalidate()
 * (Refresh, settings, the Fetch button) forgets all of it.
 */
export class GitSource implements HistorySource {
  readonly vcs = "git";
  /** The last successful top(): the state it was loaded at, for which limit, and the result. */
  private last?: { state: string; limit: number; page: TopPage; incoming?: IncomingData; unpushed?: Unpushed };
  /** As of the latest top(): which commits get the "unpushed" mark, also on later pages and under merges. */
  private unpushed?: Unpushed;
  /** The state the last top() saw (also when it failed), for moved(). */
  private checkedState?: string;
  /** Merge counts by merge, path and exclusions (immutable: they only name commits). */
  private readonly counts = new Map<string, { p: Promise<number>; signal?: AbortSignal }>();

  constructor(
    readonly repo: GitRepo,
    readonly relPath: string,
    readonly ref: string
  ) {}

  get root(): string {
    return this.repo.root;
  }

  get key(): string {
    return `git:${this.ref}:${this.relPath}`;
  }

  /** Where the ref and its upstream are now (rev-parse only). */
  private async state(signal?: AbortSignal): Promise<GitState> {
    const [head, up] = await Promise.all([
      this.repo.resolve(this.ref, signal).catch(() => ""),
      this.repo.upstream(this.ref, signal).catch(() => undefined),
    ]);
    return { head, up };
  }

  /**
   * Whether the ref or its upstream moved since the last top() (a commit, pull,
   * checkout or fetch). If so, the remembered history is dropped. False before any top().
   */
  async moved(signal?: AbortSignal): Promise<boolean> {
    if (this.checkedState === undefined) return false;
    const now = stateKey(await this.state(signal));
    if (signal?.aborted || now === this.checkedState) return false;
    this.last = undefined;
    return true;
  }

  /** Forgets the remembered history and merge counts: the next top() queries git again. */
  invalidate(): void {
    this.last = undefined;
    this.unpushed = undefined;
    this.checkedState = undefined;
    this.counts.clear();
  }

  async top(limit: number, signal?: AbortSignal): Promise<TopPage> {
    const state = await this.state(signal);
    const key = stateKey(state);
    if (!signal?.aborted) this.checkedState = key;
    const last = this.last;
    if (last && last.state === key && last.limit === limit) {
      this.unpushed = last.unpushed;
      return this.serve(last, signal);
    }
    let incomingFailed = false;
    const [page, incoming, unpushed] = await Promise.all([
      // From the resolved commit, so the result matches the state it's remembered under.
      this.repo.page({ from: state.head || this.ref, path: this.relPath, limit }, [], signal),
      this.incoming(limit, state, signal).catch((e) => {
        incomingFailed = true;
        if (!signal?.aborted) log.warn(`incoming commits for ${this.relPath}: ${(e as Error).message}`);
        return undefined; // history without the incoming part is still useful
      }),
      this.findUnpushed(state, signal).catch((e) => {
        incomingFailed = true;
        if (!signal?.aborted) log.warn(`unpushed commits for ${this.relPath}: ${(e as Error).message}`);
        return undefined; // likewise without the marks
      }),
    ]);
    if (!signal?.aborted) this.unpushed = unpushed;
    mark(page.commits, unpushed);
    const result: TopPage = {
      commits: page.commits,
      next: page.next && { req: page.next, exclude: [] },
      level: [],
      incoming: incoming?.incoming,
      pushedLine: unpushed && pushedLine(unpushed.upName, await this.repo.lastFetch(signal)),
    };
    // A cancelled load isn't a result, and one without its incoming part or unpushed marks (a failure) is tried again next time.
    if (!signal?.aborted && !incomingFailed) this.last = { state: key, limit, page: result, incoming, unpushed };
    return result;
  }

  /** The remembered page, with the separators' fetch time as of now (one stat). */
  private async serve(last: NonNullable<GitSource["last"]>, signal?: AbortSignal): Promise<TopPage> {
    const { incoming: inc, unpushed } = last;
    if (!inc && !unpushed) return last.page;
    const fetched = await this.repo.lastFetch(signal);
    return {
      ...last.page,
      incoming: inc && { ...inc.incoming, ...fetchText(inc.upName, inc.branch, fetched) },
      pushedLine: unpushed && pushedLine(unpushed.upName, fetched),
    };
  }

  /**
   * Commits on the branch's upstream (e.g. origin/main) that changed the file and
   * aren't in the branch: a first-parent walk of the upstream, excluding the branch.
   * Read-only: uses the remote-tracking branch as of the last fetch (the Fetch button, in extension.ts, is separate).
   */
  private async incoming(limit: number, state: GitState, signal?: AbortSignal): Promise<IncomingData | undefined> {
    const { up, head } = state;
    if (!up || !head) return undefined;
    const page = await this.repo.page({ from: up.hash, path: this.relPath, limit }, [head], signal);
    if (page.commits.length === 0) return undefined;
    const [branch, fetched] = await Promise.all([this.repo.branchName(this.ref, signal), this.repo.lastFetch(signal)]);
    return {
      upName: up.name,
      branch,
      incoming: {
        commits: page.commits,
        truncated: page.next !== undefined,
        level: [head],
        label: `your branch: ${branch}`,
        ...fetchText(up.name, branch, fetched),
        rowTooltip: `On ${up.name}, not in ${branch} yet.`,
      },
    };
  }

  /**
   * The mirror of incoming(): the branch's commits that its upstream (as of the last
   * fetch) doesn't have. All of them, not only this file's, in one rev-list, so rows
   * on later pages and under merges can be marked too. Nothing to ask when there is
   * no upstream or the branch is at it.
   */
  private async findUnpushed(state: GitState, signal?: AbortSignal): Promise<Unpushed | undefined> {
    const { up, head } = state;
    if (!up || !head || up.hash === head) return undefined;
    const revs = await this.repo.notIn(head, up.hash, signal);
    return revs.size > 0 ? { revs, upName: up.name, note: `Not on ${up.name} yet (as of the last fetch); a push sends it.` } : undefined;
  }

  async more(next: Next, _limit?: number, signal?: AbortSignal): Promise<SourcePage> {
    const n = next as GitNext;
    const page = await this.repo.page(n.req, n.exclude, signal);
    mark(page.commits, this.unpushed);
    return { commits: page.commits, next: page.next && { req: page.next, exclude: n.exclude } };
  }

  async expand(merge: Commit, level: Level, limit: number, signal?: AbortSignal): Promise<SourcePage & { level: Level }> {
    const exclude = level as string[];
    const page = await this.repo.branchPage(merge, exclude, limit, signal);
    mark(page.commits, this.unpushed);
    const childLevel = GitRepo.childExclude(merge, exclude);
    return { commits: page.commits, next: page.next && { req: page.next, exclude: childLevel }, level: childLevel };
  }

  /**
   * `rev-list --count` once per merge row. A count still running for a view that was
   * left (its signal aborted, so it will fail) isn't reused; a finished one always is.
   */
  count(merge: Commit, level: Level, signal?: AbortSignal): Promise<number> {
    const exclude = level as string[];
    const key = `${merge.rev}\0${merge.path}\0${exclude.join(" ")}`;
    const hit = this.counts.get(key);
    if (hit && !hit.signal?.aborted) return hit.p;
    const p = this.repo.branchCount(merge, exclude, signal);
    const entry: { p: Promise<number>; signal?: AbortSignal } = { p, signal };
    this.counts.set(key, entry);
    p.then(
      () => {
        entry.signal = undefined; // done: the view that asked can go away now
      },
      () => {
        if (this.counts.get(key) === entry) this.counts.delete(key);
      }
    );
    return p;
  }

  async files(commits: Commit[], signal?: AbortSignal): Promise<void> {
    const byRev = await this.repo.changedFiles(
      commits.filter((c) => !c.files).map((c) => c.rev),
      signal
    );
    for (const c of commits) c.files ??= byRev.get(c.rev) ?? [];
  }
}

/** Marks the commits the upstream doesn't have. */
function mark(commits: Commit[], unpushed: Unpushed | undefined): void {
  if (!unpushed) return;
  for (const c of commits) if (unpushed.revs.has(c.rev)) c.unpushed = unpushed.note;
}

/** The row under the unpushed commits; like the incoming separator, it says how long ago the last fetch was. */
function pushedLine(upName: string, fetched: Date | undefined): PushedLine {
  return {
    label: `upstream: ${upName}`,
    description: fetched ? `fetched ${relativeTime(fetched)}` : "not fetched yet",
    tooltip:
      `The commits above aren't on ${upName} yet; a push sends them. The commits below are on it. ` +
      `${upName} is as of the last fetch (${fetched ? fetched.toLocaleString() : "never"}); the Fetch button updates it.`,
  };
}

/** The incoming separator's description and tooltip, which say how long ago the last fetch was. */
function fetchText(upName: string, branch: string, fetched: Date | undefined): Pick<Incoming, "description" | "tooltip"> {
  const when = fetched ? `fetched ${relativeTime(fetched)}` : "not fetched yet";
  return {
    description: `${upName}, ${when}`,
    tooltip:
      `The commits above are on ${upName} but not in ${branch}; a pull brings them in. ` +
      `${upName} is as of the last fetch (${fetched ? fetched.toLocaleString() : "never"}); the Fetch button updates it.`,
  };
}
