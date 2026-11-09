import * as path from "path";
import * as vscode from "vscode";
import { fileDiff, previousDiff, Side } from "./backend";
import { Loader, RevisionFileSystem, SCHEME, sideUri } from "./content";
import { GitError, gitFetch, GitOptions } from "./git/exec";
import { fetchBlockedReason, readMounts } from "./git/fetchPolicy";
import { GitRepo } from "./git/gitBackend";
import { describeError } from "./errors";
import { CommitNode, HistoryView, Node, Target } from "./history/historyView";
import { fetchNote, staleFetchMs } from "./history/format";
import { decodeText, formatDiff, SideText } from "./history/patch";
import { GitSource } from "./history/source";
import { SvnQuickDiff } from "./quickDiff";
import { LineChange, revertHunk } from "./revertHunk";
import { log, setLogSink } from "./log";
import { Resolver } from "./resolver";
import { DavClient, RepoInfo } from "./svn/dav";
import { SvnError, SvnRepo } from "./svn/svnBackend";
import { closeWcDb } from "./svn/wcdb";
import { SvnSource, svnDisplayPath } from "./svn/svnHistory";
import { mapRepoUrl } from "./svn/urlMap";

const config = () => vscode.workspace.getConfiguration("stitch");
const timeoutMs = () => config().get<number>("timeoutMs") ?? 15000;
/** Minimum time between automatic server queries for one file (and retries after a failure). */
const svnIntervalMs = () => Math.max(0, config().get<number>("svn.refreshInterval") ?? 60) * 1000;

function gitOptions(): GitOptions {
  return { gitPath: config().get<string>("git.path") || "git", timeoutMs: timeoutMs() };
}

export function activate(context: vscode.ExtensionContext): void {
  // Output panel → "Stitch": every git command and SVN request, with timings and failures.
  const output = vscode.window.createOutputChannel("Stitch", { log: true });
  context.subscriptions.push(output);
  setLogSink((level, message) => output[level](message));
  log.info(`Stitch ${context.extension.packageJSON.version} activated`);

  const resolver = new Resolver();

  // ---- git -----------------------------------------------------------------
  // `rev-parse --show-toplevel --show-prefix` run in a file's own folder gives
  // both the repo root and the file's path prefix, so results are cached per
  // folder. Repo objects are shared per root (the content provider looks them up by root).
  const openByDir = new Map<string, Promise<{ repo: GitRepo; prefix: string }>>();
  const reposByRoot = new Map<string, GitRepo>();
  const refByRoot = new Map<string, string>();
  /** Per file: "<branch hash> <upstream hash>" when its history was loaded; a change means reload. */
  const headByFile = new Map<string, string>();
  const gitState = async (repo: GitRepo, ref: string) => {
    const [head, up] = await Promise.all([repo.resolve(ref).catch(() => ""), repo.upstream(ref).catch(() => undefined)]);
    return `${head} ${up?.hash ?? ""}`;
  };

  const openRepo = async (dir: string) => {
    let p = openByDir.get(dir);
    if (!p) {
      p = GitRepo.open(dir, gitOptions).then(({ repo, prefix }) => {
        const shared = reposByRoot.get(repo.root) ?? repo;
        reposByRoot.set(repo.root, shared);
        return { repo: shared, prefix };
      });
      p.catch(() => openByDir.delete(dir));
      openByDir.set(dir, p);
    }
    return p;
  };
  const repoForRoot = async (root: string) => reposByRoot.get(root) ?? (await openRepo(root)).repo;

  // ---- svn -----------------------------------------------------------------
  // Working copies, by the folder holding the nearest .svn marker (the WC root
  // for 1.7+; any versioned folder for 1.6). Shared per WC root.
  const svnByDir = new Map<string, Promise<SvnRepo>>();
  const svnByRoot = new Map<string, SvnRepo>();
  const svnRepo = (dir: string) => {
    let p = svnByDir.get(dir);
    if (!p) {
      p = SvnRepo.open(dir, timeoutMs).then((repo) => {
        const shared = svnByRoot.get(repo.root) ?? repo;
        svnByRoot.set(repo.root, shared);
        return shared;
      });
      p.catch(() => svnByDir.delete(dir));
      svnByDir.set(dir, p);
    }
    return p;
  };
  let dav = new DavClient(timeoutMs, svnIntervalMs);
  /**
   * History sources per file, kept across file switches: switching back reuses the
   * loaded history (and its merge checks) instead of asking the server again.
   */
  const svnSources = new Map<string, SvnSource>();
  const svnSource = (info: RepoInfo, root: string, reposPath: string, peg: number, file: vscode.Uri) => {
    const key = `${file.toString()}|${info.rootUrl}|${reposPath}|${peg}`;
    let src = svnSources.get(key);
    if (src) svnSources.delete(key); // re-inserted below: most recently used last
    src ??= new SvnSource(dav, info, root, reposPath, peg, svnIntervalMs);
    svnSources.set(key, src);
    if (svnSources.size > 30) svnSources.delete(svnSources.keys().next().value as string);
    return src;
  };
  /** The SVN file the editor shows, if any (for Open Changes and the modified flag). */
  let svnCurrent: { file: vscode.Uri; repo: SvnRepo } | undefined;

  /** Per repo root: why the Fetch button isn't offered there (a network path), or undefined. */
  const fetchBlockedByRoot = new Map<string, Promise<string | undefined>>();
  const fetchBlocked = (repo: GitRepo) => {
    let p = fetchBlockedByRoot.get(repo.root);
    if (!p) {
      p = (async () => {
        const [gitDir, mounts] = await Promise.all([repo.commonDir().catch(() => repo.root), readMounts()]);
        return fetchBlockedReason([repo.root, gitDir], {
          excludePaths: config().get<string[]>("git.fetchExcludePaths") ?? [],
          localDrives: config().get<string[]>("git.fetchLocalDrives") ?? [],
          platform: process.platform,
          mounts,
        });
      })();
      fetchBlockedByRoot.set(repo.root, p);
    }
    return p;
  };
  /** Whether the current file's history view shows the Fetch button. */
  const setCanFetch = (on: boolean) => void vscode.commands.executeCommand("setContext", "stitch.canFetch", on);
  const updateCanFetch = async (t: Target) => {
    const ok = t.source instanceof GitSource && vscode.workspace.isTrusted && !(await fetchBlocked(t.source.repo));
    if (history.current === t) setCanFetch(ok);
  };
  let fetching = false;

  /**
   * "· fetched 3 d ago" / "· never fetched" in the view title when the branch has an
   * upstream on a remote and the last fetch (by anything: autofetch, a pull, a terminal,
   * the Fetch button) isn't recent. Shown on network paths too: it's about how current
   * the incoming commits are, not about the button.
   */
  const updateFetchNote = async (t: Target) => {
    if (!(t.source instanceof GitSource)) return;
    const src = t.source;
    let note: string | undefined;
    try {
      if (await src.repo.upstreamRemote(src.ref)) {
        const git = vscode.workspace.getConfiguration("git", vscode.Uri.file(src.repo.root));
        note = fetchNote(await src.repo.lastFetch(), staleFetchMs(git.get("autofetch"), git.get("autofetchPeriod")));
      }
    } catch {
      note = undefined;
    }
    history.setNote(t, note);
  };

  const clearRepos = () => {
    fetchBlockedByRoot.clear();
    openByDir.clear();
    reposByRoot.clear();
    svnByDir.clear();
    svnByRoot.clear();
    svnSources.clear();
    dav = new DavClient(timeoutMs, svnIntervalMs);
  };

  const history = new HistoryView(() => config().get<number>("logLimit") ?? 40);

  const load: Loader = async ({ vcs, root, side, remote, keywords }) => {
    if (vcs === "svn") {
      if (side.kind === "base") {
        const repo = await svnRepo(root);
        const node = await repo.wc.node(side.path);
        if (!node) throw new Error(`${side.path} is not versioned`);
        // The gutter reads BASE silently, so a damaged .svn would just mean "no markers".
        // Say why in the history view instead (no popup: this runs whenever a file opens).
        const file = vscode.Uri.file(path.join(repo.root, side.path));
        try {
          const data = await repo.original(node);
          history.setWarning(file, undefined);
          return data;
        } catch (e) {
          if (e instanceof SvnError && e.kind === "damaged") history.setWarning(file, describeError(e));
          throw e;
        }
      }
      if (side.kind !== "rev" || !remote) throw new Error("bad svn side");
      return dav.get(await dav.options(remote), Number(side.rev), side.path, { keywords });
    }
    if (side.kind !== "rev") throw new Error("git has no BASE side");
    return (await repoForRoot(root)).show(side.rev, side.path);
  };
  const fsProvider = new RevisionFileSystem(load);

  /** The BASE URI of an SVN file, if `root` is its working copy and svn tracks it. */
  const svnBaseUri = async (file: vscode.Uri, root?: string) => {
    if (file.scheme !== "file") return undefined;
    const marker = await resolver.forFile(file.fsPath);
    if (marker?.kind !== "svn") return undefined;
    const repo = await svnRepo(marker.dir);
    if (root !== undefined && repo.root !== root) return undefined; // nested working copy
    const node = await repo.node(file.fsPath);
    if (!node) return undefined;
    return { repo, node, uri: sideUri("svn", repo.root, { kind: "base", path: repo.relPath(file.fsPath) }) };
  };
  const quickDiff = new SvnQuickDiff(async (file, root) => (await svnBaseUri(file, root).catch(() => undefined))?.uri);

  const setSvnModified = (on: boolean) => void vscode.commands.executeCommand("setContext", "stitch.svnModified", on);
  const setKind = (kind: string | undefined) => {
    void vscode.commands.executeCommand("setContext", "stitch.kind", kind);
    if (kind !== "git") setCanFetch(false);
  };

  const updateSvnModified = async () => {
    const cur = svnCurrent;
    if (!cur) return setSvnModified(false);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === cur.file.toString());
    let modified = doc?.isDirty ?? false;
    if (!modified) {
      try {
        const node = await cur.repo.node(cur.file.fsPath);
        modified = node !== undefined && (await cur.repo.isModified(cur.file.fsPath, node));
      } catch {
        modified = false;
      }
    }
    if (svnCurrent === cur) setSvnModified(modified);
  };

  /** After an svn update/commit/revert elsewhere: re-read BASE for gutters and open diffs. Returns whether anything changed. */
  const checkSvnMetadata = async () => {
    let any = false;
    for (const repo of svnByRoot.values()) {
      if (await repo.changed()) {
        fsProvider.baseChanged(repo.root);
        any = true;
      }
    }
    return any;
  };

  const followSvn = async (file: vscode.Uri, dir: string) => {
    let repo: SvnRepo;
    let node;
    try {
      repo = await svnRepo(dir);
      quickDiff.ensure(repo.root);
      node = await repo.node(file.fsPath);
    } catch (e) {
      svnCurrent = undefined;
      setSvnModified(false);
      history.showMessage(describeError(e), file);
      return;
    }
    if (!node) {
      svnCurrent = undefined;
      setSvnModified(false);
      history.showMessage("svn doesn't track this file (unversioned or ignored).", file);
      return;
    }
    svnCurrent = { file, repo };
    void updateSvnModified();
    if (node.schedule === "added") {
      history.showMessage("This file is scheduled for addition, so it has no history yet.", file);
      return;
    }
    if (!node.reposRoot || node.reposPath === undefined || node.revision === undefined) {
      history.showMessage("svn's metadata for this file has no repository URL or revision; the working copy may be damaged (svn cleanup can help).", file);
      return;
    }
    // History starts at the file's BASE revision, like `svn log` on a working-copy file.
    const cur = history.current;
    if (
      cur?.file.toString() === file.toString() &&
      cur.source instanceof SvnSource &&
      cur.source.peg === node.revision &&
      cur.source.reposPath === node.reposPath
    ) {
      return;
    }
    const mapping = mapRepoUrl(node.reposRoot, config().get<Record<string, string>>("svn.urlMap"));
    if (mapping.kind === "http" && mapping.mapped) log.info(`${node.reposRoot} mapped to ${mapping.url} (stitch.svn.urlMap)`);
    if (mapping.kind === "needsMapping") {
      log.info(`${node.reposRoot}: no stitch.svn.urlMap entry, so no history`);
      history.showAction(
        `Add a URL mapping for ${mapping.url} to see history (click to open settings)`,
        { command: "workbench.action.openSettings", title: "Open Settings", arguments: ["stitch.svn.urlMap"] },
        file
      );
      return;
    }
    if (mapping.kind === "unsupported") {
      history.showMessage(mapping.reason, file);
      return;
    }
    history.showMessage("Contacting the SVN server…", file);
    try {
      const info = await dav.options(mapping.url);
      if (node.uuid && info.uuid !== node.uuid) {
        log.warn(`${mapping.url} has repository UUID ${info.uuid}; the working copy at ${repo.root} has ${node.uuid}`);
        history.showMessage(
          mapping.mapped
            ? `The URL mapping for ${node.reposRoot} points at a different repository (${mapping.url} has UUID ${info.uuid}, the working copy has ${node.uuid}).`
            : `${mapping.url} is a different repository than this working copy's (UUID ${info.uuid}, expected ${node.uuid}).`,
          file
        );
        return;
      }
      if (svnCurrent?.file.toString() !== file.toString()) return; // the user moved on meanwhile
      const source = svnSource(info, repo.root, node.reposPath, node.revision, file);
      history.setTarget({ file, source, description: path.basename(file.fsPath) });
    } catch (e) {
      if (svnCurrent?.file.toString() === file.toString()) history.showMessage(describeError(e), file);
    }
  };

  /** Points the history view at a file. */
  const follow = async (file: vscode.Uri) => {
    if (file.scheme !== "file") return;
    const marker = await resolver.forFile(file.fsPath);
    if (!marker) {
      svnCurrent = undefined;
      setSvnModified(false);
      setKind(undefined);
      history.showMessage("This file isn't under version control.", file);
      return;
    }
    setKind(marker.kind);
    if (marker.kind === "svn") {
      await followSvn(file, marker.dir);
      return;
    }
    svnCurrent = undefined;
    setSvnModified(false);
    try {
      const { repo, prefix } = await openRepo(path.dirname(file.fsPath));
      const relPath = GitRepo.relPath(prefix, path.basename(file.fsPath));
      const ref = refByRoot.get(repo.root) ?? "HEAD";
      const cur = history.current;
      if (cur?.file.toString() === file.toString() && cur.source instanceof GitSource && cur.source.ref === ref) return;
      const target = gitTarget(file, repo, relPath, ref);
      history.setTarget(target);
      void updateCanFetch(target);
      void updateFetchNote(target);
      headByFile.set(file.toString(), await gitState(repo, ref));
    } catch (e) {
      history.showMessage(describeError(e), file);
    }
  };

  const gitTarget = (file: vscode.Uri, repo: GitRepo, relPath: string, ref: string): Target => {
    const name = path.basename(file.fsPath);
    return { file, source: new GitSource(repo, relPath, ref), description: ref === "HEAD" ? name : `${name} @ ${ref}` };
  };

  const followActive = () => {
    const editor = vscode.window.activeTextEditor;
    // Keep the current history while a diff, output panel or similar has focus.
    if (editor?.document.uri.scheme === "file") void follow(editor.document.uri);
  };

  /** svn: reloads the history if the server has new revisions. Asks at most once per file per interval. */
  const refreshIfServerMoved = async () => {
    const t = history.current;
    if (!t || !(t.source instanceof SvnSource)) return;
    if ((await t.source.needsReload()) && history.current === t) history.reload();
  };

  /**
   * git: reloads the history only if the starting ref or its upstream moved (a commit,
   * pull, checkout, or a fetch by VS Code's Git extension or a terminal).
   */
  const refreshIfMoved = async () => {
    const t = history.current;
    if (!t || !(t.source instanceof GitSource)) return;
    void updateFetchNote(t); // time passes, and something else may have fetched
    const src = t.source;
    const key = t.file.toString();
    const state = await gitState(src.repo, src.ref);
    if (state !== headByFile.get(key) && history.current === t) {
      headByFile.set(key, state);
      history.reload();
    }
  };

  const commitArg = (node: Node | undefined): CommitNode | undefined => (node?.type === "commit" ? node : undefined);

  /**
   * stitch: URI for a side of the current history. SVN keywords are expanded only
   * when comparing with (or standing in for) the working file; between revisions
   * they'd mark every $Rev$ line as changed.
   */
  const uriFor = (t: Target, side: Side, keywords = false) =>
    t.source instanceof SvnSource
      ? sideUri(
          "svn",
          t.source.root,
          side,
          { remote: t.source.info.rootUrl, keywords },
          svnDisplayPath(t.source.root, t.file.fsPath, t.source.reposPath, side.path)
        )
      : sideUri("git", t.source.root, side);

  const revName = (t: Target, rev: string) => (t.source.vcs === "svn" ? `r${rev}` : rev.slice(0, 7));

  context.subscriptions.push(
    history,
    quickDiff,
    vscode.workspace.registerFileSystemProvider(SCHEME, fsProvider, { isReadonly: true, isCaseSensitive: true }),

    vscode.window.onDidChangeActiveTextEditor(() => {
      followActive();
      // Autofetch can move origin/… while the window stays focused: re-check on file switches too.
      void refreshIfMoved();
    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (!s.focused) return;
      // The view shows an error or a message (server was unreachable, git timed out, …): try again.
      if (!history.current) followActive();
      void refreshIfMoved();
      void refreshIfServerMoved();
      void checkSvnMetadata().then((changed) => {
        void updateSvnModified();
        if (changed && svnCurrent) followActive(); // an update may have moved BASE
      });
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (svnCurrent && doc.uri.toString() === svnCurrent.file.toString()) void updateSvnModified();
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      // Becoming dirty shows Open Changes at once; becoming clean (undo) needs a disk check.
      if (svnCurrent && e.document.uri.toString() === svnCurrent.file.toString()) {
        if (e.document.isDirty) setSvnModified(true);
        else void updateSvnModified();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("git.autofetch") || e.affectsConfiguration("git.autofetchPeriod")) {
        if (history.current) void updateFetchNote(history.current);
      }
      if (!e.affectsConfiguration("stitch")) return;
      clearRepos();
      if (svnCurrent) {
        history.showMessage("Reloading…");
        followActive();
      } else {
        history.reload();
      }
    }),

    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      if (history.current) void updateCanFetch(history.current);
    }),

    // The one command that writes: `git fetch <upstream remote>` (see gitFetch in src/git/exec.ts).
    vscode.commands.registerCommand("stitch.fetch", async () => {
      const t = history.current;
      if (!t || !(t.source instanceof GitSource) || fetching) return;
      const src = t.source;
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showInformationMessage("Stitch fetches only in a trusted workspace.");
        return;
      }
      const why = await fetchBlocked(src.repo);
      if (why) {
        void vscode.window.showInformationMessage(`Stitch doesn't fetch here: ${why}.`);
        return;
      }
      const remote = await src.repo.upstreamRemote(src.ref).catch(() => undefined);
      if (!remote) {
        const branch = await src.repo.branchName(src.ref).catch(() => src.ref);
        void vscode.window.showInformationMessage(
          branch === "HEAD"
            ? "Nothing to fetch: HEAD is detached, so it has no upstream branch."
            : `Nothing to fetch: ${branch} has no upstream branch on a remote.`
        );
        return;
      }
      fetching = true;
      try {
        const before = await src.repo.upstream(src.ref).catch(() => undefined);
        await vscode.window.withProgress(
          { location: { viewId: "stitch.history" }, title: `Fetching ${remote}…` },
          () => gitFetch(gitOptions(), src.repo.root, remote)
        );
        const after = await src.repo.upstream(src.ref).catch(() => undefined);
        vscode.window.setStatusBarMessage(
          after && after.hash !== before?.hash ? `Stitch: fetched ${remote}, ${after.name} moved` : `Stitch: fetched ${remote}, ${after?.name ?? "upstream"} unchanged`,
          5000
        );
        if (history.current === t) {
          // Reload even if nothing moved: the separator's "fetched …" time changed.
          headByFile.set(t.file.toString(), await gitState(src.repo, src.ref));
          history.reload();
          void updateFetchNote(t);
        }
      } catch (e) {
        const msg =
          e instanceof GitError && e.kind === "auth"
            ? `Couldn't fetch ${remote}: it needs credentials, and Stitch can't ask for them. Fetch once from a terminal or set up a credential helper or ssh key.`
            : `Couldn't fetch ${remote}: ${describeError(e)}`;
        const choice = await vscode.window.showErrorMessage(msg, "Show Log");
        if (choice) output.show(true);
      } finally {
        fetching = false;
      }
    }),

    vscode.commands.registerCommand("stitch.refresh", () => {
      resolver.clear();
      for (const root of svnByRoot.keys()) fsProvider.baseChanged(root);
      const wasSvn = svnCurrent !== undefined || history.current?.source.vcs === "svn";
      clearRepos();
      const t = history.current;
      if (t && !wasSvn && t.source instanceof GitSource) {
        const src = t.source;
        history.reload();
        void gitState(src.repo, src.ref).then((h) => headByFile.set(t.file.toString(), h));
        void updateFetchNote(t);
      } else {
        history.showMessage("Reloading…");
        followActive();
      }
    }),

    vscode.commands.registerCommand("stitch.openChanges", async (uri?: vscode.Uri) => {
      const file = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
      if (!file) return;
      let base;
      try {
        base = await svnBaseUri(file);
      } catch (e) {
        void vscode.window.showWarningMessage(describeError(e));
        return;
      }
      if (!base) {
        void vscode.window.showInformationMessage("svn doesn't track this file.");
        return;
      }
      const name = path.basename(file.fsPath);
      const left = base.node.schedule === "added" ? "(added)" : `BASE r${base.node.revision}`;
      await vscode.commands.executeCommand("vscode.diff", base.uri, file, `${name} (${left} ↔ Working)`);
    }),

    // The quick diff peek's "Revert Change" button (scm/change/title). VS Code passes the
    // editor's URI, every hunk in it, and the index of the one shown. This only edits the
    // editor buffer: nothing is saved, so the file on disk changes only if the user saves,
    // and Undo puts the hunk back.
    vscode.commands.registerCommand("stitch.revertChange", async (uri?: vscode.Uri, changes?: LineChange[], index?: number) => {
      if (!(uri instanceof vscode.Uri) || !Array.isArray(changes) || typeof index !== "number") return;
      const change = changes[index];
      if (!change) return;
      const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
      if (!editor) return;
      let base;
      try {
        base = await svnBaseUri(uri);
      } catch (e) {
        void vscode.window.showWarningMessage(describeError(e));
        return;
      }
      if (!base) return;
      const doc = editor.document;
      const original = await vscode.workspace.openTextDocument(base.uri);
      const r = revertHunk(original.getText(), doc.getText(), change);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end)), r.text);
      await vscode.workspace.applyEdit(edit);
    }),

    vscode.commands.registerCommand("stitch.loadMore", (node: Node) => {
      if (node?.type === "more") void history.loadMore(node);
    }),

    vscode.commands.registerCommand("stitch.diffWithPrevious", async (node?: Node) => {
      const n = commitArg(node);
      const t = history.current;
      if (!n || !t) return;
      const c = n.commit;
      const { left, right } = previousDiff(c);
      const leftName = left.kind === "rev" ? (t.source.vcs === "svn" ? `r${left.rev}` : `${c.shortRev}^`) : "(none)";
      const rightName = right.kind === "rev" ? c.shortRev : "(deleted)";
      await vscode.commands.executeCommand(
        "vscode.diff",
        uriFor(t, left),
        uriFor(t, right),
        `${path.posix.basename(c.path)} (${leftName} ↔ ${rightName})`,
        { preview: true }
      );
    }),

    vscode.commands.registerCommand("stitch.diffFile", async (node?: Node) => {
      const t = history.current;
      if (node?.type !== "file" || !t) return;
      const { commit: c, file: f } = node;
      const { left, right } = fileDiff(c, f);
      const leftName = left.kind === "rev" ? (t.source.vcs === "svn" ? `r${left.rev}` : `${c.shortRev}^`) : "(none)";
      const rightName = right.kind === "rev" ? c.shortRev : "(deleted)";
      await vscode.commands.executeCommand(
        "vscode.diff",
        uriFor(t, left),
        uriFor(t, right),
        `${path.posix.basename(f.path)} (${leftName} ↔ ${rightName})`,
        { preview: true }
      );
    }),

    vscode.commands.registerCommand("stitch.diffWithWorking", async (node?: Node) => {
      const n = commitArg(node);
      const t = history.current;
      if (!n || !t) return;
      const c = n.commit;
      const side: Side = c.status?.startsWith("D") ? { kind: "empty", path: c.path } : { kind: "rev", rev: c.rev, path: c.path };
      await vscode.commands.executeCommand(
        "vscode.diff",
        uriFor(t, side, true),
        t.file,
        `${path.basename(t.file.fsPath)} (${revName(t, c.rev)} ↔ working file)`,
        { preview: true }
      );
    }),

    vscode.commands.registerCommand("stitch.openRevision", async (node?: Node) => {
      const n = commitArg(node);
      const t = history.current;
      if (!n || !t) return;
      const c = n.commit;
      // For a commit that deleted the file, open the version just before the deletion.
      const side: Side =
        c.status?.startsWith("D") && c.parents[0] && c.oldPath
          ? { kind: "rev", rev: c.parents[0], path: c.oldPath }
          : { kind: "rev", rev: c.rev, path: c.path };
      await vscode.commands.executeCommand("vscode.open", uriFor(t, side, true), { preview: true });
    }),

    vscode.commands.registerCommand("stitch.copyRevision", async (node?: Node) => {
      const n = commitArg(node);
      if (n) await vscode.env.clipboard.writeText(n.commit.rev);
    }),

    // Message, author, date and a unified diff of this one file (not the commit's other files).
    vscode.commands.registerCommand("stitch.copyDiff", async (node?: Node) => {
      const t = history.current;
      if (!t || (node?.type !== "commit" && node?.type !== "file")) return;
      const c = node.commit;
      const { left, right } = node.type === "file" ? fileDiff(c, node.file) : previousDiff(c);
      // Through the stitch: file system, so content already shown in a diff comes from its cache.
      const read = async (side: Side): Promise<SideText> =>
        side.kind === "empty"
          ? { side, text: "" }
          : { side, text: decodeText(await vscode.workspace.fs.readFile(uriFor(t, side))) };
      try {
        const text = await vscode.window.withProgress(
          { location: { viewId: "stitch.history" }, title: "Copying diff…" },
          async () => formatDiff({ vcs: t.source.vcs, commit: c, left: await read(left), right: await read(right) })
        );
        await vscode.env.clipboard.writeText(text);
        vscode.window.setStatusBarMessage(`Stitch: copied the diff of ${path.posix.basename(right.path)} at ${revName(t, c.rev)}`, 4000);
      } catch (e) {
        void vscode.window.showWarningMessage(`Couldn't copy the diff: ${describeError(e)}`);
      }
    }),

    vscode.commands.registerCommand("stitch.pickRef", async () => {
      const t = history.current;
      if (!t || !(t.source instanceof GitSource)) return;
      const src = t.source;
      let refs;
      try {
        refs = await src.repo.refs();
      } catch (e) {
        void vscode.window.showWarningMessage(describeError(e));
        return;
      }
      const current = refByRoot.get(src.repo.root) ?? "HEAD";
      const item = (label: string, description?: string): vscode.QuickPickItem => ({
        label,
        description: label === current ? "current" : description,
      });
      const sep = (label: string): vscode.QuickPickItem => ({ label, kind: vscode.QuickPickItemKind.Separator });
      const picked = await vscode.window.showQuickPick(
        [
          item("HEAD", "checked-out branch"),
          sep("Branches"),
          ...refs.branches.map((b) => item(b)),
          sep("Remote branches"),
          ...refs.remotes.map((b) => item(b)),
          sep("Tags"),
          ...refs.tags.map((b) => item(b)),
        ],
        { title: "Show history starting from…", placeHolder: "The trunk is the first-parent line of this ref" }
      );
      if (!picked) return;
      refByRoot.set(src.repo.root, picked.label);
      const target = gitTarget(t.file, src.repo, src.relPath, picked.label);
      history.setTarget(target);
      void updateCanFetch(target);
      void updateFetchNote(target);
      headByFile.set(t.file.toString(), await gitState(src.repo, picked.label));
    })
  );

  followActive();
}

export function deactivate(): Promise<void> {
  return closeWcDb(); // the wc.db reader thread
}
