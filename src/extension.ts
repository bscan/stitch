import * as path from "path";
import * as vscode from "vscode";
import { ChangedFile, Commit, fileDiff, previousDiff, Side } from "./backend";
import { Loader, RevisionFileSystem, SCHEME, sideUri } from "./content";
import { GitError, gitFetch, GitOptions } from "./git/exec";
import { fetchBlockedReason, readMounts } from "./git/fetchPolicy";
import { GitRepo, LogQuery } from "./git/gitBackend";
import { describeError } from "./errors";
import { CommitNode, Held, HistoryView, Node, scopedFiles, Target } from "./history/historyView";
import { fetchNote, staleFetchMs } from "./history/format";
import { decodeText, formatDiff, mapRange, SideText, textLines } from "./history/patch";
import {
  endText,
  Filters,
  filterSummary,
  folderScope,
  FollowMode,
  hasFilters,
  HistorySpec,
  normalSpec,
  releasedBy,
  sameSpec,
  Scope,
  scopeContains,
  scopeName,
  scopesFor,
  specKey,
} from "./history/scope";
import { EmptySource, GitSource } from "./history/source";
import { SvnQuickDiff } from "./quickDiff";
import { childRepositories, findRepositories } from "./repos";
import { LineChange, revertHunk } from "./revertHunk";
import { log, setLogSink } from "./log";
import { Marker, Resolver } from "./resolver";
import { DavClient, RepoInfo } from "./svn/dav";
import { SvnError, SvnRepo } from "./svn/svnBackend";
import { SvnNode } from "./svn/types";
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
  /**
   * Git history sources per file and starting ref, kept across file switches: switching
   * back reuses the loaded history while the ref and its upstream haven't moved
   * (GitSource.top() checks that with rev-parse), instead of running git log again.
   */
  const gitSources = new Map<string, GitSource>();
  const gitSource = (spec: HistorySpec, repo: GitRepo, relPath: string, ref: string, query: LogQuery) => {
    const key = `${specKey(spec)}|${repo.root}|${relPath}|${ref}`;
    let src = gitSources.get(key);
    if (src && src.repo !== repo) src = undefined; // the repository was opened again
    if (src) gitSources.delete(key); // re-inserted below: most recently used last
    src ??= new GitSource(repo, relPath, ref, query);
    gitSources.set(key, src);
    if (gitSources.size > 30) gitSources.delete(gitSources.keys().next().value as string);
    return src;
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
  const svnSource = (spec: HistorySpec, info: RepoInfo, root: string, reposPath: string, peg: number) => {
    const key = `${specKey(spec)}|${info.rootUrl}|${reposPath}|${peg}`;
    let src = svnSources.get(key);
    if (src) svnSources.delete(key); // re-inserted below: most recently used last
    src ??= new SvnSource(dav, info, root, reposPath, peg, svnIntervalMs, { folder: spec.scope.kind !== "file", filters: spec.filters });
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
    gitSources.clear();
    // The current view may keep its source (history.reload()): make it query again too.
    if (history.current?.source instanceof GitSource) history.current.source.invalidate();
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
      if (await repo.changed().catch(() => false)) {
        fsProvider.baseChanged(repo.root);
        any = true;
      }
    }
    return any;
  };

  /** checkSvnMetadata, then follows the current SVN file again if BASE moved (its history starts at BASE). */
  const recheckSvn = () =>
    checkSvnMetadata().then((changed) => {
      void updateSvnModified();
      if (changed && (svnCurrent || held?.scope.vcs === "svn")) followLast();
    });
  /**
   * svn 1.6 rewrites a folder's entries only after it installed all of that folder's
   * changed files (about 1 s for 2000 files locally, longer on a share), so a check
   * right at the reload can be too early. One more check after the reloads stop catches
   * most of those; the next focus or file switch catches the rest.
   */
  let recheckTimer: NodeJS.Timeout | undefined;
  const recheckSvnSoon = () => {
    clearTimeout(recheckTimer);
    recheckTimer = setTimeout(() => void recheckSvn(), 2000);
  };

  // ---- what the view shows ---------------------------------------------------
  // Following (held === undefined): the editor's file, or its working copy with
  // stitch.history.follow = "workingCopy". Held: any other scope, or filters; it
  // ignores editor switches until Clear, except that a line filter ends when the
  // editor switches to another file. Held state isn't kept across a reload.
  let held: HistorySpec | undefined;
  /** Held with a line filter: what the "Uncommitted changes" row opens. */
  let heldUncommitted: vscode.Command | undefined;
  const followMode = (): FollowMode => (config().get<string>("history.follow") === "workingCopy" ? "workingCopy" : "file");

  const setHeld = (spec: HistorySpec | undefined, uncommitted?: vscode.Command) => {
    held = spec;
    heldUncommitted = spec?.filters.lines ? uncommitted : undefined;
    void vscode.commands.executeCommand("setContext", "stitch.held", spec !== undefined);
    void vscode.commands.executeCommand("setContext", "stitch.filtered", spec !== undefined && hasFilters(spec.filters));
  };

  /** The working-copy root a marker belongs to (svn ≤ 1.6 has a marker in every folder). */
  const rootOf = async (m: Marker): Promise<string> =>
    m.kind === "git" ? (await openRepo(m.dir)).repo.root : (await svnRepo(m.dir)).root;

  /** The normal view for a file: its own history, or its working copy's. Undefined outside version control. */
  const normalFor = async (file: vscode.Uri): Promise<HistorySpec | undefined> => {
    const marker = await resolver.forFile(file.fsPath);
    if (!marker) return undefined;
    return normalSpec(file.fsPath, marker.kind, await rootOf(marker), followMode());
  };

  /** The words in the view title: the file, folder or working copy, "Filtered · " first while filters are on. */
  const describe = (spec: HistorySpec, ref = "HEAD") => {
    const name = scopeName(spec.scope) + (ref === "HEAD" ? "" : ` @ ${ref}`);
    return hasFilters(spec.filters) ? `Filtered · ${name}` : name;
  };

  /** Rows above and below a held view's history. */
  const heldRows = (spec: HistorySpec): Held | undefined => {
    if (!held || !sameSpec(held, spec)) return undefined;
    const f = spec.filters;
    if (hasFilters(f)) {
      return { filters: filterSummary(f), endText: endText(f, spec.scope.vcs), uncommitted: f.lines?.uncommitted ? heldUncommitted : undefined };
    }
    const s = spec.scope;
    const word = s.kind === "workingCopy" ? "Working copy" : s.kind === "folder" ? "Folder" : "File";
    return { scopeLabel: `${word}: ${scopeName(s)}`, scopeIcon: s.kind === "workingCopy" ? "repo" : s.kind === "folder" ? "folder" : "file" };
  };

  /** git log options for a spec ("Only this author" passes git the "<email>"). */
  const gitQuery = (spec: HistorySpec): LogQuery => ({
    kind: spec.scope.kind === "file" ? "file" : spec.scope.kind === "folder" ? "dir" : "all",
    ...(spec.filters.author ? { author: spec.filters.author.text } : {}),
    ...(spec.filters.message ? { message: spec.filters.message } : {}),
    ...(spec.filters.lines?.range ? { lines: spec.filters.lines.range } : {}),
  });

  /** A line filter whose lines are all uncommitted has no history to ask for. */
  const nothingCommitted = (spec: HistorySpec) => spec.filters.lines !== undefined && spec.filters.lines.range === undefined;

  const showGit = async (spec: HistorySpec, stale: () => boolean) => {
    const s = spec.scope;
    const { repo, prefix } = await openRepo(s.kind === "file" ? path.dirname(s.path) : s.path);
    if (stale()) return;
    const relPath =
      s.kind === "file" ? GitRepo.relPath(prefix, path.basename(s.path)) : s.kind === "workingCopy" ? "" : prefix.replace(/\/+$/, "");
    const ref = refByRoot.get(repo.root) ?? "HEAD";
    const cur = history.current;
    if (cur && sameSpec(cur.spec, spec) && cur.source instanceof GitSource && cur.source.ref === ref && !nothingCommitted(spec)) return;
    const file = vscode.Uri.file(s.path);
    const source = nothingCommitted(spec)
      ? new EmptySource("git", repo.root, `git:empty:${specKey(spec)}`)
      : gitSource(spec, repo, relPath, ref, gitQuery(spec));
    const target: Target = { file, source, description: describe(spec, ref), held: heldRows(spec), spec };
    history.setTarget(target);
    void updateCanFetch(target);
    void updateFetchNote(target);
  };

  /** `file`: the editor's file, when this follows it (its own messages then name it). */
  const showSvn = async (spec: HistorySpec, stale: () => boolean) => {
    const s = spec.scope;
    const where = vscode.Uri.file(s.path);
    const what = s.kind === "file" ? "file" : "folder";
    let repo: SvnRepo;
    let node;
    try {
      const marker = await resolver.forDir(s.kind === "file" ? path.dirname(s.path) : s.path);
      if (!marker || marker.kind !== "svn") throw new Error(`${s.path} isn't in an SVN working copy.`);
      repo = await svnRepo(marker.dir);
      node = s.kind === "file" ? await repo.node(s.path) : await repo.dirNode(s.path);
    } catch (e) {
      if (!stale()) history.showMessage(describeError(e), where);
      return;
    }
    if (stale()) return;
    if (!node) {
      history.showMessage(`svn doesn't track this ${what} (unversioned or ignored).`, where);
      return;
    }
    if (node.schedule === "added") {
      history.showMessage(`This ${what} is scheduled for addition, so it has no history yet.`, where);
      return;
    }
    if (!node.reposRoot || node.reposPath === undefined || node.revision === undefined) {
      history.showMessage(`svn's metadata for this ${what} has no repository URL or revision; the working copy may be damaged (svn cleanup can help).`, where);
      return;
    }
    // History starts at the BASE revision, like `svn log` on a working-copy path.
    const cur = history.current;
    if (
      cur &&
      sameSpec(cur.spec, spec) &&
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
        where
      );
      return;
    }
    if (mapping.kind === "unsupported") {
      history.showMessage(mapping.reason, where);
      return;
    }
    history.showMessage("Contacting the SVN server…", where);
    try {
      const info = await dav.options(mapping.url);
      if (stale()) return; // the user moved on meanwhile
      if (node.uuid && info.uuid !== node.uuid) {
        log.warn(`${mapping.url} has repository UUID ${info.uuid}; the working copy at ${repo.root} has ${node.uuid}`);
        history.showMessage(
          mapping.mapped
            ? `The URL mapping for ${node.reposRoot} points at a different repository (${mapping.url} has UUID ${info.uuid}, the working copy has ${node.uuid}).`
            : `${mapping.url} is a different repository than this working copy's (UUID ${info.uuid}, expected ${node.uuid}).`,
          where
        );
        return;
      }
      const source = nothingCommitted(spec)
        ? new EmptySource("svn", repo.root, `svn:empty:${specKey(spec)}`)
        : svnSource(spec, info, repo.root, node.reposPath, node.revision);
      history.setTarget({ file: where, source, description: describe(spec), held: heldRows(spec), spec });
    } catch (e) {
      if (!stale()) history.showMessage(describeError(e), where);
    }
  };

  /** Points the view at a spec (the caller has set `held`). */
  const show = async (spec: HistorySpec, stale: () => boolean) => {
    setKind(spec.scope.vcs);
    try {
      await (spec.scope.vcs === "git" ? showGit(spec, stale) : showSvn(spec, stale));
    } catch (e) {
      if (!stale()) history.showMessage(describeError(e), vscode.Uri.file(spec.scope.path));
    }
    updateOutside();
  };

  /** Counts `follow` calls: a slow lookup for a file the user already left must not overwrite the newer one's state. */
  let followSeq = 0;
  /**
   * Counts what points the view somewhere (following, or a held spec): only the latest
   * may set it. Separate from followSeq, so switching files while a held view loads
   * (which doesn't change the view) doesn't cancel that load.
   */
  let viewSeq = 0;
  const nextViewStale = () => {
    const seq = ++viewSeq;
    return () => seq !== viewSeq;
  };
  /** The file the last `follow` was for: what Refresh and settings changes reload, whatever editor has focus then. */
  let lastFollowed: vscode.Uri | undefined;

  /** Held: offers "Show history of <file> instead" while the editor's file is outside what the view shows. */
  const updateOutside = () => {
    const file = lastFollowed;
    history.setOutside(held && file && !scopeContains(held.scope, file.fsPath) ? file : undefined);
  };

  /**
   * The editor switched to `file`. Open Changes and the modified flag always follow
   * it; the history view only while it isn't held.
   */
  const follow = async (file: vscode.Uri) => {
    if (file.scheme !== "file") return;
    const seq = ++followSeq;
    const editorStale = () => seq !== followSeq;
    let stale = editorStale;
    lastFollowed = file;
    const marker = await resolver.forFile(file.fsPath);
    if (stale()) return;
    // The editor menu names the VCS ("Stitch: Show SVN History"); "none" hides the entry.
    void vscode.commands.executeCommand("setContext", "stitch.editorKind", marker?.kind ?? "none");
    let svnLookup: { repo?: SvnRepo; node?: SvnNode; error?: unknown } = {};
    if (marker?.kind === "svn") {
      try {
        const repo = await svnRepo(marker.dir);
        quickDiff.ensure(repo.root);
        svnLookup = { repo, node: await repo.node(file.fsPath) };
      } catch (e) {
        svnLookup = { error: e };
      }
      if (stale()) return;
    }
    svnCurrent = svnLookup.repo && svnLookup.node ? { file, repo: svnLookup.repo } : undefined;
    if (svnCurrent) void updateSvnModified();
    else setSvnModified(false);

    if (held) {
      if (!releasedBy(held, file.fsPath)) {
        updateOutside();
        return;
      }
      // Another file: a line filter ends, like Clear, and the view follows this file.
      setHeld(undefined);
      history.setOutside(undefined);
    }
    // From here on this sets the view: a held spec chosen meanwhile wins.
    const viewStale = nextViewStale();
    stale = () => editorStale() || viewStale();
    if (!marker) {
      setKind(undefined);
      history.showMessage("This file isn't under version control.", file);
      return;
    }
    setKind(marker.kind);
    try {
      if (marker.kind === "svn") {
        if (svnLookup.error !== undefined) throw svnLookup.error;
        const repo = svnLookup.repo!;
        if (followMode() === "file" && !svnLookup.node) {
          history.showMessage("svn doesn't track this file (unversioned or ignored).", file);
          return;
        }
        await show(normalSpec(file.fsPath, "svn", repo.root, followMode()), stale);
        return;
      }
      const { repo } = await openRepo(path.dirname(file.fsPath));
      if (stale()) return;
      await show(normalSpec(file.fsPath, "git", repo.root, followMode()), stale);
    } catch (e) {
      if (!stale()) history.showMessage(describeError(e), file);
    }
  };

  /**
   * Shows a spec, held, or back to following when it is exactly the normal view
   * (Clear passes undefined). A plain history of the editor's own file is never held.
   */
  const apply = async (spec: HistorySpec | undefined, uncommitted?: vscode.Command) => {
    const file = lastFollowed ?? activeFile();
    const normal = file ? await normalFor(file).catch(() => undefined) : undefined;
    if (!spec || (normal && sameSpec(spec, normal))) {
      setHeld(undefined);
      history.setOutside(undefined);
      if (file) {
        history.showMessage("Loading…", file);
        await follow(file);
      } else {
        history.showMessage("Open a file to see its history.");
      }
      return;
    }
    setHeld(spec, uncommitted);
    void vscode.commands.executeCommand("stitch.history.focus");
    const stale = nextViewStale();
    history.showMessage("Loading…", vscode.Uri.file(spec.scope.path));
    await show(spec, stale);
  };

  const activeFile = () => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri?.scheme === "file" ? uri : undefined;
  };

  const followActive = () => {
    const file = activeFile();
    // Keep the current history while a diff, output panel or similar has focus.
    if (file) void follow(file);
  };

  /**
   * Shows again what the view should show: the held spec, or the last followed file.
   * Not the active editor: after a click on a history row that's a stitch: diff, and
   * in the Settings UI there's none at all.
   */
  const followLast = () => {
    if (held) void apply(held, heldUncommitted);
    else if (lastFollowed) void follow(lastFollowed);
    else followActive();
  };

  /** After the caches were dropped: looks the file (or the held view) up again from scratch. */
  const reloadFollowed = () => {
    if (held) {
      history.showMessage("Reloading…", vscode.Uri.file(held.scope.path));
      void apply(held, heldUncommitted);
      return;
    }
    if (!lastFollowed) return followActive(); // nothing shown yet: keep the view's current text
    history.showMessage("Reloading…", lastFollowed);
    void follow(lastFollowed);
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
    if ((await t.source.moved().catch(() => false)) && history.current === t) history.reload();
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

  // ---- scope and filters: Show History, the filter menu, Clear ---------------

  /** The workspace's repositories, scanned when first needed (never at startup); Refresh and folder changes scan again. */
  let workspaceRepos: Promise<{ vcs: Marker["kind"]; root: string }[]> | undefined;
  /** Opens each marker's repository and drops duplicates (svn ≤ 1.6 has a marker in every folder). */
  const reposOf = async (markers: Marker[]) => {
    const roots = await Promise.all(markers.map((m) => rootOf(m).catch(() => m.dir)));
    const seen = new Set<string>();
    const out: { vcs: Marker["kind"]; root: string }[] = [];
    markers.forEach((m, i) => {
      if (seen.has(roots[i])) return;
      seen.add(roots[i]);
      out.push({ vcs: m.kind, root: roots[i] });
    });
    return out;
  };
  const scanWorkspace = () => {
    workspaceRepos ??= (async () => {
      const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => f.uri.fsPath);
      const start = Date.now();
      const repos = await reposOf(await findRepositories(folders, resolver));
      log.info(`found ${repos.length} repositories in ${folders.length} workspace folders in ${Date.now() - start} ms`);
      return repos;
    })();
    return workspaceRepos;
  };

  const wcScope = (vcs: Marker["kind"], root: string): Scope => ({ kind: "workingCopy", vcs, root, path: root });

  /**
   * A line filter from an editor selection: the lines mapped onto the committed
   * file (SVN BASE, or the git starting ref), and whether any of them are uncommitted.
   */
  const lineFilter = async (
    doc: vscode.TextDocument,
    sel: vscode.Selection,
    scope: Scope
  ): Promise<{ lines: NonNullable<Filters["lines"]>; uncommitted?: vscode.Command } | string> => {
    // A selection that ends at the start of a line doesn't include that line.
    const last = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
    // The empty "line" after a final line break (Ctrl+End, a click below the text) is the last line.
    const lineCount = textLines(doc.getText()).length;
    if (lineCount === 0) return "This file is empty.";
    const editor = { start: Math.min(sel.start.line + 1, lineCount), end: Math.min(last + 1, lineCount) };
    const file = doc.uri;
    const name = path.basename(file.fsPath);
    let committed: Uint8Array;
    let left: vscode.Uri;
    let leftName: string;
    if (scope.vcs === "svn") {
      const base = await svnBaseUri(file);
      if (!base) return "svn doesn't track this file.";
      if (base.node.schedule === "added") return "This file is scheduled for addition, so it has no history yet.";
      left = base.uri;
      leftName = `BASE r${base.node.revision}`;
      committed = await vscode.workspace.fs.readFile(left);
    } else {
      const { repo, prefix } = await openRepo(path.dirname(file.fsPath));
      const ref = refByRoot.get(repo.root) ?? "HEAD";
      const rel = GitRepo.relPath(prefix, name);
      const hash = await repo.resolve(ref);
      left = sideUri("git", repo.root, { kind: "rev", rev: hash, path: rel });
      leftName = ref;
      try {
        committed = await repo.show(hash, rel);
      } catch {
        return `${name} isn't committed at ${ref} yet, so it has no history.`;
      }
    }
    const text = decodeText(committed);
    if (text === undefined) return "This file is binary, so it has no lines to follow.";
    const m = mapRange(doc.getText(), text, editor);
    return {
      lines: { range: m.range, editor, uncommitted: m.changed },
      uncommitted: m.changed ? { command: "vscode.diff", title: "Open Changes", arguments: [left, file, `${name} (${leftName} ↔ Working)`] } : undefined,
    };
  };

  /** Show History on a folder: its history, or for a folder holding repositories, one of theirs. */
  const showFolder = async (dir: vscode.Uri) => {
    const marker = await resolver.forDir(dir.fsPath);
    if (marker) {
      await apply({ scope: folderScope(marker.kind, await rootOf(marker), dir.fsPath), filters: {} });
      return;
    }
    const repos = await reposOf(await childRepositories(dir.fsPath));
    if (repos.length === 0) {
      void vscode.window.showInformationMessage(`${path.basename(dir.fsPath)} isn't in a git or SVN repository and has none in it.`);
      return;
    }
    let pick = repos[0];
    if (repos.length > 1) {
      const chosen = await vscode.window.showQuickPick(
        repos.map((r) => ({ label: `$(repo) ${path.basename(r.root)}`, description: r.vcs, detail: r.root, repo: r })),
        { title: `Repositories in ${path.basename(dir.fsPath)}`, placeHolder: "Show the history of…" }
      );
      if (!chosen) return;
      pick = chosen.repo;
    }
    await apply({ scope: wcScope(pick.vcs, pick.root), filters: {} });
  };

  type MenuItem = vscode.QuickPickItem & { run?: () => unknown; scope?: Scope };

  /** The filter menu: Clear, the scopes around the editor's file, the workspace's other working copies, author and message. */
  const filterMenu = async () => {
    const cur = history.current?.spec ?? held ?? (lastFollowed ? await normalFor(lastFollowed).catch(() => undefined) : undefined);
    if (!cur) {
      void vscode.window.showInformationMessage("Open a file under git or SVN first.");
      return;
    }
    const filters = cur.filters;
    // Scopes around the editor's file; the view's own scope is added if it isn't one of them.
    const anchor = lastFollowed ? await normalFor(lastFollowed).catch(() => undefined) : undefined;
    const scopes = anchor ? scopesFor(lastFollowed!.fsPath, anchor.scope.vcs, anchor.scope.root) : [];
    const key = (s: Scope) => `${s.kind}|${s.vcs}|${s.root}|${s.path}`;
    if (!scopes.some((s) => key(s) === key(cur.scope))) scopes.unshift(cur.scope);
    const curIndex = scopes.findIndex((s) => key(s) === key(cur.scope));

    /** Author and message stay; lines only for the same file. */
    // "Only This Author" matches exactly what that VCS records (git: the email; svn: the name),
    // so in a working copy of the other kind it becomes a match on the name.
    const authorFor = (scope: Scope): Filters["author"] =>
      filters.author?.exact && scope.vcs !== cur.scope.vcs
        ? { text: filters.author.label ?? filters.author.text, label: filters.author.label }
        : filters.author;
    const keep = (scope: Scope): Filters => ({
      ...(filters.author ? { author: authorFor(scope) } : {}),
      ...(filters.message ? { message: filters.message } : {}),
      ...(filters.lines && scope.kind === "file" && scope.path === cur.scope.path ? { lines: filters.lines } : {}),
    });
    const icons = { file: "file", folder: "folder", workingCopy: "repo" } as const;
    const scopeItem = (s: Scope, i: number): MenuItem => ({
      label: `$(${i === curIndex ? "check" : icons[s.kind]}) ${s.kind === "workingCopy" ? `Working copy (${scopeName(s)})` : scopeName(s)}`,
      description: s.kind === "file" ? "file" : s.kind === "folder" ? "folder" : s.vcs,
      scope: s,
      run: () => apply({ scope: s, filters: keep(s) }, heldUncommitted),
    });
    const sep = (label: string): MenuItem => ({ label, kind: vscode.QuickPickItemKind.Separator });
    const input = async (title: string, value: string | undefined, prompt: string) =>
      vscode.window.showInputBox({ title, value, prompt, placeHolder: "Empty removes this filter" });
    const head: MenuItem[] = [];
    if (held) head.push({ label: "$(clear-all) Clear filters", description: "follow the editor again", run: () => apply(undefined) });
    head.push(sep("Scope"), ...scopes.map(scopeItem));
    const tail: MenuItem[] = [
      sep("Filter"),
      {
        label: "$(person) Author…",
        description: filters.author ? (filters.author.label ?? filters.author.text) : undefined,
        run: async () => {
          const text = await input("Filter by author", filters.author?.label ?? filters.author?.text, "Part of the author's name (or, on git, email). Any case.");
          if (text === undefined) return;
          const { author: _drop, ...rest } = filters;
          void apply({ scope: cur.scope, filters: text.trim() ? { ...rest, author: { text: text.trim() } } : rest }, heldUncommitted);
        },
      },
      {
        label: "$(comment) Message…",
        description: filters.message,
        run: async () => {
          const text = await input("Filter by message", filters.message, "Part of the commit message. Any case.");
          if (text === undefined) return;
          const { message: _drop, ...rest } = filters;
          void apply({ scope: cur.scope, filters: text.trim() ? { ...rest, message: text.trim() } : rest }, heldUncommitted);
        },
      },
    ];

    const qp = vscode.window.createQuickPick<MenuItem>();
    qp.title = "Stitch History: scope and filters";
    qp.placeholder = "Pick what the history shows";
    qp.matchOnDescription = true;
    qp.items = [...head, ...tail];
    // Enter widens one step: the next scope after the current one is preselected.
    const wider = qp.items.find((i) => i.scope && key(i.scope) === key(scopes[Math.min(curIndex + 1, scopes.length - 1)]));
    if (wider) qp.activeItems = [wider];
    qp.busy = true;
    let done = false;
    // Other working copies are added when the scan is done, so a slow drive doesn't hold up the menu.
    void scanWorkspace()
      .then((repos) => {
        if (done) return;
        const skip = new Set([anchor?.scope.root, cur.scope.root, ...scopes.map((s) => s.root)]);
        const others = repos.filter((r) => !skip.has(r.root));
        if (others.length) {
          const active = qp.activeItems;
          qp.items = [
            ...head,
            sep("Other working copies"),
            ...others.map(
              (r): MenuItem => ({
                label: `$(repo) ${path.basename(r.root)}`,
                description: `${r.vcs} · ${r.root}`,
                scope: wcScope(r.vcs, r.root),
                // Author and message filters are kept; a line filter is about another file.
                run: () => apply({ scope: wcScope(r.vcs, r.root), filters: keep(wcScope(r.vcs, r.root)) }),
              })
            ),
            ...tail,
          ];
          qp.activeItems = active.filter((a) => qp.items.includes(a));
        }
      })
      .catch((e) => log.warn(`scanning the workspace for repositories: ${describeError(e)}`))
      .finally(() => {
        if (!done) qp.busy = false;
      });
    qp.onDidAccept(() => {
      const item = qp.activeItems[0];
      done = true;
      qp.hide();
      void item?.run?.();
    });
    qp.onDidHide(() => {
      done = true;
      qp.dispose();
    });
    qp.show();
  };

  /** A commit's files as one multi-diff editor: the files under the view's folder, or (`all`) the whole commit. */
  const openCommit = async (c: Commit, all = false) => {
    const t = history.current;
    if (!t) return;
    if (!c.files && t.source.files) {
      try {
        await t.source.files([c]);
      } catch (e) {
        void vscode.window.showWarningMessage(describeError(e));
        return;
      }
    }
    const files: ChangedFile[] = all || !t.source.scoped ? c.files ?? [] : scopedFiles(c).inside;
    if (files.length === 0) {
      void vscode.window.showInformationMessage(`${revName(t, c.rev)} changed no files${all ? "" : " in this folder"} (properties only).`);
      return;
    }
    const resources = files.map((f) => {
      const { left, right } = fileDiff(c, f);
      const label = right.kind === "rev" ? uriFor(t, right) : uriFor(t, left);
      return [label.with({ scheme: "file", query: "" }), uriFor(t, left), uriFor(t, right)];
    });
    const more = c.filesTotal && all ? ` (first ${files.length} of ${c.filesTotal} files)` : "";
    await vscode.commands.executeCommand("vscode.changes", `${c.shortRev}: ${c.subject}${more}`, resources);
  };

  /**
   * Show History. `fromEditor` (editor menu, palette): the history of the selected lines, or with
   * nothing selected, of the cursor's line (a right-click puts the cursor on the clicked line).
   * Explorer: a file's or folder's history (or for a folder holding repositories, one of theirs).
   */
  const showHistory = async (arg?: unknown, fromEditor = false) => {
    const editor = vscode.window.activeTextEditor;
    const uri = arg instanceof vscode.Uri ? arg : editor?.document.uri;
    if (!uri || uri.scheme !== "file") {
      void vscode.window.showInformationMessage("Stitch shows history for files on disk.");
      return;
    }
    void vscode.commands.executeCommand("stitch.history.focus");
    try {
      if (((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) !== 0) {
        await showFolder(uri);
        return;
      }
      const marker = await resolver.forFile(uri.fsPath);
      if (!marker) {
        void vscode.window.showInformationMessage(`${path.basename(uri.fsPath)} isn't under version control.`);
        return;
      }
      const scope: Scope = { kind: "file", vcs: marker.kind, root: await rootOf(marker), path: uri.fsPath };
      // From the editor: the selection's lines, or the cursor's line (an empty selection).
      const sel = fromEditor && editor && editor.document.uri.toString() === uri.toString() ? editor.selection : undefined;
      if (!sel) {
        await apply({ scope, filters: {} });
        return;
      }
      const lf = await lineFilter(editor!.document, sel, scope);
      if (typeof lf === "string") {
        void vscode.window.showInformationMessage(lf);
        return;
      }
      await apply({ scope, filters: { lines: lf.lines } }, lf.uncommitted);
    } catch (e) {
      void vscode.window.showWarningMessage(describeError(e));
    }
  };

  const historyCommands = (): vscode.Disposable[] => [
    vscode.workspace.onDidChangeWorkspaceFolders(() => (workspaceRepos = undefined)),

    // Editor: the file's history, or with a selection, the history of those lines.
    // Explorer: a file's or folder's history (or for a folder holding repositories, one of theirs).
    // The Explorer passes the clicked item and the list of selected ones; the editor menu and the palette don't.
    vscode.commands.registerCommand("stitch.showHistory", (arg?: unknown, selected?: unknown) => showHistory(arg, !Array.isArray(selected))),
    // The same, under a title that names the editor file's VCS (the editor menu shows one of the three).
    vscode.commands.registerCommand("stitch.showGitHistory", (arg?: unknown) => showHistory(arg, true)),
    vscode.commands.registerCommand("stitch.showSvnHistory", (arg?: unknown) => showHistory(arg, true)),


    vscode.commands.registerCommand("stitch.filter", filterMenu),
    vscode.commands.registerCommand("stitch.filterActive", filterMenu),
    vscode.commands.registerCommand("stitch.clear", () => apply(undefined)),

    // A commit row's author, across the working copy (the message filter stays).
    vscode.commands.registerCommand("stitch.onlyAuthor", (node?: Node) => {
      const n = commitArg(node);
      const spec = history.current?.spec;
      if (!n || !spec) return;
      const c = n.commit;
      // git matches "Name <email>": the bracketed email picks out one person exactly.
      const author = spec.scope.vcs === "git" && c.email ? { text: `<${c.email}>`, exact: true, label: c.author } : { text: c.author, exact: true };
      const filters: Filters = { author, ...(spec.filters.message ? { message: spec.filters.message } : {}) };
      void apply({ scope: wcScope(spec.scope.vcs, spec.scope.root), filters });
    }),

    vscode.commands.registerCommand("stitch.openCommit", (c?: Commit, all?: boolean) => {
      if (c && typeof c === "object" && "rev" in c) void openCommit(c, all === true);
    }),

    vscode.commands.registerCommand("stitch.searchFurther", (node: Node) => {
      if (node?.type === "more") void history.loadMore(node);
    }),
  ];

  context.subscriptions.push(
    history,
    quickDiff,
    { dispose: () => clearTimeout(recheckTimer) },
    vscode.workspace.registerFileSystemProvider(SCHEME, fsProvider, { isReadonly: true, isCaseSensitive: true }),

    vscode.window.onDidChangeActiveTextEditor(() => {
      followActive();
      // `svn update` in the integrated terminal leaves the window focused: check BASE on file switches too.
      if (svnByRoot.size) void checkSvnMetadata();
      // Autofetch can move origin/… while the window stays focused: re-check on file switches too.
      void refreshIfMoved();
    }),
    vscode.window.onDidChangeWindowState((s) => {
      if (!s.focused) return;
      // The view shows an error or a message (server was unreachable, git timed out, …): try again.
      if (!history.current) followLast();
      void refreshIfMoved();
      void refreshIfServerMoved();
      void recheckSvn(); // an update may have moved BASE
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (svnCurrent && doc.uri.toString() === svnCurrent.file.toString()) void updateSvnModified();
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const doc = e.document;
      // A clean file whose text changed was reloaded from disk (or undone back to clean).
      // After `svn update` that's the first sign BASE moved, while the gutter still compares
      // the new text with the old BASE: check now rather than at the next focus or file switch.
      if (!doc.isDirty && e.contentChanges.length && doc.uri.scheme === "file" && svnByRoot.size) {
        void recheckSvn();
        recheckSvnSoon();
        return;
      }
      // Becoming dirty shows Open Changes at once; becoming clean (undo) needs a disk check.
      if (svnCurrent && doc.uri.toString() === svnCurrent.file.toString()) {
        if (doc.isDirty) setSvnModified(true);
        else void updateSvnModified();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("git.autofetch") || e.affectsConfiguration("git.autofetchPeriod")) {
        if (history.current) void updateFetchNote(history.current);
      }
      if (!e.affectsConfiguration("stitch")) return;
      clearRepos();
      // A message may be what the setting fixes (git.path, svn.urlMap): look the file up again.
      // A held view is looked up again too (with another follow setting, it may be the normal view now).
      if (svnCurrent || !history.current || held || e.affectsConfiguration("stitch.history.follow")) reloadFollowed();
      else history.reload();
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
          // Reload, from git, even if nothing moved: the separator's "fetched …" time changed.
          src.invalidate();
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
      workspaceRepos = undefined; // the filter menu scans for repositories again
      const t = history.current;
      if (t && !wasSvn && t.source instanceof GitSource) {
        history.reload(); // clearRepos() made its source forget what it had loaded
        void updateFetchNote(t);
      } else {
        reloadFollowed();
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
      if (t.spec) void show(t.spec, nextViewStale());
    }),

    ...historyCommands()
  );

  followActive();
}

export function deactivate(): Promise<void> {
  return closeWcDb(); // the wc.db reader thread
}
