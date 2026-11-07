# Context: how Stitch came about, and what was decided

This is a compacted record of the design conversation behind Stitch, kept for whoever picks the work up next. `docs/PLAN.md` is the plan itself. This file records **why** things are the way they are, the facts that were checked, and the questions still open.

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
| Read-only is **enforced at each layer**, not just left out | User requirement. See the "Read-only guarantee" table in PLAN.md. |
| Git history is a **trunk view with expandable merges** | The user asked how merges are shown, then asked for an evaluation of a concept someone else suggested (below). |
| Clicking a merge diffs it against the **first parent only**; there are no extra merge diff actions | User choice. The options offered and declined were PR-style (merge-base ↔ M^2), vs branch tip (M^2 ↔ M), and `--remerge-diff`. Per-commit detail comes from expanding the merge. |
| **Enabled in untrusted workspaces** (`capabilities.untrustedWorkspaces.supported: true`) | User request. Safe because nothing in a repository can make Stitch run code: git's repo-configured programs are disabled in `src/git/exec.ts`, svn needs no program, and the two settings that pick a program or a server are `machine`-scoped (a workspace can't set them). `test/readonly.test.ts` pins all of this. Accepted residual: a crafted SVN working copy decides which URL gets read-only anonymous OPTIONS/GET/REPORT requests. Virtual workspaces are declared unsupported (Stitch needs real files). |
| **Incoming revisions above a "your working copy" separator** (svn) | User request, modelled on svn-scm's line between what you have and what you don't. |
| **Git incoming = the upstream branch as of the last fetch** | User choice among: (1) the remote-tracking branch as-is, (2) also `git ls-remote` to detect a newer server, (3) fetching into a throwaway repo, (4) host REST APIs. Fetching into the user's repo was ruled out because it writes to `.git/`. (1) was built; (2) is a possible opt-in later if staleness matters (it would start network/ssh/credential activity). |
| **A commit expands to its changed files only when it changed other files too** | User request: expanding to just the current file is useless. Merges keep expanding to merged commits, with the files grouped above them. |
| **At most one automatic SVN query per file per interval** (`stitch.svn.refreshInterval`, default 60 s) | User concern from svn-scm, which could get stuck hammering the server (a retry/checkFrequency setting). Stitch never polled, but switching between files and refocusing re-queried, and merge checks (`log -g`) re-ran per visit. Now histories are reused per file within the interval, failures aren't retried until it passes, and merge checks run once per file per session. Refresh always queries. |
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

The adopted alternative is a first-parent walk at every level, with lazy per-merge expansion (see PLAN.md).

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

- Dev machine: Linux, Node 22, git 2.54, VS Code 1.143, **podman** available, **no svn installed**. Images that work: `docker.io/debian/eol:squeeze` (svn 1.6.12, apt from archive.debian.org with `Acquire::Check-Valid-Until=false`), `docker.io/debian/eol:jessie` (1.8.10), `docker.io/library/alpine:3.20` (1.14.5, `apk add subversion`). Milestone 4 still needs an Apache mod_dav_svn 1.14 server with anonymous read.
- VS Code engine target: `^1.85.0`. Tool versions are pinned in `package.json`.

## State at handoff

- Milestones 1–5 are implemented, plus incoming changes (svn and git) and changed files (128 tests). `npm test` takes about 4 s (the SVN server tests start a podman container and skip without podman). `npm run build` bundles to `dist/extension.js` and copies `sql-wasm.wasm` next to it. Runtime dependency: `sql.js` 1.12.0 (MIT).
- Milestone 1 has been run in an Extension Development Host (and the author bubbles and view name since); the SVN features (milestones 2–4) and milestone 5 have not.
- **Not yet done:**
  - Run the SVN features in an Extension Development Host (F5) against the real servers, including an `svn://` working copy with `stitch.svn.urlMap` set.
  - Install the `.vsix` (`npm run package`) on the machine with the real SVN working copies and servers; the "Stitch" output channel shows each request if something fails.
  - Make a first git commit. The repo was initialized with all files untracked, and the user commits only when they ask.

## Open questions

- **HTTP Basic auth** is not needed now (the servers allow anonymous read). It's a possible later addition.
- **Incoming after a move on the server:** incoming revisions are looked up by the file's BASE path at HEAD; if the file moved on the server, only a note is shown. Following it would need `get-locations` or a forward search, which svn doesn't offer cheaply.
- **Other feature ideas offered and not yet chosen:** compare two selected revisions, blame/annotate (large for svn: `file-revs` + client-side deltas), folder history, a status-bar item for svn files, history filter, "open in web viewer", explorer badges, HTTP Basic auth.
