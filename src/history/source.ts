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

export type TopPage = SourcePage & { level: Level; incoming?: Incoming };


interface GitNext {
  req: PageRequest;
  exclude: string[];
}

export class GitSource implements HistorySource {
  readonly vcs = "git";

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

  async top(limit: number, signal?: AbortSignal): Promise<TopPage> {
    const [page, incoming] = await Promise.all([
      this.repo.page({ from: this.ref, path: this.relPath, limit }, [], signal),
      this.incoming(limit, signal).catch((e) => {
        log.warn(`incoming commits for ${this.relPath}: ${(e as Error).message}`);
        return undefined; // history without the incoming part is still useful
      }),
    ]);
    return { commits: page.commits, next: page.next && { req: page.next, exclude: [] }, level: [], incoming };
  }

  /**
   * Commits on the branch's upstream (e.g. origin/main) that changed the file and
   * aren't in the branch: a first-parent walk of the upstream, excluding the branch.
   * Read-only: uses the remote-tracking branch as of the last fetch; never fetches.
   */
  private async incoming(limit: number, signal?: AbortSignal): Promise<Incoming | undefined> {
    const up = await this.repo.upstream(this.ref, signal);
    if (!up) return undefined;
    const head = await this.repo.resolve(this.ref, signal);
    const page = await this.repo.page({ from: up.hash, path: this.relPath, limit }, [head], signal);
    if (page.commits.length === 0) return undefined;
    const [branch, fetched] = await Promise.all([this.repo.branchName(this.ref, signal), this.repo.lastFetch(signal)]);
    const when = fetched ? `fetched ${relativeTime(fetched)}` : "not fetched yet";
    return {
      commits: page.commits,
      truncated: page.next !== undefined,
      level: [head],
      label: `your branch: ${branch}`,
      description: `${up.name}, ${when}`,
      tooltip:
        `The commits above are on ${up.name} but not in ${branch}; a pull brings them in. ` +
        `${up.name} is as of the last fetch (${fetched ? fetched.toLocaleString() : "never"}); Stitch itself never fetches.`,
      rowTooltip: `On ${up.name}, not in ${branch} yet.`,
    };
  }

  async more(next: Next, _limit?: number, signal?: AbortSignal): Promise<SourcePage> {
    const n = next as GitNext;
    const page = await this.repo.page(n.req, n.exclude, signal);
    return { commits: page.commits, next: page.next && { req: page.next, exclude: n.exclude } };
  }

  async expand(merge: Commit, level: Level, limit: number, signal?: AbortSignal): Promise<SourcePage & { level: Level }> {
    const exclude = level as string[];
    const page = await this.repo.branchPage(merge, exclude, limit, signal);
    const childLevel = GitRepo.childExclude(merge, exclude);
    return { commits: page.commits, next: page.next && { req: page.next, exclude: childLevel }, level: childLevel };
  }

  count(merge: Commit, level: Level, signal?: AbortSignal): Promise<number> {
    return this.repo.branchCount(merge, level as string[], signal);
  }

  async files(commits: Commit[], signal?: AbortSignal): Promise<void> {
    const byRev = await this.repo.changedFiles(
      commits.filter((c) => !c.files).map((c) => c.rev),
      signal
    );
    for (const c of commits) c.files ??= byRev.get(c.rev) ?? [];
  }
}
