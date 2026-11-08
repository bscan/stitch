# Stitch

**Read-only file history for SVN and Git, for any file you open.** It works with or without a workspace folder, on a local disk or a network drive. SVN needs no `svn` binary.

- **Stitch History** in the Explorer sidebar: the history of the file in the active editor, with merges you can expand.
- **SVN gutter diffs and Open Changes**: compare the editor with BASE, read straight from `.svn/`, so it works offline.
- **Incoming changes**: commits on the server (SVN) or upstream branch (Git) that you don't have yet, shown above a "your working copy" / "your branch" line.
- **Never writes.** There are no commit, update, revert or cleanup commands. Stitch never changes a working copy, a repository, or git/svn configuration, and it never upgrades old SVN working copies. The one exception is the optional Git **Fetch** button ([below](#fetch-git)).

## Requirements

- VS Code 1.101 or newer.
- **Git:** a `git` executable (the one VS Code's Git uses is fine).
- **SVN:** working copies made by svn 1.4–1.14. Nothing needs to be installed. History needs an http(s) server running svn 1.7 or newer that allows anonymous read. `svn://` working copies work through a [URL mapping](#svn-and-svnssh-working-copies).

## Stitch History

Open any file under Git or SVN and the **Stitch History** view in the Explorer shows its history, following renames and copies.

- Each row shows the subject, author, date and branch/tag labels. Each author gets an initial in a colored bubble, and the color stays the same for that name in Git and SVN alike. The tooltip has the full message.
- **Click a row** to diff the file against the previous revision.
- **Merges** are tagged "merge" with a count ("(3 commits)"), and expand to the commits they brought in that changed the file. Merges nested inside a branch expand the same way.
- **Changed files:** a commit that also changed other files expands to all of them, with this file marked. Click one to diff it. Under a merge they're grouped as "Changed files (N)" above the merged commits.
- **Load More** at the bottom loads the next page (`stitch.logLimit` entries).
- **Right-click a row** for:
  - **Diff with Previous**
  - **Diff with Working File**
  - **Open This Revision**
  - **Copy Revision**
  - **Copy Diff**: the commit's revision, author, date and message, then a unified diff of just this file. Git output looks like `git log -p` and SVN output like `svn log` + `svn diff`. Also available on files listed under a commit.

### Git: the trunk view

Git history is shown as a trunk with merges you can expand, rather than one long list of every commit:

- **Top level:** the commits and merges that changed the file on your branch (its first-parent history). A merge whose branch didn't touch the file isn't shown.
- **Expanding a merge** shows the commits it brought in that changed the file.
- **Clicking a merge** diffs it against its first parent: the whole branch's change to the file as it landed, conflict resolutions included.
- **Choose Starting Branch** (branch icon in the view title) shows history from another ref, such as `origin/main`. The default is `HEAD`.

### Incoming changes

**SVN:** revisions on the server, newer than your working copy, that changed the file come first, tagged "incoming". A separator (`──── your working copy: r1234 ────`) marks where your working copy is. If the file was moved or deleted on the server since, the separator says so.

**Git:** when your branch has an upstream (such as `origin/main`) with commits you haven't pulled that changed the file, they come first, tagged "incoming". The separator reads `──── your branch: main ────`, with "origin/main, fetched 12 min ago" beside it. This reflects the last fetch, whether it came from Stitch's Fetch button, VS Code's autofetch, a pull or a terminal. When the last fetch is more than an hour old (or more than two autofetch periods, if those are longer), the view title says so: `main.c · fetched 3 d ago`.

The view reloads when the server, your branch or its upstream moves. Stitch checks when the window regains focus and when you switch files.

### Fetch (Git)

The cloud icon in the view title runs `git fetch` for your branch's upstream remote, so the incoming commits are up to date. This is Stitch's only write, and it is limited:

- It only updates remote-tracking branches (`origin/…`) and adds objects. It never touches your working tree, index, local branches or HEAD.
- It doesn't prune, recurse into submodules, run hooks or start gc/maintenance, and it never prompts for credentials.
- It runs only when you click it, never on a timer.
- It's offered only in trusted workspaces, and not for repositories on network paths (see `stitch.git.fetchExcludePaths` and `stitch.git.fetchLocalDrives`).

## SVN gutter diffs and Open Changes

For a file in an SVN working copy, Stitch compares the editor with BASE (the copy of the file as you last updated it, which svn keeps in `.svn/`). No server is needed.

- **Gutter markers**, like the built-in Git ones.
- **Open Changes** (in the editor title bar when the file differs from BASE) opens a BASE ↔ working file diff.
- **Keywords** set in `svn:keywords` (`$Id$`, `$Rev$`, `$Date$` and the rest, including fixed-width and custom keywords) are expanded in BASE the way the svn client does it, so keyword lines don't show up as changes.
- Added files compare against an empty file, and copied files against their copy source.
- Non-UTF-8 files (common in old repositories) are decoded the same way on both sides, so they don't show as completely changed.

Stitch adds an empty "SVN (Stitch)" entry per working copy to the Source Control view. That's how VS Code draws gutter markers. The entry has no commit box and no actions.

For Git files, the gutter and Open Changes come from VS Code's built-in Git extension.

## SVN history

History is read over http(s) from the server, using the same protocol the svn client uses:

- **Merges** expand to the revisions they merged, as in `svn log -g`.
- **Diff with Working File** and **Open This Revision** show keywords expanded (on svn 1.8+ servers), so they line up with your working file.
- **Light on the server.** Stitch never polls and has no timers. It asks the server about a file when you open it, and then at most once per `stitch.svn.refreshInterval` (default 60 s) however often you switch files or refocus the window. A server that failed isn't asked again until that interval has passed. Merge lookups run once per file per session. **Refresh** always asks the server.

### `svn://` and `svn+ssh://` working copies

History is only read over http(s), so map the `svn://` URL to the server's http(s) URL in your user settings:

```json
"stitch.svn.urlMap": { "svn://svn": "http://svn/repos" }
```

This maps `svn://svn/project` to `http://svn/repos/project`. Prefixes match on whole path segments, longest first. Stitch checks that the mapped URL serves the same repository (by UUID). Gutter diffs and Open Changes work without a mapping.

## Settings

| Setting | Default | Description |
|---|---|---|
| `stitch.logLimit` | `40` | History entries per page |
| `stitch.timeoutMs` | `15000` | Timeout per git command or server request, in ms |
| `stitch.svn.urlMap` | `{}` | `svn://` → http(s) URL prefixes, for SVN history |
| `stitch.svn.refreshInterval` | `60` | Minimum seconds between automatic server queries for the same file |
| `stitch.git.path` | `git` | The git executable |
| `stitch.git.fetchExcludePaths` | `["/drives/", "/mnt/", "/smb"]` | No Fetch button for repositories under these folders. On Linux, network mounts (`cifs`, `nfs`, `sshfs`, …) are excluded too |
| `stitch.git.fetchLocalDrives` | `["C:", "D:"]` | Windows: Fetch is offered only on these drives, never on UNC paths |

## Safety

**Read-only by construction, not just by omission:**

- Git runs only read subcommands, with repository-configured programs (fsmonitor, textconv, external diff, signature checks) switched off.
- SVN requests to the server are limited to read methods. Anything else is refused before a connection is opened.
- `.svn/` is only read. `wc.db` is opened read-only without locks, so svn clients and other tools aren't blocked, which matters on network drives.
- Revision content is served from memory. No temporary files are written.
- The test suite checks all of this, including that `.git/` and `.svn/` are byte-for-byte unchanged afterwards.

**Restricted Mode (untrusted folders).** Stitch stays enabled, because opening a repository with it can't run code from that repository:

- Git's repository-configured programs are switched off, as above. The Fetch button is hidden, since a fetch uses the repository's configured transport (`core.sshCommand`, credential helpers), which could run a program.
- SVN needs no program at all.
- `stitch.git.path` and `stitch.svn.urlMap` are machine-scoped, so a folder's `.vscode/settings.json` can't change which git runs or where requests go.
- Commit messages and paths are shown as plain text.

One thing an untrusted folder *can* influence: an SVN working copy records its server URL, so opening a file in a crafted working copy makes Stitch send read-only, anonymous requests to that URL. No credentials are ever sent.

## Known limitations

**Git**
- Merges made by `git pull` without rebase (`Merge branch 'main' of …`) have their parents swapped, so the first parent is your local work. They're labelled *pull merge*, and the remote's trunk appears under them.
- Repositories that only squash or rebase have no merges, so the view is a flat list.

**SVN**
- Servers that need a login, `file://` repositories, and servers older than 1.7 aren't supported for history. The view says which applies.
- Incoming revisions are found by the file's current path. If the file moved on the server, they aren't listed (the separator says the path is gone).
- `$Date$` is expanded in your local time zone. If the client that last updated the file ran in a different zone, that line shows as changed.
- Property-only changes don't count as modifications.
- svn 1.15 working copies without pristine copies (`store-pristine = no`) and svn ≤ 1.3 working copies aren't supported.

## Troubleshooting

- **See what Stitch is doing:** Output panel → *Stitch*. Every git command and server request is logged with its result and timing.
- **"Server unreachable" or a timeout:** check the URL in the log. Stitch tries again when the window regains focus, or press Refresh. For slow servers or shares, raise `stitch.timeoutMs`.
- **"Add a URL mapping for svn://…":** the working copy was checked out with `svn://`; see [above](#svn-and-svnssh-working-copies). "Points at a different repository" means the mapped URL serves another repository.
- **"The server needs a login":** only anonymous read is supported.
- **"The working copy may be damaged" or "looks incomplete":** run `svn cleanup` in it (or check out again). Stitch shows the suggestion but never runs it.
- **git "refuses to read this repository because another user owns it"** (common on network shares): run the `git config --global --add safe.directory …` command shown. Stitch never runs it for you.
- **Gutter or history out of date after an `svn update`, commit or `git pull` in a terminal:** Stitch doesn't use file watchers, which are unreliable on network drives. It checks again when the window regains focus, when you save, when you switch files, and on Refresh.

## Install from a VSIX

```sh
npm install
npm run package          # → dist/stitch-<version>.vsix
code --install-extension dist/stitch-<version>.vsix
```

Or, in VS Code: Extensions view → `…` → *Install from VSIX…*.

## Development

```sh
npm install
npm test        # needs git and tar; the SVN server tests use podman and are skipped without it
npm run build   # bundle to dist/
```

Press F5 in VS Code to run the extension in a development host. See [docs/CONTEXT.md](docs/CONTEXT.md) for how Stitch is built and why.

## License

[MIT](LICENSE)
