// Git history for one file, shown as a trunk with expandable merges.
//
// Every level of the tree is a first-parent walk:
//   - top level:   git log --first-parent --follow <ref> -- <path>
//   - merge M:     git log --first-parent --follow M^2 ^M^1 [^outer…] -- <pathAtM>
// With --first-parent, git compares a merge only with its first parent, so a
// level lists exactly the commits and merges that changed the file on that
// line. A merge's children are what it brought in, excluding anything already
// reachable from the line it was merged into (and from every enclosing line).
import { promises as fs } from "fs";
import * as path from "path";
import { ChangedFile, Commit } from "../backend";
import { git, GitOptions } from "./exec";
import { LOG_FORMAT, parseLog, toCommits } from "./parse";

export interface PageRequest {
  /** Revision to start from (a ref name or hash). */
  from: string;
  /** Path of the file at `from`, relative to the repo root. */
  path: string;
  limit: number;
}

export interface Page {
  commits: Commit[];
  /** Where the next page starts, or undefined if this was the last page. */
  next?: PageRequest;
}

export class GitRepo {
  private constructor(
    readonly root: string,
    private readonly opts: () => GitOptions
  ) {}

  /** Opens the repository containing `dir`. Rejects with GitError if there is none. */
  static async open(dir: string, opts: () => GitOptions): Promise<{ repo: GitRepo; prefix: string }> {
    const out = (await git(opts(), dir, ["rev-parse", "--show-toplevel", "--show-prefix"]))
      .toString("utf8")
      .split("\n");
    return { repo: new GitRepo(out[0], opts), prefix: out[1] ?? "" };
  }

  /** Repo-relative path of a file, given the prefix of its directory (from `open`). */
  static relPath(prefix: string, basename: string): string {
    return prefix + basename;
  }

  private run(args: string[], signal?: AbortSignal): Promise<Buffer> {
    return git(this.opts(), this.root, args, signal);
  }

  /** One page of a first-parent walk starting at `req.from`, excluding commits reachable from `exclude`. */
  async page(req: PageRequest, exclude: string[] = [], signal?: AbortSignal): Promise<Page> {
    const out = await this.run(
      [
        "log",
        "--first-parent",
        "--follow",
        "--name-status",
        "-z",
        `--format=${LOG_FORMAT}`,
        `-n${req.limit}`,
        req.from,
        ...exclude.map((e) => `^${e}`),
        "--",
        req.path,
      ],
      signal
    );
    const commits = toCommits(parseLog(out), req.path);
    const last = commits[commits.length - 1];
    let next: PageRequest | undefined;
    if (commits.length === req.limit && last.parents.length > 0 && last.oldPath !== undefined) {
      next = { from: last.parents[0], path: last.oldPath, limit: req.limit };
    }
    return { commits, next };
  }

  /** The exclusions for the children of `merge`, given the exclusions of the level it is on. */
  static childExclude(merge: Commit, exclude: string[]): string[] {
    return [...exclude, merge.parents[0]];
  }

  /** First page of what `merge` brought in. `exclude` is the exclusion list of the level `merge` is on. */
  branchPage(merge: Commit, exclude: string[], limit: number, signal?: AbortSignal): Promise<Page> {
    return this.page(
      { from: merge.parents[1], path: merge.path, limit },
      GitRepo.childExclude(merge, exclude),
      signal
    );
  }

  /** Number of first-parent commits on the merged branch that changed the file. */
  async branchCount(merge: Commit, exclude: string[], signal?: AbortSignal): Promise<number> {
    const out = await this.run(
      [
        "rev-list",
        "--count",
        "--first-parent",
        merge.parents[1],
        ...GitRepo.childExclude(merge, exclude).map((e) => `^${e}`),
        "--",
        merge.path,
      ],
      signal
    );
    return Number(out.toString("utf8").trim()) || 0;
  }

  /**
   * Every file each commit changed, against its first parent (a root commit: all
   * added). One git call for a whole page of commits.
   */
  async changedFiles(revs: string[], signal?: AbortSignal): Promise<Map<string, ChangedFile[]>> {
    const result = new Map<string, ChangedFile[]>();
    if (revs.length === 0) return result;
    const out = await this.run(
      ["log", "--no-walk=unsorted", "-m", "--first-parent", "-M", "--name-status", "-z", `--format=${LOG_FORMAT}`, ...revs, "--"],
      signal
    );
    for (const raw of parseLog(out)) {
      result.set(
        raw.hash,
        raw.changes.map((c) => ({ path: c.path, status: c.status.replace(/\d+$/, ""), ...(c.oldPath ? { oldPath: c.oldPath } : {}) }))
      );
    }
    return result;
  }

  /** File content at a revision (raw bytes, no filters). */
  show(rev: string, path: string, signal?: AbortSignal): Promise<Buffer> {
    return this.run(["show", `${rev}:${path}`], signal);
  }

  /** Resolves a ref to a full hash. */
  async resolve(ref: string, signal?: AbortSignal): Promise<string> {
    return (await this.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], signal))
      .toString("utf8")
      .trim();
  }

  /**
   * The remote-tracking branch `ref` follows (e.g. origin/main) and its hash, or
   * undefined: no upstream, a detached HEAD, a tag or remote ref, or an upstream
   * that was never fetched.
   */
  async upstream(ref: string, signal?: AbortSignal): Promise<{ name: string; hash: string } | undefined> {
    let name: string;
    try {
      name = (await this.run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${ref}@{upstream}`], signal))
        .toString("utf8")
        .trim();
    } catch {
      return undefined;
    }
    if (!name) return undefined;
    const hash = await this.resolve(name, signal).catch(() => "");
    return hash ? { name, hash } : undefined;
  }

  /**
   * The remote `ref`'s upstream lives on ("origin"), for the Fetch button, or
   * undefined: not a local branch (detached HEAD, tag, hash, remote ref), no
   * upstream, or an upstream that is another local branch.
   */
  async upstreamRemote(ref: string, signal?: AbortSignal): Promise<string | undefined> {
    const branch = await this.branchName(ref, signal).catch(() => "");
    if (!branch || branch === "HEAD") return undefined;
    const out = await this.run(["for-each-ref", "--format=%(upstream:remotename)", `refs/heads/${branch}`], signal);
    const remote = out.toString("utf8").trim();
    return remote && remote !== "." ? remote : undefined;
  }

  /** The repository's (common) .git folder, absolute: where a fetch writes. */
  async commonDir(signal?: AbortSignal): Promise<string> {
    const rel = (await this.run(["rev-parse", "--git-common-dir"], signal)).toString("utf8").trim();
    return path.resolve(this.root, rel);
  }

  /** "main" for HEAD on a branch; the ref itself otherwise. */
  async branchName(ref: string, signal?: AbortSignal): Promise<string> {
    if (ref !== "HEAD") return ref;
    return (await this.run(["rev-parse", "--abbrev-ref", "HEAD"], signal)).toString("utf8").trim();
  }

  /** Where FETCH_HEAD is, once found (it doesn't move for a repository). */
  private fetchHead?: Promise<string>;

  /**
   * When the repository was last fetched (FETCH_HEAD's mtime), if ever. Read-only:
   * one stat (plus one rev-parse the first time, to find the file).
   */
  async lastFetch(signal?: AbortSignal): Promise<Date | undefined> {
    try {
      if (!this.fetchHead) {
        // Not tied to `signal`: other callers share it, and it's one quick rev-parse.
        const p = this.run(["rev-parse", "--git-path", "FETCH_HEAD"]).then((out) => path.resolve(this.root, out.toString("utf8").trim()));
        p.catch(() => {
          if (this.fetchHead === p) this.fetchHead = undefined;
        });
        this.fetchHead = p;
      }
      const file = await this.fetchHead;
      if (signal?.aborted) return undefined;
      return (await fs.stat(file)).mtime;
    } catch {
      return undefined;
    }
  }

  /** Local branches, remote-tracking branches and tags, for the starting-branch picker. */
  async refs(signal?: AbortSignal): Promise<{ branches: string[]; remotes: string[]; tags: string[] }> {
    const list = async (flag: string) =>
      (await this.run(["rev-parse", "--symbolic", flag], signal))
        .toString("utf8")
        .split("\n")
        .filter((l) => l && !l.endsWith("/HEAD"));
    const [branches, remotes, tags] = await Promise.all([
      list("--branches"),
      list("--remotes"),
      list("--tags"),
    ]);
    return { branches, remotes, tags };
  }
}
