# Feature ideas

These are features that were suggested but not chosen yet. When one is chosen, record it in the Decisions table in [CONTEXT.md](CONTEXT.md) and remove it from this file. Every idea here has to stay read-only (see the rules in `CLAUDE.md`). The sizes are rough guesses made before reading the code.

## Small

- **Update conflict preview.** Mark incoming rows whose changes overlap the user's local hunks, for example "will conflict on update". It compares BASE ↔ working against BASE ↔ HEAD, using the Myers diff that already exists in `history/patch.ts`. It answers the question users have just before `svn update`/`git pull`. Size: about 150 lines and one extra GET per file (SVN).
- **Diff with server HEAD / upstream.** An action on the "your working copy" / "your branch" separator row that shows what an update or pull would change in this file. Size: about 40 lines, 1 command.
- **Step through revisions.** "Older" and "newer" buttons in the title bar of a Stitch diff editor, so the user can walk the history without going back to the tree. Size: about 80 lines, 2 commands.
- **Unpushed marker (Git).** The mirror of "incoming": tag the rows on the user's branch that aren't in the upstream yet. The upstream hash is already known from `GitSource`'s state check. Size: about 50 lines and one `rev-list`.
- **Copy History.** Copy the loaded rows as `svn log` / `git log` text. It can reuse the Copy Diff formatter.
- **Status-bar item for SVN files.** Show the working-copy revision and the modified state, and possibly the number of incoming revisions.

## Medium

- **Compare two selected revisions.** Select two rows and diff them.
- **Issue links.** Turn `PROJ-123` in commit messages into links. SVN working copies often carry TortoiseSVN's `bugtraq:url` / `bugtraq:logregex` properties, which Stitch can read from `.svn/`. The catch is that an untrusted working copy would then choose where the links point, so this probably needs a machine-scoped setting instead of, or on top of, those properties.
- **Open in web viewer.** Open a revision in the server's web UI (ViewVC, GitLab, GitHub, …). It needs a URL template setting. Don't take the URL from the remote: remote URLs can carry credentials (see the stale-fetch decision in CONTEXT.md).
- **SVN property changes.** Show property differences between BASE and working (`svn:mergeinfo`, `svn:executable`, `svn:eol-style`). This would close the "property-only changes don't count as modifications" limitation.
- **Explorer badges.** Mark modified SVN files in the Explorer. Without file watchers (see Troubleshooting in the README), this can only cover files Stitch has already checked.
- **HTTP Basic auth.** Not needed for the current servers, which allow anonymous read. If it's added, credentials must never go to a URL that an untrusted working copy chose (see the residual risk under "Enabled in untrusted workspaces" in CONTEXT.md).

## Medium (left out of history scope and filters)

- **Text added or removed.** A filter for commits that added or removed a string: `git log -S` on git, and the same revision walk as the line filter on SVN (one GET per revision).
- **Filter inside merges and incoming.** In a filtered view, merge rows still expand to all their commits (svn), and incoming revisions aren't filtered by line range.
- **`.stitch.yaml` repository list.** Read the workspace's repositories from a file instead of scanning the workspace folders and their immediate children.

## Large

- **Workspace scope.** History of several repositories at once: one row per repository, or one list merged by date.

- **Blame / annotate.** For SVN this is large: it needs a `file-revs` REPORT, which `request()` doesn't allow today, plus client-side svndiff deltas. A cheaper option is **single-line blame** ("who last changed this line?"): walk back through the loaded revisions until the line changes. That costs one GET per step on SVN.
- **Native `svn://` reader.** A read-only client for anonymous `svn://` would remove the `stitch.svn.urlMap` setup step. It would be a second network module, so the "only `dav.ts` imports network modules" rule and its check in `test/readonly.test.ts` would have to be widened. Size: roughly 600–800 lines.
