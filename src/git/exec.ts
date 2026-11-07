// The single place where Stitch runs git. Everything here exists to keep git
// read-only: a subcommand allowlist, banned arguments, and config overrides
// that stop repository-configured programs (fsmonitor, textconv, external
// diff, signature verification) from running.
//
// The one exception is gitFetch() below: the explicit Fetch button. It runs a
// fixed `git fetch <remote>`, which only adds objects and moves remote-tracking
// refs (and FETCH_HEAD), never the working tree, index, local branches or HEAD.
import { execFile, ExecFileException } from "child_process";
import { bytes, elapsed, log } from "../log";

export const ALLOWED_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "rev-parse",
  "rev-list",
  "log",
  "show",
  "cat-file",
  "for-each-ref",
]);

// Arguments that would make an allowed subcommand write a file or run a
// repository-configured program. (Global options such as -c or --git-dir only
// work before the subcommand, and that part of argv is fixed below.)
const BANNED_ARG = /^(--output(=|$)|--textconv$|--ext-diff$|--show-signature$)/;

// Passed before the subcommand on every call.
const GLOBAL_ARGS = [
  "--no-pager",
  "-c", "core.fsmonitor=false",
  "-c", "core.quotepath=false",
  "-c", "diff.external=",
  "-c", "log.showSignature=false",
  "-c", "color.ui=false",
];

// Appended to subcommands that can produce diffs or blob content.
const DIFF_SAFETY_ARGS = ["--no-textconv", "--no-ext-diff"];

export type GitErrorKind =
  | "notAllowed"
  | "notFound"
  | "notARepo"
  | "dubiousOwnership"
  | "timeout"
  | "cancelled"
  | "auth"
  | "failed";

export class GitError extends Error {
  constructor(
    message: string,
    readonly kind: GitErrorKind,
    readonly stderr = "",
    /** For dubiousOwnership: the directory git asks to trust. */
    readonly path?: string
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface GitOptions {
  gitPath: string;
  timeoutMs: number;
}

/** Validates a git argument list against the read-only policy. Throws GitError("notAllowed"). */
export function checkArgs(args: readonly string[]): void {
  const sub = args[0];
  if (!sub || !ALLOWED_SUBCOMMANDS.has(sub)) {
    throw new GitError(`git subcommand not allowed: ${sub ?? "(none)"}`, "notAllowed");
  }
  for (const a of args) {
    if (a === "--") break; // everything after is a path
    if (BANNED_ARG.test(a)) {
      throw new GitError(`git argument not allowed: ${a}`, "notAllowed");
    }
  }
}

export function buildArgv(args: readonly string[]): string[] {
  const [sub, ...rest] = args;
  const extra = sub === "log" || sub === "show" ? DIFF_SAFETY_ARGS : [];
  // Keep extra options before any "--" path separator.
  const sep = rest.indexOf("--");
  const before = sep === -1 ? rest : rest.slice(0, sep);
  const after = sep === -1 ? [] : rest.slice(sep);
  return [...GLOBAL_ARGS, sub, ...extra, ...before, ...after];
}

export const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_OPTIONAL_LOCKS: "0", // never refresh the index opportunistically
  GIT_TERMINAL_PROMPT: "0", // never prompt for credentials
  GIT_LITERAL_PATHSPECS: "1", // paths are paths, not globs
  GIT_PAGER: "cat",
  LC_ALL: "C", // stable error messages for classification
};

export function git(
  opts: GitOptions,
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal
): Promise<Buffer> {
  try {
    checkArgs(args);
  } catch (e) {
    return Promise.reject(e);
  }
  const argv = buildArgv(args);
  const shown = `git ${args.map((a) => (a.startsWith("--format=") ? "--format=…" : a)).join(" ")}`;
  const start = Date.now();
  return new Promise((resolve, reject) => {
    execFile(
      opts.gitPath,
      argv,
      {
        cwd,
        env: { ...process.env, ...GIT_ENV },
        encoding: "buffer",
        maxBuffer: 256 * 1024 * 1024,
        timeout: opts.timeoutMs,
        windowsHide: true,
        signal,
      },
      (err, stdout, stderr) => {
        if (!err) {
          log.info(`${shown} → ${bytes(stdout.length)} in ${elapsed(start)} (${cwd})`);
          resolve(stdout);
          return;
        }
        const e = classify(err, stderr.toString("utf8"));
        if (e.kind === "cancelled") log.debug(`${shown} → cancelled after ${elapsed(start)}`);
        else log.warn(`${shown} → ${e.kind}: ${e.message} after ${elapsed(start)} (${cwd})`);
        reject(e);
      }
    );
  });
}

// Config for the fetch: no hooks (fetch can run reference-transaction), no gc or
// maintenance afterwards, no commit-graph write, and no ext:: transport even if a
// repository's config allows it. Passed with -c, so they beat repo and user config.
const FETCH_CONFIG = [
  "-c", "core.hooksPath=" + (process.platform === "win32" ? "NUL" : "/dev/null"),
  "-c", "gc.auto=0",
  "-c", "maintenance.auto=false",
  "-c", "fetch.writeCommitGraph=false",
  "-c", "protocol.ext.allow=never",
];
// No pruning (it deletes remote-tracking refs and tags), no submodules.
const FETCH_ARGS = ["fetch", "--no-prune", "--no-prune-tags", "--no-recurse-submodules"];
/** Fetches can be slow; never cut one off sooner than this. */
const FETCH_MIN_TIMEOUT_MS = 120_000;

/** The full argv for fetching `remote`. Throws GitError("notAllowed") for a remote name that isn't one. */
export function buildFetchArgv(remote: string): string[] {
  if (!remote || remote === "." || remote.startsWith("-") || /[\0\n]/.test(remote)) {
    throw new GitError(`not a remote name: ${JSON.stringify(remote)}`, "notAllowed");
  }
  return [...GLOBAL_ARGS, ...FETCH_CONFIG, ...FETCH_ARGS, "--", remote];
}

/**
 * The only git command Stitch runs that writes: `git fetch <remote>`, run only
 * when the user clicks Fetch. Credentials prompts are off (GIT_TERMINAL_PROMPT=0),
 * so a remote that needs a login fails with kind "auth" instead of waiting.
 */
export function gitFetch(opts: GitOptions, cwd: string, remote: string, signal?: AbortSignal): Promise<void> {
  let argv: string[];
  try {
    argv = buildFetchArgv(remote);
  } catch (e) {
    return Promise.reject(e);
  }
  const shown = `git fetch ${remote}`;
  const start = Date.now();
  return new Promise((resolve, reject) => {
    execFile(
      opts.gitPath,
      argv,
      {
        cwd,
        env: { ...process.env, ...GIT_ENV },
        encoding: "buffer",
        maxBuffer: 16 * 1024 * 1024,
        timeout: Math.max(opts.timeoutMs, FETCH_MIN_TIMEOUT_MS),
        windowsHide: true,
        signal,
      },
      (err, _stdout, stderr) => {
        if (!err) {
          log.info(`${shown} → done in ${elapsed(start)} (${cwd})`);
          resolve();
          return;
        }
        const e = classify(err, stderr.toString("utf8"));
        log.warn(`${shown} → ${e.kind}: ${e.message} after ${elapsed(start)} (${cwd})\n${stderr.toString("utf8").trim()}`);
        reject(e);
      }
    );
  });
}

function classify(err: ExecFileException, stderr: string): GitError {
  if (err.code === "ENOENT") {
    return new GitError("git executable not found", "notFound", stderr);
  }
  if (err.name === "AbortError" || err.code === "ABORT_ERR") {
    return new GitError("git command cancelled", "cancelled", stderr);
  }
  if (err.killed) {
    return new GitError("git command timed out", "timeout", stderr);
  }
  if (/dubious ownership/i.test(stderr)) {
    const m = /safe\.directory\s+'?([^'\n]+?)'?\s*$/m.exec(stderr);
    return new GitError("repository is owned by another user", "dubiousOwnership", stderr, m?.[1]);
  }
  if (
    /could not read (username|password)|authentication failed|permission denied \(|host key verification failed|terminal prompts disabled/i.test(
      stderr
    )
  ) {
    return new GitError("the remote needs credentials", "auth", stderr);
  }
  if (/not a git repository/i.test(stderr)) {
    return new GitError("not a git repository", "notARepo", stderr);
  }
  const first = stderr.split("\n").find((l) => l.trim()) ?? err.message;
  return new GitError(first.replace(/^fatal:\s*/, ""), "failed", stderr);
}
