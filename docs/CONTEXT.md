# Context: how Stitch came about, and what was decided

This is the maintainer's record for Stitch, kept for whoever picks the work up next. It records **how** Stitch is built, **why** things are the way they are, the facts that were checked, and the questions still open. The [README](../README.md) describes the features from the user's side.

## How it's built

```
active editor (file: URI)
  └─ resolver.ts: walk up from the file's folder; the nearest .git or .svn wins (handles nesting; a .git
       │           without HEAD, or a .git file without `gitdir:`, is ignored); results cached per folder
       ├─ git/exec.ts        the only place that runs a process: subcommand allowlist + gitFetch()
       ├─ git/gitBackend.ts  GitRepo: log, show, upstream, fetch-age;  git/parse.ts: -z log output
       ├─ git/fetchPolicy.ts whether the Fetch button is offered (network paths, drives)
       └─ svn/svnBackend.ts  SvnRepo: BASE text with keywords expanded, modification check
            ├─ wc16.ts       entries formats 8–10 (svn 1.4–1.6): .svn/entries, text-base/, prop-base/
            ├─ wc17.ts       wc.db formats 29–31 (svn 1.7–1.14), via wcdb.ts → wcdbWorker.ts (node:sqlite thread)
            ├─ skel.ts       wc.db property lists;  keywords.ts: svn:keywords expansion/contraction
            ├─ dav.ts        HTTPv2 client; the only module allowed to import network modules
            ├─ xml.ts        small XML parser for server responses;  urlMap.ts: svn:// → http(s)
            └─ svnHistory.ts SvnSource
history/source.ts    HistorySource (top, more, expand, count; opaque per-level context), GitSource
history/historyView.ts  the tree view;  history/format.ts: labels, fetch note;  history/patch.ts: Copy Diff
content.ts           read-only `stitch:` FileSystemProvider (raw bytes, so VS Code decodes both diff sides alike)
quickDiff.ts         one empty SourceControl per SVN working copy, for the gutter
revertHunk.ts        the buffer edit for the gutter peek's Revert Change (pure; LineChange → text replacement)
log.ts, errors.ts    logging sink (→ "Stitch" output channel), describeError/isCancelled/isNotFound
```

Only `extension.ts`, `content.ts`, `quickDiff.ts` and `history/historyView.ts` import `vscode`; the rest is tested with plain mocha.

### Git queries
- **Top level:** `git log --first-parent --follow -n <limit> --name-status --format=<NUL-delimited> -- <path>`. With `--first-parent`, merges are compared only with their first parent, so exactly the trunk commits and merges that changed the file on trunk are listed. Paging continues from `<last>^1` with the last row's old path (not `--skip`), which keeps rename tracking right across pages.
- **Expand merge M:** `git log --first-parent --follow M^2 ^M^1 [^outer first parents…] -- <pathAtM>` (exclusions built by `GitRepo.childExclude`), so merges inside a branch expand like trunk merges. "(N commits)" is `rev-list --count` over the same range, only for merges on screen, at most 4 at once.
- **Changed files:** one `git log --no-walk=unsorted -m --first-parent -M --name-status` per page. The view waits for it before showing the page (`HistoryView.settle()`): VS Code lays out a level by which rows have expand arrows, and arrows that appear later shift rows sideways.
- **Diffs** are first-parent: `stitch:git/<rev>^1/<oldPath>` ↔ `stitch:git/<rev>/<path>`. Added/deleted files and root commits compare with empty content. No `--diff-merges` (git ≥ 2.31 only).
- **Incoming:** `rev-parse --abbrev-ref --symbolic-full-name <ref>@{upstream}`, then `log --first-parent --follow <upstream> ^<ref> -- <path>`. Fetch age is the mtime of `rev-parse --git-path FETCH_HEAD` (the path is looked up once per repository, then it's one stat).
- **Unpushed:** one `rev-list <ref hash> ^<upstream hash>` per load (both hashes from the state check; skipped when they're equal or there's no upstream) gives every commit the upstream lacks, not only this file's. `GitSource` keeps the set and sets `Commit.unpushed` (the tooltip line) on the commits of `top()`, `more()` and `expand()`, so rows at every level are marked without further git calls. It is not path-limited because `rev-list -- <path>` doesn't follow renames, and not `--no-walk <revs> ^<upstream>` because git doesn't apply exclusions without walking. `TopPage.pushedLine` carries the text of the "upstream: origin/main" separator (fetch age rebuilt on each serve, like the incoming one); `HistoryView.withPushedLine()` places it at the top level before the first unmarked commit that follows a marked one, also across a Load more boundary. One place suffices: a first-parent walk that reaches a commit of the upstream stays within the upstream. The set is as large as the branch is ahead (unbounded if the upstream is unrelated). It's remembered with the page; a failed rev-list is treated like a failed incoming log (no marks, tried again next time).
- **Reuse:** sources are kept per file|root|path|ref in `extension.ts` (LRU of 30). `GitSource.top()` first runs the state check (ref hash, upstream name and hash: rev-parse only) and returns its last result when the state and limit are unchanged, so switching back runs no `git log`. The page and the incoming log both start from the hashes of that check, so the result matches the state it's remembered under. The changed files the view fills into the commits stay with them, and `count()` keeps each merge's `rev-list --count` (keyed by merge, path and exclusions, which only name commits). The view aborts its signal on every file switch, so a count that finished is kept regardless of its signal; only one still running when its view was left is started again. The separator's "fetched … ago" text is not stored: it's rebuilt from FETCH_HEAD's mtime each time the page is served. Not remembered: a cancelled load, a load whose incoming part failed, Load more pages, expanded merges. `moved()` (window focus, editor switches) reloads the current view when the state changed; `invalidate()` (Refresh, Stitch settings, the Fetch button) forgets everything. Tests count real git commands through the log sink.
- **Copy Diff** computes the unified diff itself (Myers, 3 lines of context) from the two sides served by `stitch:`: SVN has no binary to ask, and `git diff` would need another allowlisted subcommand. Non-UTF-8 is read as Latin-1; content with a NUL byte is reported as binary.
- Tree items have stable ids (the chain of revisions from the top). Without them VS Code keys rows by label, and updating a merge row's label failed with "Data tree node not found".

### SVN over HTTP (`dav.ts`, servers 1.7+)
| Operation | Request |
|---|---|
| Discover | `OPTIONS <url>`: headers `SVN-Repository-Root`, `SVN-Youngest-Rev`, `SVN-Rev-Root-Stub`, `SVN-Repository-UUID`. No `SVN-Rev-Root-Stub` means pre-1.7 ("server too old"). |
| History | `REPORT <root>/!svn/rvr/<peg>/<path>` with `<S:log-report>` (changed paths, author/date/log revprops). The peg must be the file's own path at that revision: mod_dav_svn doesn't trace a peg back to an older path, so paging and merge expansion peg at `<rev>/<path at rev>`. |
| Merges | Candidates are revisions that changed the file with `prop-mods` on it or a parent folder. For those on screen, `log-report` with `include-merged-revisions` for that single revision gives the merged revisions (cached for the session, at most 4 at once). |
| Incoming | `log-report` pegged at youngest, `start = youngest`, `end = BASE + 1`; a 404 means the path is gone at HEAD. Youngest is the repository's last `OPTIONS` answer if it is at most 60 s old (`RECENT_YOUNGEST_MS`), so opening another file soon after costs one round trip, not two; a revision committed within that minute shows up on the next focus check or Refresh. |
| Content | `GET <root>/!svn/rvr/<rev>/<path>`; `?kw=1` for keyword-expanded (1.8+) in Diff with Working File and Open This Revision, raw for Diff with Previous. |

There is no `get-locations`: the file's path at each revision is derived from the log's changed paths (`copyfrom-*` on the file or a copied parent folder). `stitch:` URIs for svn revisions carry the repository's http(s) root, so restored diff tabs work after a reload. Requests go through VS Code's patched Node networking, so proxy settings and system CAs apply.

**Server load:** no timers or polling. `SvnSource.top()` returns its last result (or last failure) within `stitch.svn.refreshInterval`; sources are kept per file|repo|path|BASE (LRU of 30). `DavClient.options()` caches failures for the interval. `needsReload()` (on focus) asks at most once per interval. Refresh and settings changes drop all of it. Tests count real requests through the log sink.

### SVN working copies
- **wc17:** the working node is the `NODES` row with the highest `op_depth`; its checksum is what svn compares against (for a copy, the copy source). History info comes from `op_depth = 0`, or the copy source.
- **wc16:** the working-copy root is the highest ancestor whose entries list the folder below as a child directory, so a 1.6 working copy gets one `SourceControl`, and externals stay separate.
- **Modification check** mirrors `svn status`: size + mtime first, then a byte compare after contracting keywords and, with `svn:eol-style`, normalizing line endings. The `stitch.svnModified` context key is also true when the editor is dirty.
- **BASE invalidation:** when `wc.db`/`entries` change, `stitch:` fires change events for the BASE URIs it served, so gutters and open diffs re-read. Checked (one stat per working copy) on window focus, editor switches, a clean file whose text changed (VS Code reloaded it from disk: the first sign of an `svn update` run in the integrated terminal, where focus never leaves the window), and Refresh. `changed()` compares with the stamp at its own previous call, not at the last read: reads happen on every editor switch, and when they reset the stamp, an update was "seen" by the read and never reported, so the gutter kept the old BASE and showed the incoming changes as local edits.

### Read-only enforcement
| Layer | Enforcement |
|---|---|
| Commands | `test/readonly.test.ts` checks that `package.json` contributes exactly the allowlisted commands. |
| SCM provider | The quick-diff `SourceControl` has no visible input box, no accept command, no resource groups, no status-bar commands. |
| Git | `src/git/exec.ts`: subcommands `rev-parse`, `rev-list`, `log`, `show`, `cat-file`, `for-each-ref`; banned `--output`, `--textconv`, `--ext-diff`, `--show-signature`; `-c core.fsmonitor=false -c diff.external= -c log.showSignature=false`; env `GIT_OPTIONAL_LOCKS=0 GIT_LITERAL_PATHSPECS=1 GIT_TERMINAL_PROMPT=0 LC_ALL=C`. Only `exec.ts` imports `child_process`. |
| Fetch (the one write) | `gitFetch()`: fixed argv, see CLAUDE.md and the decision below. `test/fetch.test.ts` runs it against a real local remote. |
| SVN over HTTP | `request()` allows `OPTIONS`, `GET`, and `REPORT` with a `log-report` body only; everything else throws before any I/O. |
| Working copy on disk | `.svn/` is read with `readFile`/`stat`. `wc.db` is opened `readOnly`, `?mode=ro&immutable=1`, `trusted_schema` off, and only `SELECT`/`PRAGMA user_version` run (`isReadQuery()`). A test bans fs write APIs across `src/`, and the fixture tests hash `.svn/` and `.git/` before and after. |
| `stitch:` provider | Registered `isReadonly`; write/delete/rename/createDirectory throw `NoPermissions`. |
| Editor buffers | Only `stitch.revertChange` edits a document (one `applyEdit`, buffer only). Nothing in `src/` calls `save`/`saveAll`/`saveAs`; `test/readonly.test.ts` checks both. |
| Messages | Suggestions (`safe.directory`, `svn cleanup`) are shown as text only, never run. |

Out of scope: the built-in Git extension still offers commit for git files; that's VS Code's, not Stitch's.

## Origin

The starting point was the svn-scm VS Code extension (`~/projects/svn-scm`, MIT, © Christopher Johnston). It only shows file history when a folder is opened:
- Repositories are found only by scanning workspace folders (`scanWorkspaceFolders` → `tryOpenRepository`).
- Nothing reacts to a single opened file.
- `ItemLogProvider` needs `getRepository(uri)` to return a repository.
- The views are hidden by `when: svnOpenRepositoryCount != 0`.
- svn-scm prompts to run `svn upgrade` when a working copy is older than the client. With a mixed 1.6/1.14 team that's dangerous, because an upgraded working copy can no longer be used by 1.6 clients.

The first ideas were to patch svn-scm: a history-only `RemoteRepository` fallback, or auto-opening the working copy for the active editor. Gutter diffs need a `SourceControl.quickDiffProvider`, which only a full `Repository` provides. The user then redefined the goal, and the result is a **new, smaller extension**.

## The user's goals

- **Single-file operations only:** file history, gutter diffs, and an "Open Changes" button. Fewer features than svn-scm.
- **Works anywhere:** any file opened locally or on a network drive, with or without a workspace folder.
- **SVN and Git in one extension.** VS Code's native git history isn't good enough.
- **Both SVN 1.6 and 1.14 working copies.**
- **No write features at all** (no commit etc.). This is a hard requirement.
- **Answers should be direct.** The user asks "how hard / how big / what do I get" questions and wants concrete answers with numbers.

## Decisions (with the reason for each)

| Decision | Why |
|---|---|
| New repo `~/projects/stitch`, extension name `stitch` | Stripping svn-scm (about 10,900 lines, 127 files, about 175 command/menu entries) would cost more than writing roughly 1.5k lines fresh. No svn-scm code has been copied so far; if any is copied later, keep its MIT notice. |
| Git: **history only**; the gutter and Open Changes stay with the built-in Git extension | Two quick diff providers draw duplicate gutter markers. |
| File History lives in the **Explorer** sidebar | User choice. |
| The view is titled **Stitch History** (was "File History") | User choice, so it's obvious the view comes from this extension and isn't confused with the built-in Timeline or other extensions' "File History". The view header already shows the current file's name. |
| **SVN needs no binary at all** | The user asked "why do we need an svn binary at all?". Local data (URL, revision, BASE content) is read from `.svn/`. History comes over plain HTTP, which is possible because the servers are **1.7+ (HTTPv2), http(s), anonymous read**. That removes the 1.6-vs-1.14 client mismatch entirely, and nothing ever touches the working copy. |
| `svn://` working copies get a URL-mapping setting, checked against the repo UUID | Some working copies were checked out via `svn://`. The servers also serve http(s). |
| Read-only is **enforced at each layer**, not just left out | User requirement. See "Read-only enforcement" above. |
| Git history is a **trunk view with expandable merges** | The user asked how merges are shown, then asked for an evaluation of a concept someone else suggested (below). |
| Clicking a merge diffs it against the **first parent only**; there are no extra merge diff actions | User choice. The options offered and declined were PR-style (merge-base ↔ M^2), vs branch tip (M^2 ↔ M), and `--remerge-diff`. Per-commit detail comes from expanding the merge. |
| **Enabled in untrusted workspaces** (`capabilities.untrustedWorkspaces.supported: true`) | User request. Safe because nothing in a repository can make Stitch run code: git's repo-configured programs are disabled in `src/git/exec.ts`, svn needs no program, and the two settings that pick a program or a server are `machine`-scoped (a workspace can't set them). `test/readonly.test.ts` pins all of this. Accepted residual: a crafted SVN working copy decides which URL gets read-only anonymous OPTIONS/GET/REPORT requests. Virtual workspaces are declared unsupported (Stitch needs real files). |
| **Incoming revisions above a "your working copy" separator** (svn) | User request, modelled on svn-scm's line between what you have and what you don't. |
| **Git incoming = the upstream branch as of the last fetch** | User choice among: (1) the remote-tracking branch as-is, (2) also `git ls-remote` to detect a newer server, (3) fetching into a throwaway repo, (4) host REST APIs. Fetching into the user's repo was first ruled out because it writes to `.git/`. (1) was built. Later reversed in part: see the Fetch button. |
| **A Fetch button that runs `git fetch` in the user's repo** (2026-11, the one exception to "never write") | User decision. Considered: `ls-remote` only (can say the branch moved, not whether *this file* changed), a throwaway repo with alternates and a `blob:none` fetch (file-specific without writing, but a whole subsystem), VS Code's Git API (only knows repos it opened, often off on network drives), host APIs. Fetch was chosen as the least risky write: it never touches the working tree, index, local branches or HEAD; it only adds objects and moves `refs/remotes/*` and `FETCH_HEAD`, and old positions stay in the reflog. It reuses the existing incoming rows, which become diffable. Guardrails: click only (no timer, no focus trigger); a fixed argv in `gitFetch()` outside the allowlist; `--no-prune --no-prune-tags --no-recurse-submodules`; `-c core.hooksPath=/dev/null` (fetch can run `reference-transaction`), `gc.auto=0`, `maintenance.auto=false`, `fetch.writeCommitGraph=false`, `protocol.ext.allow=never`; only the current branch's upstream remote; no credential prompts. Not offered on network paths (user request: `/drives/`, `/mnt/`, `/smb` and network mounts from `/proc/mounts` on Linux; UNC paths and drives other than C:/D: on Windows; both lists are machine-scoped settings), because writing `.git/` on a share is slow and the share may be shared. **Trusted workspaces only:** unlike reads, a fetch can run programs from the repo's config (`core.sshCommand`, `remote.*.uploadpack`, credential helpers) and they can't be blanked without breaking real setups. Accepted residual: in a trusted window, clicking Fetch for a file from an untrusted repo outside the workspace runs that repo's configured transport, like running `git fetch` there by hand. |
| **SVN Revert Change in the gutter peek, buffer only** (2026-11) | User request ("like svn-scm"). svn-scm and the built-in Git extension apply the edit and then save the file; Stitch only applies it, so "never writes" still holds for Stitch itself: the user decides whether to save, and Undo restores the hunk. Contributed to `scm/change/title` with `when: originalResourceScheme == stitch`, so it shows only for Stitch's SVN quick diff (git files keep the built-in Git buttons). VS Code passes `(uri, changes, index)`; `src/revertHunk.ts` replaces just that hunk's lines (not the whole document, so cursors, folding and the other hunks are untouched), handling a missing final newline on either side. The original text comes from `openTextDocument(stitch: BASE URI)`, the same model the quick diff compared against. Not checked in a running VS Code by the tests: the menu id, context key and argument shape follow the built-in Git extension. |
| **Stale fetches are flagged subtly in the view title** ("main.c · fetched 3 d ago"), not with a separator row or popup | User choice: only when the last fetch is more than max(1 h, 2 × autofetch period) old, so it never shows while autofetch runs. Detection uses `FETCH_HEAD`'s age rather than the `git.autofetch` setting (which can be on for repos VS Code's Git doesn't have open, or failing); the setting only stretches the threshold. Considered and dropped: always showing the "your branch" separator with click-to-fetch, and the remote URL in a tooltip (URLs can carry credentials, and reading one safely needs another fixed helper). |
| **A commit expands to its changed files only when it changed other files too** | User request: expanding to just the current file is useless. Merges keep expanding to merged commits, with the files grouped above them. |
| **At most one automatic SVN query per file per interval** (`stitch.svn.refreshInterval`, default 60 s) | User concern from svn-scm, which could get stuck hammering the server (a retry/checkFrequency setting). Stitch never polled, but switching between files and refocusing re-queried, and merge checks (`log -g`) re-ran per visit. Now histories are reused per file within the interval, failures aren't retried until it passes, and merge checks run once per file per session. Refresh always queries. |
| **Git histories are reused across file switches while the ref and upstream stay put** (2026-11) | Each git process is slow on network drives, and switching A → B → A re-ran the page log, the incoming log, the changed-files log and a `rev-list --count` per merge. Mirrors the SVN side (sources per file in `extension.ts`, the result inside the source) instead of a separate cache layer. Validity is the rev-parse state rather than a time interval: git is local, so the check is cheap and exact. The state is checked inside `top()`, which replaced the per-file `headByFile` map in `extension.ts`. Accepted residual: ref decorations on rows (tags, other branches) and the "your branch" name can be stale until the ref, its upstream, or Refresh reloads; before this, they went stale the same way while a file stayed open. |
| **wc.db is read with `node:sqlite`, read-only and immutable, in a worker thread; minimum VS Code 1.101** (2026-11) | User decision. sql.js copied the whole wc.db into memory and re-read it after every svn command; on large checkouts on network drives that meant reading tens to hundreds of MB over the corporate network. Real SQLite reads only the pages a lookup touches. The user chose to drop VS Code < 1.101 (over a year old) and sql.js instead of keeping both. `immutable=1` (no locks, no journal) was chosen over plain read-only because SQLite locking over SMB/NFS is slow and unreliable and a reader can't recover a hot journal anyway; the cost is that SQLite assumes the file doesn't change, so the worker reopens the connection when wc.db's stamp (mtime ns, size, inode) changes and retries a read that overlapped a write (3 tries, 200 ms apart). Accepted residual: a read during an svn write whose changes were partly flushed before Stitch looked can see that partial state until svn finishes (the next read after the stamp changes is correct). The worker exists because `node:sqlite` is synchronous: a hung share would freeze the extension host; the main side times out (`stitch.timeoutMs`) and replaces the worker. `terminate()` can't interrupt a thread blocked in a file system call, so an abandoned worker is tracked with the wc.db it was reading until it actually exits: reads of that same file fail at once (no new thread per editor switch), other wc.dbs get a fresh worker, and at most 4 stuck workers are allowed overall. When the share recovers the call returns, the thread exits and the file reads normally; no timer is involved. Checked with a FIFO as wc.db (`open()` blocks until a writer comes; `test/svn.test.ts`). Damaged working copies (truncated/garbage/empty wc.db, missing repository rows or pristine files) give an SvnError of kind `damaged` that suggests svn cleanup; an interrupted svn command (non-empty WORK_QUEUE) is logged and reading continues. These problems show in the Stitch History view, never as a popup from just opening a file (user request); a damaged BASE found by the gutter's background read shows above that file's history (`HistoryView.setWarning`). Popups only come from commands the user ran. Checked: Electron 35.0.2+ ships `node:sqlite` unflagged; on Node 22.15.1 an immutable read succeeds while another connection holds an exclusive lock, and the fixture tests pass. Windows drive and UNC URIs (`file:///C:/…`, `file:////server/share/…`) follow SQLite's URI rules but are untested. |
| `stitch.svn.urlMap` is `{ "<svn:// prefix>": "<http(s) prefix>" }` | Confirmed by the user, with a real example: `svn list svn://svn/project/` and `svn list http://svn/repos/project/` list the same repository, i.e. `{ "svn://svn": "http://svn/repos" }`. |
| SVN merges **expand to the merged revisions** (like `svn log -g`), matching the git view | The user left it to us ("up to you"). Done lazily per merge-candidate row, so the top-level log stays a cheap plain `svn log`. |
| `stitch:` is a read-only FileSystemProvider that returns raw **bytes** | Old SVN repos contain non-UTF-8 files. Returning bytes lets VS Code decode both sides of the diff the same way. svn-scm bundles jschardet/iconv for this reason. |

### The rejected merge concept (and why)
The suggested approach:
1. `git log --first-parent -- <path>` to get the trunk set.
2. `git log --topo-order --full-history -- <path>` to get everything.
3. Commits not in the trunk set are branch commits, indented under the merge listed before them.

It was rejected because:
- **Misclassified merges.** `--full-history` keeps merges that differ from *any* parent. A trunk merge whose branch never touched the file still differs from its second parent, so it gets labelled a "branch commit". This was **verified on git 2.54**: merge `MB` appears with `--full-history` and is hidden with `--first-parent`.
- **Topo order doesn't guarantee grouping.** Children are only promised to come before parents.
- **Sync merges become noise**, renames were missing, and the two query windows don't line up when paged.

The adopted alternative is a first-parent walk at every level, with lazy per-merge expansion (see "Git queries" above).

### Facts checked during the conversation
- Git 2.54, `--first-parent --follow --name-status`: a merge reports its rename against the first parent (`R087 g.txt h.txt`), and the range `M^2 ^M^1` works together with `--follow`.
- The `-z` output layout is `\x1e` + NUL-terminated header fields + `\0\n` + NUL-separated `STATUS\0path\0[path\0]`. It's parsed in `src/git/parse.ts`.
- **Fixture gotcha:** git treats edits to *adjacent* lines in two branches as a conflict. `test/gitFixture.ts` therefore edits even lines only, in 30-line files.
- **Extension Development Host run (2026-11-06):** the user ran milestone 1 and it "worked pretty well". The logs showed one Stitch error, `TreeError [stitch.history] Data tree node not found: 0/0:Merge pull request … (3 commits)`: without `TreeItem.id`, VS Code keys rows by label, so updating the label broke the refresh. Fixed with stable ids. The other error in that log (`Missing dataLength in event`, from `node:inspector`) comes from the debugger, not Stitch.
- **SVN working copies (checked against real clients 1.6.12, 1.8.10, 1.14.5):**
  - wc.db `PRAGMA user_version` is 31 for 1.8 and 1.14. Checksums are `$sha1$<hex>`. Pristines are uncompressed at `.svn/pristine/<2>/<sha1>.svn-base`. `NODES.last_mod_time` and `changed_date` are microseconds since the epoch. A copy is an `op_depth = 1` row whose `repos_path`/`revision` are the copy source. A plain add has an `op_depth = 1` row with no repository and no checksum.
  - Entries format 10 (1.6): line-based fields in libsvn_wc's `read_entry` order, records separated by `\f\n`, trailing empty fields omitted. File records inherit `revision`/`url`/`repos`/`uuid` from the folder's own record. `text-time` has microseconds; `working-size` is the translated size.
  - A file with `svn:eol-style CRLF` set before its first commit has a CRLF pristine; the "normal form is LF" assumption does not hold for every pristine.
  - `svn info` on a plain add: 1.6 omits the UUID; 1.8+ prints the repository's.
  - mod_dav_svn (1.14): `OPTIONS` returns `SVN-Repository-Root` (a path), `SVN-Rev-Root-Stub`, `SVN-Youngest-Rev`, `SVN-Repository-UUID`. `log-report` changed paths carry `node-kind`, `text-mods`, `prop-mods`, `copyfrom-*`, and list **every** path the revision changed, not just the file. The log does not resolve peg → operative revision for you. Merged revisions follow a `<S:has-children/>` item and end with an item whose `version-name` is `-1`. `GET …/!svn/rvr/<rev>/<path>?kw=1` returns keyword-expanded content identical to `svn cat`.
  - In the test repository, `svn log -g -r 8` (merge of `branches/feat`, which changed the file in r5 and r7) lists **no** merged revisions, from the real client and from the server alike, while r15 (merge of `branches/two`) lists r14 and the branch creation r13. Stitch matches the server; a merge row with nothing behind it is simply not expandable. Why r8 is empty wasn't investigated.
  - `$Date$` is expanded by the client in its local time zone (`%Y-%m-%d %H:%M:%S %z (%a, %d %b %Y)`); `$Id$` uses UTC with a `Z`.

## Environment

- Dev machine: Linux, Node 22, git 2.54, VS Code 1.143, **podman** available, **no svn installed**. Images that work: `docker.io/debian/eol:squeeze` (svn 1.6.12, apt from archive.debian.org with `Acquire::Check-Valid-Until=false`), `docker.io/debian/eol:jessie` (1.8.10), `docker.io/library/alpine:3.20` (1.14.5, `apk add subversion`). The test server is Apache + mod_dav_svn 1.14 in `test/fixtures/svn-server/` (Containerfile, `build-repo.sh` with the repository history and the real client's expected output, an Apache config that denies everything but GET/PROPFIND/OPTIONS/REPORT), started by `test/svnServer.ts`.
- VS Code engine target: `^1.101.0` (Electron 35, Node 22.15: the first with `node:sqlite` enabled; see the decision below). Tool versions are pinned in `package.json`.

## Current state

- Released features: Git and SVN history with expandable merges and changed files, incoming changes (svn and git), the unpushed marker (git, unreleased), the Fetch button and fetch-age note (git), SVN gutter and Open Changes, Copy Diff. See `CHANGELOG.md`.
- `npm test` runs in a few seconds (the SVN server tests start a podman container and are skipped without podman). No runtime dependencies: wc.db is read with Node's built-in `node:sqlite`.
- Git history has been run in an Extension Development Host. **Not yet checked by hand:** the SVN features against the real servers, including an `svn://` working copy with `stitch.svn.urlMap` set, and the `.vsix` installed on the machine with the real working copies (the "Stitch" output channel shows each request if something fails).

## Open questions

- **HTTP Basic auth** is not needed now (the servers allow anonymous read). It's a possible later addition.
- **Incoming after a move on the server:** incoming revisions are looked up by the file's BASE path at HEAD; if the file moved on the server, only a note is shown. Following it would need `get-locations` or a forward search, which svn doesn't offer cheaply.
- **Feature ideas offered and not yet chosen:** see [IDEAS.md](IDEAS.md).
