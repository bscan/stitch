# Stitch

A read-only VS Code extension: file history, plus (for SVN) gutter diffs and Open Changes, for any file opened anywhere. It supports SVN (1.6 and 1.8–1.14 working copies, no svn binary) and Git (history only).

**Read first:** `docs/PLAN.md` (the approved plan and implementation status) and `docs/CONTEXT.md` (why decisions were made, facts that were checked, open questions).

## Commands

- `npm test`: compiles `test/` (with the `src/` files it imports) to `out/` and runs mocha. The git tests build a real fixture repo in a temp folder. The SVN tests unpack `test/fixtures/svn*.tar.gz` (working copies made by real 1.6/1.8/1.14 clients) and compare against those clients' own `svn info`/`svn cat`/`svn status` output.
- The SVN history tests (`test/dav.test.ts`) build and start `test/fixtures/svn-server` (Apache + mod_dav_svn 1.14) with podman; set `STITCH_NO_PODMAN=1` to skip them.
- `test/fixtures/make-svn-fixtures.sh [svn16|svn18|svn114]`: rebuilds those tarballs with podman (there is no svn on the dev machine). Commit the regenerated tarballs.
- `npm run build`: esbuild bundle to `dist/extension.js` (plus `dist/sql-wasm.wasm`). `npm run package`: `.vsix` in `dist/`. `npm run typecheck`: `tsc --noEmit`.
- F5 runs the extension in a development host (`.vscode/launch.json`).

## Rules that must hold

- **Never write.** No command may modify a working copy, a repository, git/svn config, or files on disk. Specifically:
  - All git calls go through `src/git/exec.ts` (subcommand allowlist + banned arguments).
  - All SVN HTTP calls go through `request()` in `src/svn/dav.ts` (methods `OPTIONS`/`GET`/`REPORT`, and `log-report` is the only REPORT). Only `dav.ts` may import network modules.
  - `test/readonly.test.ts` must keep passing. Update its command allowlist when a read command is added.
- **No svn binary.** SVN local data is read from `.svn/` directly; history comes over HTTP.
- Modules other than `src/extension.ts`, `src/content.ts`, `src/quickDiff.ts` and `src/history/historyView.ts` must not import `vscode`, so they stay testable with plain mocha (checked by `test/readonly.test.ts`).
- Commit only when the user asks.
