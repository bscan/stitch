# Plan: Stitch — read-only file history for SVN + Git

## Context
svn-scm is a full SCM client (status, commit, changelists, branches) that only works when a folder is opened. What's wanted is narrower in features but broader in reach. For **any file opened anywhere** (local disk or network drive, with or without a workspace folder), show:
1. **File History** in the Explorer sidebar: the file's commits. Click one to diff it against the previous revision, or open that revision.
2. **Gutter diffs** for SVN files, against BASE.
3. An **"Open Changes"** button for SVN files: working file vs BASE.

Git files get **history only**. The built-in Git extension already does the gutter and Open Changes, and adding ours would draw duplicate markers.

Environment:
- SVN 1.6 and 1.14 working copies.
- Servers are **1.7+, http(s), anonymous read**. Some working copies were checked out via `svn://`.

svn-scm can't serve this setup safely. It uses a single binary and **prompts to run `svn upgrade`** on older working copies (`svn-scm/src/source_control_manager.ts`), which makes them unusable by 1.6 clients.

**Decision: a new extension, not a fork.** svn-scm is MIT, so we copy useful pieces and keep its copyright notice: the XML log parsing idea from `svn-scm/src/parser/logParser.ts`, and tree item rendering, icons and "load more" paging from `svn-scm/src/historyView/common.ts` and `svn-scm/src/historyView/itemLogProvider.ts`.

Estimated size: about 1,400–1,800 lines of TypeScript, versus about 10,900 in svn-scm. Effort: about 2–3 weeks for one developer. The risk is concentrated in `wc17.ts` (the internal wc.db schema, stable from 1.8 to 1.14) and `dav.ts` (the thinly documented HTTP protocol). Both are covered by Docker-based tests against real clients and a real server.

## Core design principle: SVN needs no binary
- **Local data** (URL, BASE revision, BASE content, repo UUID) is read directly from `.svn/` in TypeScript, for every working-copy format.
- **Remote data** (log, old revisions) is fetched over **HTTP (the WebDAV/HTTPv2 protocol)** with plain requests. Anonymous read means there's no auth to handle.
- The extension **never writes** to a working copy or a repository, so 1.6 and 1.14 working copies are both safe.
- Git uses the `git` binary, which is always present wherever VS Code Git works. Pure-JS git was rejected: no `--follow`, and slow on large repos.

## Git history: trunk view with expandable merges
Show history as a trunk where each merge is one row, expandable to the branch commits behind it. We use **lazy per-merge queries**, not a two-query "classify everything" scheme. That scheme was evaluated and rejected: `--full-history` lists trunk merges that didn't change the file on trunk (they still differ from their second parent), so they get misclassified as branch commits. It also relies on topo order, which doesn't guarantee grouping, and its two query windows don't line up when paged.

| Need | Command (via the `git()` allowlist) |
|---|---|
| Top level (one page) | `git log --first-parent --follow -n <limit> --name-status --format=<NUL-delimited: %H %P %an %at %D %s> -- <path>`. With `--first-parent`, merges are compared only with their first parent, so exactly the trunk commits and merges that changed the file on trunk are listed. `--name-status` gives the old path for renames. |
| Expand merge M | `git log --name-status --format=… M^1..M^2 -- <pathAtM>`, run when the node is expanded. This is by definition "what M brought in"; default simplification skips sync merges whose content came from trunk. |
| "(N commits)" on merge rows | `git rev-list --count M^1..M^2 -- <pathAtM>`, only for the merges on screen, at most 4 running at once. |
| Load more | `--skip`/`-n` on the top-level query, or start from the last hash shown (`<lastHash>^1`). |
| Diff a row | VS Code diff editor: `stitch:git/<rev>^1/<oldPath>` ↔ `stitch:git/<rev>/<path>` (first parent, so merges show what the whole branch changed on trunk, conflict resolutions included). **That is the only diff for merge rows.** There are deliberately no PR-style, second-parent or remerge-diff actions; per-commit detail comes from expanding the merge. A file added or deleted by the branch is shown against empty content, and so is a root commit. Avoid `--diff-merges` (git ≥ 2.31 only). |

- Row content: short hash, subject, author, relative date, `%D` branch/tag labels, and a merge icon. The tooltip shows the full message.
- "Trunk" is HEAD's first-parent chain. A view toolbar **ref picker** (e.g. `origin/main`) changes the starting ref.
- Known limitations (in the README): `git pull` merges ("Merge branch 'x' of <remote>") have swapped parents. Detect them by subject and label them "pull merge" rather than trying to fix them. Squash or rebase repos have no merges, so the view degrades to a correct flat list.
- Tests: fixture repo covering:
  - a trunk merge where the branch didn't touch the file (must **not** appear);
  - a branch with a sync merge from main;
  - a nested branch-of-branch;
  - a rename on the trunk and a rename on a branch;
  - a pull merge;
  - a root commit.

## Architecture
```
active editor (file: URI)
  └─ resolver.ts: walk up from the file's folder; the nearest .git or .svn wins (handles nesting; a .git without HEAD, or a .git file without `gitdir:`, is ignored); results cached per folder
       ├─ git/gitBackend.ts   git binary: rev-parse --show-toplevel, log --follow, show <rev>:<path>
       └─ svn/svnBackend.ts
            ├─ wc16.ts      entries formats 8/9/10: parse .svn/entries (url, revision, uuid, repos root)
            │               BASE = .svn/text-base/<name>.svn-base; props from .svn/prop-base
            ├─ wc17.ts      entries "12": find the WC root's .svn/wc.db with sql.js (read-only, re-read on mtime change)
            │               NODES(local_relpath, op_depth=0) → checksum, revision, repos_path, properties
            │               REPOSITORY → root, uuid; BASE = .svn/pristine/<sha1[0:2]>/<sha1>.svn-base
            ├─ keywords.ts  expand $Id$/$Rev$/$Author$/$Date$/$URL$/$HeadURL$ in BASE when svn:keywords is set
            ├─ urlMap.ts    svn://… → http(s)://… mapping (setting), checked against the repo UUID
            └─ dav.ts       HTTPv2 client (below)
```

### `dav.ts`: the HTTPv2 client (servers 1.7+ only)
| Operation | Request |
|---|---|
| Discover | `OPTIONS <url>` with an `<D:options><D:activity-collection-set/></D:options>` body. Read the headers `SVN-Repository-Root`, `SVN-Youngest-Rev`, `SVN-Rev-Root-Stub` (`!svn/rvr`) and `SVN-Repository-UUID`. Cache per repo root. |
| History | `REPORT <root>/!svn/rvr/<pegRev>/<path>` with `<S:log-report xmlns:S="svn:">`: start=pegRev, end=0, `<S:limit>`, `<S:discover-changed-paths/>`, revprops `svn:author`/`svn:date`/`svn:log`, `<S:path/>`. Copies are followed by default, like `svn log`. |
| Content at a revision | `GET <root>/!svn/rvr/<rev>/<pathAtRev>` |
| Path at an older revision (renames) | `REPORT <root>/!svn/rvr/<pegRev>/<path>` with `<S:get-locations>` (peg-revision + location-revision list). Alternatively, derive the path from the `copyfrom-path` entries in the log's changed paths. |

- Use Node `https`/`http` through VS Code's patched networking, so the user's proxy settings and system CA certificates apply (important for internal CAs).
- Every request has a timeout and a cancellation token.
- If a 401 response arrives, show a clear message. HTTP Basic support is a possible later addition.
- If `OPTIONS` lacks the `SVN-Rev-Root-Stub` header, the server is pre-1.7: show "server too old, unsupported" rather than failing silently.

### `svn://` working copies
- Setting `stitch.svn.urlMap`: `{ "svn://svnhost/repos": "https://svnhost/svn/repos" }`. Prefixes are matched longest first.
- Check the mapping by comparing `SVN-Repository-UUID` from `OPTIONS` with the UUID stored in the working copy. On a mismatch, refuse and show "URL mapping points at a different repository".
- An unmapped `svn://` working copy still gets the gutter and Open Changes (they're local). History shows "Add a URL mapping for svn://… in settings", with a button that opens the setting.

### Backend interface
```ts
interface VcsBackend {
  kind: "git" | "svn";
  root: string;
  original?(file): Promise<string | undefined>;   // SVN only: BASE text, for the gutter and Open Changes
  isModified?(file): Promise<boolean>;            // SVN only
  log(file, opts: { limit: number; before?: string }): Promise<Commit[]>;
  show(file, rev): Promise<string>;
}
```

### VS Code surface
- View `stitch.history` in the `explorer` container. It is always visible and shows an empty-state message: "Not under version control", "Server unreachable", "Add URL mapping…", "git not found".
- The "Open Changes" button in `editor/title` uses `when: stitch.svnModified`. That context key is updated on editor change and on save.
- Quick diff: a `SourceControl` is created for each SVN WC root the first time a file in it is opened. It has a `quickDiffProvider` and no resource groups, and appears in the SCM view as an empty provider (an accepted side effect).
- `stitch:` is a **read-only FileSystemProvider** (backend, path, revision → raw bytes) that feeds the diffs and the gutter. It returns bytes, not strings, so VS Code decodes them with the same encoding as the editor (`files.encoding`, auto-detection). That avoids whole-file false diffs on non-UTF-8 files (e.g. Windows-1252), which are common in old SVN repos. Keyword expansion operates on bytes (keywords are ASCII).
- Commands: Open Changes, Diff with Previous, Diff with Working File, Open Revision, Copy Revision, Refresh.
- Settings: `stitch.svn.urlMap`, `stitch.git.path`, `stitch.logLimit` (default 50), `stitch.timeoutMs`.
- Activation: `onStartupFinished`. No workspace scanning; everything is scoped to the active editor.

### Network drives and robustness
- Don't rely on file watchers, which are unreliable on SMB/NFS. Refresh on active-editor change, on save, on window focus, and from the Refresh button.
- Re-read `wc.db` only when its mtime changes, because it can be large on a share.
- The gutter works offline. History errors show in the view, never as modal dialogs.
- Git "dubious ownership" (common on shares): detect it and suggest `git config --global --add safe.directory <path>`. Never change git config automatically.

## Read-only guarantee (enforced, not just omitted)
The extension offers **no write features**: no commit, update, revert, add, lock, upgrade or cleanup, and no git commands that change a repo. This is enforced at each layer:

| Layer | Enforcement |
|---|---|
| Commands | Only the 6 read commands are contributed. A unit test checks that `package.json` `contributes.commands` exactly matches an allowlist. |
| SCM provider | The quick-diff `SourceControl` has `inputBox.visible = false`, no `acceptInputCommand`, no resource groups and no `statusBarCommands`. That leaves no commit box or button. |
| SVN over HTTP | `dav.ts` has a single `request()` choke point with an **HTTP method allowlist: `OPTIONS`, `GET`, `REPORT`**. Every other method (PUT, POST, MKACTIVITY, CHECKOUT, MERGE, DELETE, PROPPATCH, LOCK, COPY, MOVE, …) throws before any network I/O. `REPORT` bodies are limited to `log-report` and `get-locations`. Unit tests cover both allowlists. |
| SVN binary | None is used, so nothing can be committed through it. |
| Working copy on disk | `.svn/` is only read with `fs.readFile`/`stat`. sql.js opens a **copy** of `wc.db` in memory, which is never exported or written back. No temp files are created, because content is served from memory. An ESLint `no-restricted-properties` rule bans `fs` write APIs (`writeFile`, `appendFile`, `unlink`, `rm`, `rename`, `mkdir`, `copyFile`, `open` with write flags) across `src/`. |
| `stitch:` provider | Registered with `isReadonly: true`. `writeFile`/`delete`/`rename`/`createDirectory` throw `FileSystemError.NoPermissions`. |
| Git | `gitBackend.ts` has a single `git()` choke point with a **subcommand allowlist: `rev-parse`, `rev-list`, `log`, `show`, `cat-file`**. It runs with `GIT_OPTIONAL_LOCKS=0` (no opportunistic index refresh), `-c core.fsmonitor=false`, and `--no-textconv`/`--no-ext-diff`, so no repo-configured programs run. This also guards against untrusted repos on shared drives. |
| Messages | Suggestions such as `safe.directory` are displayed as text only. The extension never runs them and never changes git or svn configuration. |

Out of scope: the **built-in** Git extension still offers commit for git files. That belongs to VS Code itself, not to us (users can set `git.enabled: false` if they want none).

## Proposed layout (new repo)
```
src/extension.ts  resolver.ts  backend.ts  content.ts  quickDiff.ts  commands.ts
src/history/historyView.ts
src/git/gitBackend.ts
src/svn/svnBackend.ts  wc16.ts  wc17.ts  keywords.ts  urlMap.ts  dav.ts
test/fixtures/ (wc16/, wc114/, generated by a script)   test/*.test.ts
```

## Milestones
1. **Scaffold + resolver + Git history.** Tree view, `stitch:` content provider, diff with previous. This proves the UI end to end.
2. **SVN 1.7+ local reads** (wc.db + pristine), gutter, Open Changes.
3. **SVN 1.6 local reads** (entries + text-base) and keyword expansion.
4. **DAV history** (OPTIONS, log-report, GET, get-locations) and the `svn://` URL mapping.
5. Hardening: refresh triggers, timeouts, empty states, settings, README.

## Verification
- **Unit tests** (mocha + `@vscode/test-electron`):
  - Fixture working copies created by real 1.6 and 1.14 clients (a Docker script with both client versions, plus an Apache mod_dav_svn 1.14 server with anonymous read and one renamed file). Assert that the URL, revision, UUID and BASE content parsed from `.svn/` match `svn info` and `svn cat -r BASE`.
  - `dav.ts` against the Docker server. Log entries and contents must match `svn log --xml URL` and `svn cat URL@rev`, including across a rename.
  - Keyword expansion; URL mapping (match, UUID mismatch); resolver nesting (git in svn, svn in git, worktree `.git` file).
  - Read-only tests:
    - The `dav.ts` method allowlist rejects PUT/MKACTIVITY/etc. without sending a request.
    - The `git()` subcommand allowlist rejects `commit`/`push`/`reset`/etc.
    - The `package.json` command list matches the allowlist exactly.
    - Hash every file under the fixture working copies' `.svn/` and the git repo's `.git/` before and after a full test run, and assert they're unchanged.
- **Manual, in the Extension Development Host (F5), with no svn binary on PATH:**
  1. Empty window → Open File on a modified file in a 1.14 working copy: gutter markers, Open Changes, history, diffs.
  2. Same for a 1.6 working copy: everything works, and `.svn/entries` is still format 10 afterwards (the working copy is untouched).
  3. An `svn://` working copy: the "Add URL mapping" message appears; after adding the mapping, history loads.
  4. A file on a network share: refresh works with no watchers.
  5. A git file: history works, and only the built-in Git gutter shows.
  6. Server unreachable: the gutter works, and history shows "Server unreachable" within the timeout.

## Implementation status

| Milestone | State | Notes |
|---|---|---|
| 1. Scaffold + resolver + Git history | **done**, run in an Extension Development Host (worked; one tree-refresh error fixed, see below) | not committed |
| 2. SVN 1.7+ local reads, gutter, Open Changes | **done** (not yet run in an Extension Development Host) | |
| 3. SVN 1.6 local reads + keywords | **done** (not yet run in an Extension Development Host) | 96 tests passing in total: `npm test` |
| 4. DAV history + `svn://` URL mapping | **done** (not yet run in an Extension Development Host) | 110 tests passing in total, including a mod_dav_svn 1.14 server in podman |
| 5. Hardening | **done** (not yet run in an Extension Development Host) | 113 tests passing; the packaged `.vsix` activates in a stubbed-vscode smoke check |
| Fetch button (git) | **done** (not yet run in an Extension Development Host) | 125 tests passing (podman SVN tests skipped); the one write, see CLAUDE.md |
| Fetch-age note in the view title (git) | **done** (not yet run in an Extension Development Host) | 127 tests passing (podman SVN tests skipped) |

Differences between milestone 1 and the text above:
- **Merge expansion is recursive first-parent.** Expanding merge M runs `git log --first-parent --follow M^2 ^M^1 [^outer first parents…] -- <pathAtM>`, rather than a flat `M^1..M^2`, so merges inside a branch expand the same way as trunk merges. The exclusions are built by `GitRepo.childExclude`. `rev-list --count` uses the same range.
- **Paging continues from `<last>^1` with the last row's old path**, instead of `--skip`. That keeps rename tracking correct across pages.
- **The fs write-API ban is a test** (`test/readonly.test.ts`), not an ESLint rule. The test also checks that only `src/git/exec.ts` imports `child_process`, and that `package.json` contributes exactly the allowlisted commands.
- **The git allowlist is enforced in `src/git/exec.ts`:**
  - subcommands `rev-parse`, `rev-list`, `log`, `show`, `cat-file`, `for-each-ref` (added for the Fetch button's upstream remote);
  - banned arguments `--output`, `--textconv`, `--ext-diff`, `--show-signature`;
  - global `-c core.fsmonitor=false -c diff.external= -c log.showSignature=false`;
  - env `GIT_OPTIONAL_LOCKS=0 GIT_LITERAL_PATHSPECS=1 GIT_TERMINAL_PROMPT=0 LC_ALL=C`.
- **The commands contributed so far** are `stitch.openChanges`, `stitch.refresh`, `stitch.pickRef`, `stitch.loadMore`, `stitch.diffWithPrevious`, `stitch.diffWithWorking`, `stitch.openRevision`, `stitch.copyRevision` (later `stitch.fetch`, the one write).
- **Tree items have stable ids** (the chain of revisions from the top level). Without them VS Code keys rows by label, and the "(N commits)" label update on a merge row failed with "Data tree node not found".

Differences between milestones 2–3 and the text above:
- **Fixtures** are tarballs (`test/fixtures/svn16|svn18|svn114.tar.gz`, about 3–8 KB each) built by `test/fixtures/make-svn-fixtures.sh` with podman: Debian squeeze (svn 1.6.12), Debian jessie (1.8.10), Alpine 3.20 (1.14.5). Each holds the working copy plus the client's own `svn info --xml`, `svn status`, `svn cat -r BASE` (with and without `--ignore-keywords`) output, which the tests compare against. The repository is `file://`; milestone 4 will need a server fixture.
- **Layout:** `src/svn/types.ts` (the `SvnWorkingCopy` interface both readers implement), `skel.ts` (wc.db property lists), `sqlite.ts` (sql.js loader), `wc17.ts`, `wc16.ts`, `keywords.ts`, `svnBackend.ts` (`SvnRepo`: BASE text with keywords expanded, modification check). `src/quickDiff.ts` holds the `SourceControl`s. There is no `VcsBackend` interface yet; the extension handles git and svn separately, which is simpler until SVN history exists.
- **wc17** accepts wc.db formats 29–31 (svn 1.7–1.14). The working node is the `NODES` row with the highest `op_depth`, and its checksum is the text svn compares against (for a copy, the copy source). History info comes from the `op_depth = 0` row, or from the copy source.
- **wc16** accepts entries formats 8–10 (svn 1.4–1.6). The working-copy root is the highest ancestor whose entries list the folder below as a child directory, so a 1.6 working copy gets one `SourceControl`, not one per folder, and externals stay separate.
- **Keywords** are fully implemented (aliases, fixed-width `$Kw:: $`, custom `Name=format` from 1.8, contraction). `$Date$` uses local time, as the client does.
- **The modification check** mirrors `svn status`: size + mtime against the recorded values first, then a byte compare after contracting keywords and, when `svn:eol-style` is set, normalizing line endings. EOL is not translated for the diff itself; VS Code's diff ignores line-ending differences.
- **BASE content is invalidated** when `wc.db`/`entries` change (checked on window focus, and on Refresh): `stitch:` fires change events for the BASE URIs it served, and reports a moving mtime for them, so gutters and open diffs re-read after an `svn update`/`commit` elsewhere.
- **The `stitch.svnModified` context key** is true when the file differs from BASE on disk or the editor is dirty.
- `sql-wasm.wasm` is copied to `dist/` by `npm run build` (`copy-wasm` script); the bundle is about 130 KB plus the 650 KB wasm.

Differences between milestone 4 and the text above:
- **No `get-locations`.** The file's path at every revision is derived from the log's changed paths (exact `added/replaced-path` with `copyfrom-*`, or a copied parent folder), as the plan allowed. `REPORT` is restricted to `log-report` only; the allowlist test covers `update-report`, `get-locations`, malformed bodies, and a GET with a body.
- **The peg must be the file's own path at the revision asked about.** mod_dav_svn's log does not trace a path from a peg back to an older operative revision (`rvr/25/trunk/b.txt` with start=end=8 → 404 "File not found: revision 8"). Paging therefore continues from `rvr/<rev before the last row>/<path at that rev>`, and merge expansion asks `rvr/<merge rev>/<path at merge rev>`.
- **Merges (decided: expand like git).** Top-level log is plain `svn log -v`. A row is a merge candidate when the revision changed the file and has `prop-mods="true"` on the file or a parent folder. For candidates on screen, `log-report` with `include-merged-revisions` for that single revision (start = end = rev, limit 1) gives the merged revisions; that is both the "(N revisions)" count and the children (cached, at most 4 queries at once, as for git). Candidates with no merged revisions are plain rows. Nested merges come in the same response (`has-children` … `version-name -1`).
- **History source abstraction.** The view no longer knows git: `src/history/source.ts` defines `HistorySource` (`top`, `more`, `expand`, `count`, with an opaque per-level context), implemented by `GitSource` (same file) and `SvnSource` (`src/svn/svnHistory.ts`). This replaces the `VcsBackend` interface sketched above.
- **Keywords in revisions:** "Diff with Working File" and "Open This Revision" fetch with `?kw=1` (mod_dav_svn 1.8+ expands keywords; 1.7 ignores the parameter). "Diff with Previous" fetches raw so `$Rev$` lines don't show as changed.
- **`stitch:` URIs for svn revisions** carry the repository's http(s) root URL, so restored diff tabs work after a reload.
- **Layout:** `src/svn/xml.ts` (small XML parser for server responses), `dav.ts`, `urlMap.ts`, `svnHistory.ts`. Test server: `test/fixtures/svn-server/` (Containerfile, `build-repo.sh` with the repository history and the svn client's expected output, Apache config that denies everything but GET/PROPFIND/OPTIONS/REPORT), started by `test/svnServer.ts`.
- **HTTP Basic auth** is still not supported; 401/403 shows a message.

What milestone 5 added:
- **Logging:** `src/log.ts` (no vscode) with a sink the extension routes to a `LogOutputChannel` named "Stitch". `src/git/exec.ts` logs every git command (the `--format=` argument elided) with output size and time; `request()` in `src/svn/dav.ts` logs every HTTP request with status, size and time. Failures are warnings; cancellations are debug.
- **Cancellation:** the history view keeps an `AbortController` per generation and aborts it when it switches target. Every `HistorySource` method takes the signal (git: `execFile` `signal`; svn: the request's `signal`). Queued merge counts for a file the user left never start.
- **Errors:** `describeError` moved to `src/errors.ts` (no vscode), with `isCancelled`/`isNotFound`. The `stitch:` file system throws `FileNotFound` only when the content really doesn't exist, and `Unavailable` with the reason otherwise (server unreachable, timeout), and logs both.
- **Retry:** when the window regains focus and the view is showing a message instead of history (an error, or "add a URL mapping"), Stitch follows the active editor again.
- **wc.db reads:** one retry after 300 ms if reading or opening fails (svn may be rewriting it). Unsupported formats throw `SvnError("unsupported")`, which isn't retried; format 32+ gets a "newer than 1.14" message. `SvnError` moved to `src/svn/types.ts`.
- **`stitch.svn.urlMap` validation:** a mapping to a non-http(s) URL is reported, not attempted.
- **Packaging:** `npm run package` (`@vscode/vsce` 3.2.1, `--no-dependencies --allow-missing-repository`) writes `dist/stitch-<version>.vsix`, about 350 KB (bundle + sql.js wasm, README, LICENSE). `.vscodeignore` keeps docs, CLAUDE.md and old packages out.
- Not done, deliberately: no file watchers (network shares); no workspace-trust declaration (untrusted workspaces keep the extension disabled, VS Code's default).

## After milestone 5: incoming changes and changed files

- **Incoming (svn):** `SvnSource.top()` also fetches the server's youngest revision (an uncached `OPTIONS`) and, when it's newer than the file's BASE, `log-report` on the same path pegged at youngest, `start = youngest`, `end = BASE + 1`. The view shows those rows tagged "incoming", then a separator info row ("──── your working copy: r<BASE> ────", `location` icon), then the BASE history. A 404 (path gone at youngest) becomes a note on the separator; more than `stitch.logLimit` incoming adds a "More incoming revisions not listed" row. On window focus (throttled to 30 s) `serverMoved()` compares youngest with the one seen at load and reloads the view if it changed. Git: see below.
- **Changed files:** `Commit.files` (`ChangedFile`: path, status A/M/D/R/C/T, oldPath, svn `fromRev`). svn builds it from the log's changed paths (folders left out; a copy whose source the same revision deleted is one R entry). git fills it per page with one `git log --no-walk=unsorted -m --first-parent -M --name-status` over the page's commits (merges against the first parent, like the row's diff). **The view waits for it before showing the page** (`HistoryView.settle()`), and likewise for the merge check of svn merge candidates that changed only this file: VS Code lays out a level by which rows have expand arrows, so arrows that appeared after the first render shifted rows sideways (seen on files outside the workspace, where git answers more slowly). Merge counts on other rows still arrive later; they only change the label. A commit row is expandable only when it changed more than one file; it expands to the files (this file first, marked). A merge row expands to "Changed files (N)" (when N > 1) followed by the merged commits. File rows run `stitch.diffFile` (`fileDiff()` in `backend.ts`: before side = `fromRev` or the first parent; A → empty left, D → empty right).
- **Incoming (git), read-only:** loading history never fetches (a fetch writes to `.git/`); only the Fetch button does (next item). It uses the remote-tracking branch as it is: `rev-parse --abbrev-ref --symbolic-full-name <ref>@{upstream}` (none for a detached HEAD, a hash, a tag or a remote ref), then the usual first-parent walk `log --first-parent --follow <upstream> ^<ref> -- <path>`, with level `[<ref hash>]` so incoming merges expand to only what they bring in. The separator reads "your branch: <name>" with "<upstream>, fetched <relative time>" from the mtime of `rev-parse --git-path FETCH_HEAD` ("not fetched yet" without one). If the incoming query fails, the history still loads (warning in the log). The reload check (`gitState`) is now "<ref hash> <upstream hash>", checked on window focus and on editor switches, so a fetch by VS Code's autofetch shows up without a manual Refresh.
- **Fetch-age note (git):** the view description becomes "<file> · fetched 3 d ago" (or "· never fetched") when the branch has an upstream on a remote (`upstreamRemote`) and `FETCH_HEAD`'s mtime is older than max(1 h, 2 × `git.autofetchPeriod` when `git.autofetch` is on). It keys on the fetch age, not the autofetch setting: autofetch may be on but not cover this repo (VS Code's Git only fetches repos it opened) or be failing, and other fetches (pull, terminal, cron) count. Shown on network paths too (it's about how current incoming is, not the button). Recomputed on target change, window focus and editor switches (`refreshIfMoved`), Refresh, after Fetch, and when `git.autofetch*` changes; no timers. Logic in `fetchNote`/`staleFetchMs` (`src/history/format.ts`), tested in `test/unit.test.ts`.
- **Fetch button (git), the one write:** `stitch.fetch` in the view title (cloud icon), shown when `stitch.canFetch` (a git file, a trusted workspace, the repo root and its `--git-common-dir` not on a network path per `src/git/fetchPolicy.ts`) and `isWorkspaceTrusted`. On click: the remote from `for-each-ref --format=%(upstream:remotename) refs/heads/<branch>` (none for a detached HEAD, a non-branch ref or a local upstream: info message), then `gitFetch()` (fixed argv, see CLAUDE.md), with progress on the view and a timeout of max(`stitch.timeoutMs`, 120 s). Afterwards a status-bar note says whether the upstream moved, and the view reloads (the separator's "fetched …" time changes even when nothing moved). A login failure (prompts are off) gets its own message. Tests: `test/fetch.test.ts` (real local remote: origin moves; no pruning despite `fetch.prune=true`; a `reference-transaction` hook doesn't run; HEAD, branches, index and working file unchanged), `test/readonly.test.ts`, and the path policy in `test/unit.test.ts`.

## Server load (svn)

No timers or polling exist; every request follows a user action (open/switch file, expand, diff, focus, Refresh). To keep switching back and forth or alt-tabbing cheap:
- **Per-file interval** (`stitch.svn.refreshInterval`, default 60 s, machine-scoped): `SvnSource.top()` returns its last result (or rethrows its last failure, unless it was a cancellation) within the interval. The extension keeps `SvnSource`s per file|repo|path|BASE (LRU of 30) across switches, so returning to a file reuses its loaded history and its merge-check cache.
- **Merge checks** (`log -g`, heavy on the server) are cached per source for the session (immutable data).
- **New-revision check** on window focus: `SvnSource.needsReload()` asks (one OPTIONS) at most once per interval, counting the last fetch; if the server moved it clears the cached page and the view reloads.
- **Failures:** `DavClient.options()` returns a cached failure for the interval instead of asking again.
- **Refresh** (and settings changes) drop all of this: a new `DavClient` and no sources.
- Tests count real requests through the log sink to prove "0 requests" within the interval.
