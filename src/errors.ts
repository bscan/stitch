// User-facing text for backend errors (shown in the history view, diffs and
// notifications). No vscode import, so it stays testable.
import { GitError } from "./git/exec";
import { DavError } from "./svn/dav";
import { SvnError } from "./svn/svnBackend";

export function describeError(e: unknown): string {
  if (e instanceof GitError) {
    switch (e.kind) {
      case "notFound":
        return "git was not found. Install git or set “stitch.git.path”.";
      case "dubiousOwnership":
        return (
          "git refuses to read this repository because another user owns it. " +
          `To trust it, run: git config --global --add safe.directory ${e.path ?? "<path>"}`
        );
      case "timeout":
        return "git took too long to answer (see “stitch.timeoutMs”).";
      default:
        return `git: ${e.message}`;
    }
  }
  if (e instanceof DavError) {
    switch (e.kind) {
      case "unreachable":
        return `Server unreachable. ${e.message}`;
      case "timeout":
        return `The SVN server took too long to answer (see “stitch.timeoutMs”). ${e.message}`;
      default:
        return e.message;
    }
  }
  return e instanceof Error ? e.message : String(e);
}

/** The request was aborted because the user moved on: not worth showing or logging as a failure. */
export function isCancelled(e: unknown): boolean {
  return (e instanceof GitError || e instanceof DavError) && e.kind === "cancelled";
}

/** The content doesn't exist (as opposed to: couldn't be fetched). */
export function isNotFound(e: unknown): boolean {
  return (
    (e instanceof DavError && e.kind === "notFound") ||
    (e instanceof GitError && e.kind === "failed") ||
    // A damaged or unreadable working copy isn't "not found": its message says what's wrong.
    (e instanceof SvnError && e.kind !== "damaged" && e.kind !== "unavailable")
  );
}
