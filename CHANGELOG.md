# Changelog

## Unreleased

- **Revert Change** for SVN gutter diffs: click a gutter marker, then the revert button in the peek, to put that change back to BASE. It edits the editor only and doesn't save, so the file on disk is unchanged until you save, and Undo brings the change back.

## 0.0.5

- New extension icon.

## 0.0.4

- The SVN **Open Changes** editor button now uses a different icon from the built-in Git one, so the two can be told apart when both appear (for example, when a stray `.git` folder sits in an SVN working copy).
- The Stitch History view no longer has a Collapse All button. Nothing in the view expands on its own, so it was rarely needed.
- New marketplace name, Stitch: SVN & Git File History, with a clearer description and search keywords.

## 0.0.3

- **Copy Diff** (right-click a history row, or a file under a commit): copies the commit's details and a unified diff of just that file, in `git log -p` style for Git and `svn log` + `svn diff` style for SVN.
- SVN `wc.db` is now read with VS Code's built-in SQLite, read-only and without locks, in a separate thread. Only the parts a lookup needs are read, instead of the whole database, which is much faster for large working copies on network drives. A stuck network share no longer freezes the extension.
- Damaged or incomplete working copies show a message in the Stitch History view suggesting `svn cleanup`, rather than a popup.
- `stitch.logLimit` now defaults to 40 entries per page (was 50).
- Requires VS Code 1.101 or newer.

## 0.0.2

- **Fetch** button (Git, cloud icon in the view title): fetches your branch's upstream so incoming commits are current. It doesn't prune, run hooks or prompt for credentials. It's offered only in trusted workspaces, and not for repositories on network paths.
- The view title notes a stale fetch (`main.c · fetched 3 d ago`, or `never fetched`). It never shows while autofetch is running.
- An empty `.git` folder no longer hides an SVN working copy.
- SVN diffs show the file's working-copy path.
- History rows no longer show the revision (it's in the tooltip).

## 0.0.1

- Stitch History view for any opened file, Git or SVN, with or without a workspace folder.
- Git: trunk view with expandable merges, rename tracking, paging, and incoming commits from the upstream branch.
- SVN: gutter diffs, Open Changes and keyword expansion for 1.4–1.14 working copies, read from `.svn/` with no svn binary.
- SVN history over http(s): renames, merges that expand like `svn log -g`, incoming revisions, and `svn://` URL mapping.
- Changed files per commit, author bubbles, a Stitch output channel, and support for Restricted Mode.
