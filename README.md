# Stitch

Read-only file history for SVN and Git, for any file you open — with or without a folder, on a local disk or a network drive.

- **Stitch History** view in the Explorer sidebar, for the active editor's file.
  Each row has a bubble with the author's initial; the color is fixed per author (by name), in git and SVN alike. Merges are tagged "merge" and expand.
- **Changed files:** a commit that changed other files besides this one expands to all of them (this file marked); click one to diff it. Under a merge they're grouped as "Changed files (N)" above the merged commits. Commits that changed only this file don't expand.
- Git history is shown as a **trunk with expandable merges** (below).
- **SVN gutter diffs** and an **Open Changes** button (working file ↔ BASE) for SVN 1.4–1.6 and 1.7–1.14 working copies, read straight from `.svn/`, with no svn binary.
- **SVN history** read over http(s) straight from the server (1.7+, anonymous read), with merge revisions expandable to the revisions they merged. `svn://` working copies work through a URL mapping.

Stitch never writes: it has no commit, update, revert or similar commands, never changes a working copy or repository, and never changes git or svn configuration.

## Status

| Milestone | State |
|---|---|
| 1. Git history (trunk view, merges, renames, paging, diffs) | done |
| 2. SVN 1.7+ local reads, gutter, Open Changes | done |
| 3. SVN 1.6 local reads, keyword expansion | done |
| 4. SVN history over HTTP, `svn://` URL mapping | done |
| 5. Hardening (cancellation, logging, retries, packaging) | done |

## Git: trunk view

Each level of the tree is a first-parent walk of the file's history:

- **Top level** — the commits and merges that changed the file on the branch you're on (`git log --first-parent --follow`). A merge whose branch didn't touch the file is not shown.
- **Expanding a merge** shows the commits it brought in that changed the file (`M^2`, excluding everything already on the trunk). Merges inside a branch expand the same way.
- **Clicking a row** diffs it against its first parent. For a merge, that is the whole branch's change to the file as it landed on the trunk, conflict resolutions included.
- Renames are followed on the trunk and on branches.
- The toolbar's branch button picks the starting ref (default: `HEAD`).
- **Incoming commits** come first when your branch has an upstream (e.g. `origin/main`) with commits you haven't pulled that changed the file. They're tagged "incoming", and a separator row (`──── your branch: main ────`, with "origin/main, fetched 12 min ago" beside it) marks where your branch is. Stitch never fetches: this is as of the last fetch by VS Code's Git extension (`git.autofetch`), a pull, or a terminal. The view reloads when your branch or its upstream moves (checked on window focus and when you switch files).

Known limitations:

- **Pull merges** (`Merge branch 'main' of …`, from `git pull` without rebase) have their parents swapped: the first parent is the local work. They're labelled *pull merge*; the remote's trunk appears under them.
- Squash- or rebase-only repositories have no merges, so the view is a flat list.
- For git files, the gutter and *Open Changes* come from VS Code's built-in Git extension.

## SVN: gutter and Open Changes

For a file in an SVN working copy, Stitch compares the editor with BASE (the pristine copy svn keeps in `.svn/`), so it works offline and on network drives:

- **Gutter markers** like the built-in Git ones. Stitch registers an empty "SVN (Stitch)" provider per working copy in the Source Control view; it has no commit box and no actions.
- **Open Changes** (editor title bar, shown when the file differs from BASE) opens BASE ↔ working file.
- `svn:keywords` (`$Id$`, `$Rev$`, `$Date$`, …, including fixed-width and custom keywords) are expanded in BASE the way the svn client expands them, so keyword lines don't show up as changes.
- Added files compare against an empty file; copied files compare against their copy source.

Supported working copies: svn 1.4–1.6 (`.svn/entries` formats 8–10) and 1.7–1.14 (`.svn/wc.db`). Stitch never upgrades or otherwise touches them, so 1.6 clients can keep using theirs.

Known limitations:

- `$Date$` is expanded in your local time zone. If the client that last updated the file ran in a different zone, that line shows as changed.
- Property-only changes don't count as modifications.
- svn 1.15 working copies without pristine copies (`store-pristine = no`) and svn ≤ 1.3 working copies are not supported.

## SVN: history

The Stitch History view shows `svn log` for the file, following copies and renames:

- **Incoming** revisions come first: revisions on the server newer than your working copy's BASE that changed the file, tagged "incoming". A separator row (`──── your working copy: r1234 ────`) marks where your working copy is; everything below it is history you have. If the file was moved or deleted on the server since, the separator says so. Stitch checks the server again when the window regains focus (at most every 30 s) and on Refresh.
- Below the separator: the file's history from BASE down, like `svn log` on a working-copy file.
- **Server load:** Stitch has no timers and never polls. It asks the server about a file when you open it, and then at most once per `stitch.svn.refreshInterval` (default 60 s) however often you switch files or refocus the window; within that time the loaded history is reused. A server that failed isn't asked again until the interval passes. Merge checks (`svn log -g`, the expensive query) run once per file per session. **Refresh** always asks.

History It's read over http(s) with the server's WebDAV protocol, so no svn binary is needed; servers must be svn 1.7 or newer and allow anonymous read.

- **Clicking a row** diffs the file against its previous revision (across a rename or copy, against the source).
- **Merges:** a revision that changed the file and set properties on it or a parent folder (where `svn:mergeinfo` lives) is checked with `svn log -g` for that one revision. If it merged revisions that changed the file, it's shown with a merge icon and "(N revisions)", and expands to them, like `svn log -g`. Nested merges expand too.
- **Diff with Working File** and **Open This Revision** show keywords expanded (the server does it, svn 1.8+), so they line up with the working file.
- **`svn://` and `svn+ssh://` working copies** need a mapping to the server's http(s) URL, in `stitch.svn.urlMap`:

  ```json
  "stitch.svn.urlMap": { "svn://svn": "http://svn/repos" }
  ```

  This maps `svn://svn/project` to `http://svn/repos/project`. Prefixes match on whole path segments, longest first. Stitch checks that the mapped URL is the same repository (by UUID) and says so if it isn't.

Known limitations:

- Incoming revisions are found by the file's current path; if it moved on the server, they're not listed (the separator says the path is gone).
- Servers that need a login, `file://` repositories, and servers older than 1.7 aren't supported; the view says which applies.
- Inside an expanded merge, the file's path on the branch is inferred from the revision's changed paths (same file name, longest matching path suffix).

## Commands

All are read-only: Open Changes, Refresh, Choose Starting Branch, Load More, Diff with Previous, Diff with Working File, Open This Revision, Copy Revision.

## Settings

| Setting | Default | |
|---|---|---|
| `stitch.svn.urlMap` | `{}` | `svn://` → http(s) URL prefixes, for SVN history |
| `stitch.svn.refreshInterval` | `60` | minimum seconds between automatic SVN server queries for the same file |
| `stitch.git.path` | `git` | git executable |
| `stitch.logLimit` | `50` | entries per page |
| `stitch.timeoutMs` | `15000` | timeout per git/server request |

## Untrusted workspaces

Stitch stays enabled in Restricted Mode (folders you haven't trusted), because opening a repository with it can't run code from that repository:

- git runs with repository-configured programs switched off (fsmonitor, textconv, external diff, signature checks), only read subcommands, and no pager.
- svn needs no program at all; `.svn/` is parsed in-process (sql.js runs SQLite as sandboxed WebAssembly).
- `stitch.git.path` and `stitch.svn.urlMap` are machine-scoped, so a folder's `.vscode/settings.json` can't change which git runs or where requests go.
- Commit messages and paths are shown as plain, escaped text; tooltips are never trusted markdown.

One thing an untrusted folder *can* influence: an SVN working copy records its server URL, so opening a file in a crafted working copy makes Stitch send read-only, anonymous `OPTIONS`/`GET`/`REPORT` requests to that URL (no credentials are ever sent).

## Install

Build a package and install it (on this or another machine):

```sh
npm install
npm run package          # → dist/stitch-0.0.1.vsix
code --install-extension dist/stitch-0.0.1.vsix
```

Or, in VS Code: Extensions view → `…` → *Install from VSIX…*.

## Troubleshooting

- **See what Stitch is doing:** Output panel → *Stitch*. Every git command and SVN request is logged with its result and timing; failures are logged as warnings.
- **"Server unreachable" or a timeout:** check the URL in the log. Stitch tries again when the window regains focus, or press Refresh in the view. Slow servers or shares: raise `stitch.timeoutMs`.
- **"Add a URL mapping for svn://…":** the working copy was checked out with `svn://`; see `stitch.svn.urlMap` above. "Points at a different repository" means the mapped URL serves another repository (UUID mismatch).
- **"The server needs a login":** only anonymous read is supported.
- **git "refuses to read this repository because another user owns it"** (common on network shares): run the `git config --global --add safe.directory …` command shown. Stitch shows it but never runs it.
- **Gutter or history stale after an `svn update`, commit or `git pull` in a terminal:** Stitch doesn't use file watchers (they're unreliable on network drives). It re-checks when the window regains focus, on save, when you switch files, and on Refresh.

## Development

```sh
npm install
npm test        # unit + fixture tests (needs git and tar; the SVN server tests use podman and skip without it)
test/fixtures/make-svn-fixtures.sh   # rebuild the SVN fixtures (needs podman)
npm run build   # bundle to dist/
npm run package # .vsix in dist/
```

Press F5 in VS Code to run the extension in a development host.

### Read-only safeguards

- All git calls go through `src/git/exec.ts`: a subcommand allowlist (`rev-parse`, `rev-list`, `log`, `show`, `cat-file`), banned arguments (`--output`, `--ext-diff`, `--textconv`), and config overrides so repository-configured programs (fsmonitor, textconv, external diff, signature checks) never run.
- All SVN network calls go through `request()` in `src/svn/dav.ts`, which allows only `OPTIONS`, `GET` and `log-report` `REPORT`s and refuses anything else before connecting.
- `.svn/` is only read. `wc.db` is read into memory and opened by sql.js from that copy, never from the file, and never written back.
- Revision content is served by a read-only `stitch:` file system from memory; no temp files.
- Tests check that `.git/` and `.svn/` are byte-for-byte unchanged after use, that no SQLite database is ever exported, that only `dav.ts` imports network modules and refuses write methods without opening a connection, that no source file calls an fs write API or starts processes outside `exec.ts`, and that only the read commands are contributed.
