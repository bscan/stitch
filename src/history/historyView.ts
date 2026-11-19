import * as path from "path";
import * as vscode from "vscode";
import { ChangedFile, Commit } from "../backend";
import { describeError, isCancelled } from "../errors";
import { log } from "../log";
import { avatarDataUri } from "./avatar";
import { relativeTime, shortRefs } from "./format";
import { HistorySpec } from "./scope";
import { HistorySource, Level, Next, PushedLine, searchGoesOn, SearchProgress, SourcePage, TopPage } from "./source";

/** Held views (a scope other than the normal one, or filters): what the rows above and below the history say. */
export interface Held {
  /** The filters in words ("author brian · lines 10–20"), when any filter is active. */
  filters?: string;
  /** With filters: the last row once nothing older matches ("No more commits by brian"). */
  endText?: string;
  /** Without filters: the scope row ("Folder: src/history") and its icon. */
  scopeLabel?: string;
  scopeIcon?: string;
  /** A line filter whose selection includes uncommitted lines: the row that says so, and what clicking it opens. */
  uncommitted?: vscode.Command;
}

export interface Target {
  /** The file, folder or working-copy root whose history this is. */
  file: vscode.Uri;
  source: HistorySource;
  /** Shown next to the view title (file name, and the starting ref if not HEAD). */
  description: string;
  /** Set while the view is held (it then ignores editor switches until Clear; a line filter ends on another file). */
  held?: Held;
  /** What this shows (scope and filters). */
  spec?: HistorySpec;
}

export interface CommitNode {
  type: "commit";
  commit: Commit;
  /** The backend's context for the level this commit is on. */
  level: Level;
  parent?: CommitNode;
  children?: Node[];
  /** Number of branch commits behind a merge, once known. */
  count?: number;
  counting?: boolean;
  /** svn: a server revision newer than the working copy's BASE. */
  incoming?: boolean;
  /** Tooltip line for an incoming row. */
  incomingNote?: string;
}

export interface MoreNode {
  type: "more";
  parent?: CommitNode;
  next: Next;
  level: Level;
  /**
   * "searching": a client-side search is going on (no click);
   * "further": it stopped at its cap, and a click searches further back.
   */
  mode?: "searching" | "further";
  /** Searches: the oldest revision looked at so far. */
  through?: string;
}

interface InfoNode {
  type: "info";
  text: string;
  parent?: CommitNode | FilesNode;
  command?: vscode.Command;
  icon?: string;
  iconColor?: string;
  /** Colors the label too (through a file decoration on a stitch-ui: URI). */
  warn?: boolean;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  /** Distinguishes several info rows on one level (tree ids). */
  key?: string;
}

/** "Changed files (N)" under a merge, above the merged commits. */
interface FilesNode {
  type: "files";
  parent: CommitNode;
  children?: Node[];
}

/** One file a commit changed. */
export interface FileNode {
  type: "file";
  file: ChangedFile;
  commit: Commit;
  parent: CommitNode | FilesNode;
}

export type Node = CommitNode | MoreNode | InfoNode | FilesNode | FileNode;

/** Expanding a commit to its files is only worth it when it changed other files too. */
const hasOtherFiles = (c: Commit) => (c.files?.length ?? 0) > 1;

/** Whether a repository path is the folder `dir` or inside it ("" is the whole repository). */
const inDir = (p: string, dir: string) => dir === "" || p === dir || p.startsWith(dir + "/");

/**
 * A scoped commit's changed files: those under the folder (the commit's path), and
 * how many others it changed (svn lists at most 100 per revision, so `filesTotal` counts the rest).
 */
export function scopedFiles(c: Commit): { inside: ChangedFile[]; outside: number } {
  const files = c.files ?? [];
  const inside = files.filter((f) => inDir(f.path, c.path) || (f.oldPath !== undefined && inDir(f.oldPath, c.path)));
  return { inside, outside: (c.filesTotal ?? files.length) - inside.length };
}

const FILE_ICONS: Record<string, [string, string]> = {
  A: ["diff-added", "gitDecoration.addedResourceForeground"],
  C: ["diff-added", "gitDecoration.addedResourceForeground"],
  D: ["diff-removed", "gitDecoration.deletedResourceForeground"],
  R: ["diff-renamed", "gitDecoration.renamedResourceForeground"],
};
const STATUS_WORDS: Record<string, string> = { A: "Added", C: "Copied", D: "Deleted", R: "Renamed", M: "Modified", T: "Type changed" };

/** Rows whose label is drawn in the warning color (the active-filter row). */
const WARN_URI = vscode.Uri.from({ scheme: "stitch-ui", path: "/filtered" });
const WARN_COLOR = "list.warningForeground";

/** Folder and working-copy histories list fewer commits per page: each row stands for many files. */
const SCOPED_PAGE = 20;

class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}


export class HistoryView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly view: vscode.TreeView<Node>;
  private readonly decorations: vscode.Disposable;

  private target?: Target;
  private rootNodes?: Node[];
  private generation = 0;
  /** Aborted whenever the view switches to something else, so stale git/server requests stop. */
  private abort = new AbortController();
  private readonly counter = new Limiter(4);

  constructor(private readonly limit: () => number) {
    this.view = vscode.window.createTreeView("stitch.history", {
      treeDataProvider: this,
    });
    this.view.message = "Open a file to see its history.";
    const decorationChanged = new vscode.EventEmitter<vscode.Uri>();
    this.decorations = vscode.Disposable.from(
      decorationChanged,
      vscode.window.registerFileDecorationProvider({
        onDidChangeFileDecorations: decorationChanged.event,
        provideFileDecoration: (uri) =>
          uri.scheme === WARN_URI.scheme ? { color: new vscode.ThemeColor(WARN_COLOR) } : undefined,
      })
    );
  }

  get current(): Target | undefined {
    return this.target;
  }

  /** Starts a new generation: results of older requests are dropped, and the requests aborted. */
  private bump(): void {
    this.generation++;
    this.abort.abort();
    this.abort = new AbortController();
  }

  /** Shows a message instead of history (not under version control, errors, …). */
  showMessage(text: string, file?: vscode.Uri): void {
    this.bump();
    this.target = undefined;
    this.rootNodes = [];
    this.view.message = text;
    this.view.description = file ? path.basename(file.fsPath) : undefined;
    this.changed.fire(undefined);
  }

  /** Shows a single clickable row instead of history (e.g. "Add a URL mapping…"). */
  showAction(text: string, command: vscode.Command, file?: vscode.Uri): void {
    this.showMessage("", file);
    this.view.message = undefined;
    this.rootNodes = [{ type: "info", text, command }];
    this.changed.fire(undefined);
  }

  /** Per file: a problem shown above its history (e.g. its BASE text is missing). */
  private readonly warnings = new Map<string, string>();

  /**
   * Shows `text` above the file's history while it's the current file, or clears it.
   * For problems found in the background (the gutter's BASE read), which must not pop up.
   */
  setWarning(file: vscode.Uri, text: string | undefined): void {
    const key = file.toString();
    if (text === undefined ? !this.warnings.delete(key) : this.warnings.get(key) === text) return;
    if (text !== undefined) this.warnings.set(key, text);
    if (this.target?.file.toString() === key && this.rootNodes?.length !== 0) this.view.message = text;
  }

  setTarget(target: Target): void {
    this.bump();
    if (target !== this.target) this.note = undefined;
    this.target = target;
    this.rootNodes = undefined;
    this.counts = undefined;
    this.scannedAll = { scanned: 0, matched: 0 };
    this.header = this.headerNodes(target);
    this.view.message = this.warnings.get(target.file.toString());
    this.showDescription();
    this.changed.fire(undefined);
  }

  /** Short note after the target's description in the view title (e.g. "fetched 3 d ago"). */
  private note?: string;

  setNote(target: Target, note: string | undefined): void {
    if (target !== this.target || note === this.note) return;
    this.note = note;
    this.showDescription();
  }

  private showDescription(): void {
    if (!this.target) return;
    this.view.description = this.note ? `${this.target.description} · ${this.note}` : this.target.description;
  }

  /** Reloads the current target from scratch. */
  reload(): void {
    if (this.target) this.setTarget(this.target);
  }

  // ---- rows above the history (held views) ----------------------------------

  /** The filter or scope row, the "Show history of … instead" row and the uncommitted-lines row. */
  private header: Node[] = [];
  /** The file the editor shows while a held view shows something else (for "Show history of … instead"). */
  private outside?: vscode.Uri;
  /** git: how many commits the filters let through, out of how many (when cheap to know). */
  private counts?: { shown: number; total: number };
  /** svn searches: revisions looked at and matched so far, for the hidden count. */
  private scannedAll = { scanned: 0, matched: 0 };

  /**
   * While the view is held, `file` is the editor's file if the view doesn't show
   * it (undefined otherwise): a row offers to go back to it.
   */
  setOutside(file: vscode.Uri | undefined): void {
    if (file?.toString() === this.outside?.toString()) return;
    this.outside = file;
    if (!this.target) return;
    this.header = this.headerNodes(this.target);
    this.changed.fire(undefined);
  }

  private headerNodes(t: Target): Node[] {
    const held = t.held;
    if (!held) return [];
    const clear = { command: "stitch.clear", title: "Clear" };
    const nodes: Node[] = [];
    if (held.filters) {
      nodes.push({
        type: "info",
        key: "filtered",
        text: `Filtered: ${held.filters}`,
        description: this.hiddenText(),
        icon: "filter-filled",
        iconColor: WARN_COLOR,
        warn: true,
        tooltip: `Only commits that match the filters are listed (${held.filters}). ✕ clears the filters and follows the editor again.`,
        contextValue: "stitch.clearable",
      });
    } else if (held.scopeLabel) {
      nodes.push({
        type: "info",
        key: "scope",
        text: held.scopeLabel,
        icon: held.scopeIcon ?? "folder",
        tooltip: "The view stays on this until you clear it (✕), whichever file you open.",
        contextValue: "stitch.clearable",
      });
    }
    if (this.outside) {
      nodes.push({
        type: "info",
        key: "outside",
        text: `Show history of ${path.basename(this.outside.fsPath)} instead`,
        icon: "arrow-left",
        tooltip: `The editor shows ${this.outside.fsPath}, which this history doesn't cover. Click to clear and follow the editor again.`,
        command: clear,
      });
    }
    if (held.uncommitted) {
      nodes.push({
        type: "info",
        key: "uncommitted",
        text: "Uncommitted changes",
        description: "in the selected lines",
        icon: "diff-modified",
        iconColor: "gitDecoration.modifiedResourceForeground",
        tooltip: "Some of the selected lines are changed in the working file and not committed yet. Click to see the changes.",
        command: held.uncommitted,
      });
    }
    return nodes;
  }

  /** "112 of 120 hidden": git counts with rev-list; svn counts the revisions its search looked at. */
  private hiddenText(): string | undefined {
    const c = this.counts ?? (this.scannedAll.scanned ? { shown: this.scannedAll.matched, total: this.scannedAll.scanned } : undefined);
    return c ? `${c.total - c.shown} of ${c.total} hidden` : undefined;
  }

  private updateHiddenCount(): void {
    const row = this.header.find((n): n is InfoNode => n.type === "info" && n.key === "filtered");
    if (!row) return;
    const text = this.hiddenText();
    if (row.description === text) return;
    row.description = text;
    if (this.scannedAll.scanned && !this.counts) {
      row.tooltip = `${row.tooltip?.replace(/ \(hidden count:.*\)$/, "")} (hidden count: among the ${this.scannedAll.scanned} revisions searched so far)`;
    }
    this.changed.fire(row);
  }

  /** git, filtered folder or repository: asks for the counts once the first page is shown. */
  private loadCounts(t: Target, gen: number, signal: AbortSignal): void {
    if (!t.held?.filters || !t.source.filterCounts) return;
    t.source.filterCounts(signal).then(
      (c) => {
        if (gen !== this.generation || !c) return;
        this.counts = c;
        this.updateHiddenCount();
      },
      (e) => {
        if (!isCancelled(e)) log.warn(`filter counts: ${describeError(e)}`);
      }
    );
  }

  getParent(node: Node): Node | undefined {
    return node.parent;
  }

  /** Rows per page: fewer for folders and working copies. */
  private pageLimit(source: HistorySource): number {
    return source.scoped ? Math.min(this.limit(), SCOPED_PAGE) : this.limit();
  }

  /** A row that expands to the commits a merge brought in (an svn candidate with none is an ordinary commit). */
  private expandsToMerged(n: CommitNode): boolean {
    return n.commit.isMerge && n.count !== 0 && !this.target?.source.flat;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    const target = this.target;
    if (!target) return node ? [] : this.rootNodes ?? [];
    const gen = this.generation;
    const signal = this.abort.signal;
    if (!node) {
      if (!this.rootNodes) {
        try {
          const started = Date.now();
          const page = await target.source.top(this.pageLimit(target.source), signal);
          if (gen !== this.generation) return [];
          this.pushedLine = page.pushedLine;
          this.search = { found: 0, scanned: 0, started };
          const { nodes: body, cont } = this.pageNodes(page, page.level, undefined, undefined);
          const nodes = [...this.incomingNodes(page), ...body];
          await this.settle(nodes, target.source, signal);
          if (gen !== this.generation) return [];
          this.rootNodes = nodes;
          if (!nodes.some((n) => n.type === "commit") && !target.held?.filters && !cont) {
            this.view.message = target.source.scoped
              ? "No commits touch this folder."
              : "No commits touch this file (is it untracked or ignored?).";
          }
          this.loadCounts(target, gen, signal);
          if (cont) setTimeout(() => void this.loadMore(cont, true), 0);
        } catch (e) {
          if (gen !== this.generation) return [];
          this.rootNodes = [];
          this.view.message = describeError(e);
        }
      }
      return [...this.header, ...this.rootNodes];
    }
    if (node.type === "files") {
      node.children ??= this.fileNodes(node.parent.commit, node, !!target.source.scoped);
      return node.children;
    }
    if (node.type !== "commit") return [];
    if (node.children) return node.children;
    const scoped = !!target.source.scoped;
    if (scoped && !node.commit.files && target.source.files) {
      // Folder and repository histories list a commit's files only when it is expanded.
      try {
        await target.source.files([node.commit], signal);
      } catch (e) {
        if (gen !== this.generation) return [];
        node.children = [{ type: "info", text: describeError(e), parent: node }];
        return node.children;
      }
      if (gen !== this.generation) return [];
    }
    if (!this.expandsToMerged(node)) {
      node.children = scoped || hasOtherFiles(node.commit) ? this.fileNodes(node.commit, node, scoped) : [];
      return node.children;
    }
    try {
      const page = await target.source.expand(node.commit, node.level, this.pageLimit(target.source), signal);
      if (gen !== this.generation) return [];
      const merged = this.toNodes(page, page.level, node);
      await this.settle(merged, target.source, signal);
      if (gen !== this.generation) return [];
      const files: Node[] = scoped || hasOtherFiles(node.commit) ? [{ type: "files", parent: node }] : [];
      node.children = [...files, ...merged];
      if (merged.length === 0) {
        const what = scoped ? "this folder" : "this file";
        const text = target.source.vcs === "git" ? `No branch commits changed ${what}.` : `No merged revisions changed ${what}.`;
        node.children.push({ type: "info", text, parent: node });
      }
    } catch (e) {
      if (gen !== this.generation) return [];
      node.children = [{ type: "info", text: describeError(e), parent: node }];
    }
    return node.children;
  }

  /** Server revisions the working copy doesn't have, then a separator row at BASE. */
  private incomingNodes(page: TopPage): Node[] {
    const inc = page.incoming;
    if (!inc || (inc.commits.length === 0 && !inc.note)) return [];
    const nodes: Node[] = inc.commits.map((commit) => ({
      type: "commit",
      commit,
      level: inc.level ?? page.level,
      incoming: true,
      incomingNote: inc.rowTooltip,
    }));
    if (inc.truncated) {
      nodes.push({
        type: "info",
        key: "incoming-more",
        text: "More incoming revisions not listed",
        icon: "ellipsis",
        tooltip: "Only the newest are shown (see “stitch.logLimit”).",
      });
    }
    nodes.push({
      type: "info",
      key: "base",
      text: `──── ${inc.label} ────`,
      icon: "location",
      description: inc.description,
      tooltip: inc.tooltip,
    });
    return nodes;
  }

  /** git: the separator for under the unpushed commits, for the history being shown. */
  private pushedLine?: PushedLine;

  /**
   * Top level only: puts the "upstream" separator between the unpushed commits and
   * the first one the upstream has. `before` is the row these follow (Load more).
   * A first-parent walk reaches the upstream's commits once and stays in them, so
   * there is one such place; if every commit is unpushed, there is no line.
   */
  private withPushedLine(nodes: Node[], before: Node | undefined): Node[] {
    const line = this.pushedLine;
    if (!line) return nodes;
    const unpushed = (n: Node | undefined) => n?.type === "commit" && !n.incoming && n.commit.unpushed !== undefined;
    const i = nodes.findIndex((n, j) => n.type === "commit" && !unpushed(n) && unpushed(j > 0 ? nodes[j - 1] : before));
    if (i < 0) return nodes;
    const row: Node = { type: "info", key: "upstream", text: `──── ${line.label} ────`, icon: "cloud", description: line.description, tooltip: line.tooltip };
    return [...nodes.slice(0, i), row, ...nodes.slice(i)];
  }

  private toNodes(page: SourcePage, level: Level, parent: CommitNode | undefined): Node[] {
    const nodes: Node[] = page.commits.map((commit) => ({ type: "commit", commit, level, parent }));
    if (page.next) nodes.push({ type: "more", next: page.next, level, parent });
    return nodes;
  }

  /**
   * Top-level searches (svn filters): rows found and revisions looked at since the user last
   * asked for more, when that was, and how many had been looked at when the first row was found.
   */
  private search: SearchProgress = { found: 0, scanned: 0, started: 0 };

  /**
   * A top-level page's rows and what follows them: "Load more…", a running search
   * (`cont`: the caller continues it), "Search further" at the search's cap, or,
   * with filters, the end row once nothing older matches.
   */
  private pageNodes(page: SourcePage, level: Level, before: Node | undefined, prior: Node | undefined): { nodes: Node[]; cont?: MoreNode } {
    const t = this.target!;
    const commits: Node[] = page.commits.map((commit) => ({ type: "commit", commit, level }));
    const nodes = this.withPushedLine(commits, prior);
    let cont: MoreNode | undefined;
    if (page.searched) {
      this.search.found += page.commits.length;
      this.search.scanned += page.searched.scanned;
      if (this.search.found > 0) this.search.matchedAt ??= this.search.scanned;
      this.scannedAll.scanned += page.searched.scanned;
      this.scannedAll.matched += page.commits.length;
      this.updateHiddenCount();
    }
    if (page.next) {
      const more: MoreNode = { type: "more", next: page.next, level, through: page.searched?.through ?? (before as MoreNode | undefined)?.through };
      if (page.searched && this.search.found < this.pageLimit(t.source)) {
        more.mode = searchGoesOn(this.search, t.source) ? "searching" : "further";
        if (more.mode === "searching") cont = more;
      }
      nodes.push(more);
    } else if (t.held?.filters) {
      nodes.push({
        type: "info",
        key: "end",
        text: t.held.endText ?? "No more matching commits",
        icon: "filter",
        tooltip: "Nothing older matches the filters. ✕ clears them and follows the editor again.",
        contextValue: "stitch.clearable",
      });
    }
    return { nodes, cont };
  }

  /** The commit's files: the current file first, then the rest by path. Scoped: the files under the folder, then one row for the rest. */
  private fileNodes(commit: Commit, parent: CommitNode | FilesNode, scoped = false): Node[] {
    if (scoped) {
      const { inside, outside } = scopedFiles(commit);
      const nodes: Node[] = [...inside]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((file) => ({ type: "file", file, commit, parent }));
      if (outside > 0) {
        nodes.push({
          type: "info",
          key: "outside-files",
          text: `+ ${outside} file${outside === 1 ? "" : "s"} outside`,
          icon: "files",
          tooltip: "Files this commit changed elsewhere in the repository. Click to open the whole commit.",
          command: { command: "stitch.openCommit", title: "Open Whole Commit", arguments: [commit, true] },
          parent,
        });
      }
      if (nodes.length === 0) nodes.push({ type: "info", key: "no-files", text: "No files changed (properties only)", parent });
      return nodes;
    }
    const files = [...(commit.files ?? [])].sort(
      (a, b) => Number(b.path === commit.path) - Number(a.path === commit.path) || a.path.localeCompare(b.path)
    );
    const nodes: Node[] = files.map((file) => ({ type: "file", file, commit, parent }));
    const hidden = (commit.filesTotal ?? 0) - files.length;
    if (hidden > 0) {
      nodes.push({
        type: "info",
        key: "more-files",
        text: `… ${hidden} more file${hidden === 1 ? "" : "s"} not listed`,
        icon: "ellipsis",
        tooltip: `This revision changed ${commit.filesTotal} files; only the first ${files.length} are listed.`,
        parent,
      });
    }
    return nodes;
  }

  /**
   * Decides every row's expand arrow before the rows are shown. VS Code lays out a
   * level by which rows have arrows, so an arrow that appears (or disappears) after
   * the first render shifts rows sideways.
   *  - git lists a commit's files separately: one call for the whole batch.
   *  - An svn merge candidate that changed only this file expands only if it merged
   *    revisions, so its merge check runs now too (git merges always have commits behind them).
   * Merge counts for other rows still arrive later: they only change the label.
   * Folder and repository rows always have an arrow: their files are loaded on expand.
   */
  private async settle(nodes: Node[], source: HistorySource, signal: AbortSignal): Promise<void> {
    if (source.scoped) return;
    const commits = nodes.filter((n): n is CommitNode => n.type === "commit");
    const missing = commits.filter((n) => !n.commit.files).map((n) => n.commit);
    if (source.files && missing.length > 0) {
      await source.files(missing, signal).catch((e) => {
        if (!isCancelled(e)) log.warn(`changed files: ${describeError(e)}`); // rows just don't expand to files
      });
    }
    if (source.vcs === "svn") {
      const undecided = commits.filter((n) => n.commit.isMerge && !hasOtherFiles(n.commit) && n.count === undefined);
      await Promise.all(
        undecided.map((n) =>
          this.counter.run(() => source.count(n.commit, n.level, signal)).then(
            (count) => void (n.count = count),
            () => undefined // stays expandable; expanding shows the error
          )
        )
      );
    }
  }

  /**
   * Load more, or the next stretch of a search. `auto`: the view continues a search
   * by itself; a click (Load more, Search further) starts a new stretch, up to the cap.
   */
  async loadMore(node: MoreNode, auto = false): Promise<void> {
    const target = this.target;
    if (!target) return;
    if (node.mode === "searching" && !auto) return; // already running
    const gen = this.generation;
    const container = node.parent ? node.parent.children : this.rootNodes;
    if (!container || !container.includes(node)) return;
    if (!node.parent && !auto) this.search = { found: 0, scanned: 0, started: Date.now() };
    if (!node.parent && node.mode !== "searching" && target.source.searchCap !== undefined) {
      // A search shows its progress while it runs.
      node.mode = "searching";
      this.changed.fire(undefined);
    }
    let cont: MoreNode | undefined;
    try {
      const page = await target.source.more(node.next, this.pageLimit(target.source), this.abort.signal);
      if (gen !== this.generation) return;
      let added: Node[];
      if (node.parent) {
        added = this.toNodes(page, node.level, node.parent);
      } else {
        const i = container.indexOf(node);
        ({ nodes: added, cont } = this.pageNodes(page, node.level, node, container[i - 1]));
      }
      await this.settle(added, target.source, this.abort.signal);
      if (gen !== this.generation) return;
      const i = container.indexOf(node);
      if (i >= 0) container.splice(i, 1, ...added);
    } catch (e) {
      if (gen !== this.generation || isCancelled(e)) return;
      if (node.mode === "searching") {
        node.mode = "further"; // a click tries again
        this.changed.fire(node.parent);
      }
      void vscode.window.showWarningMessage(describeError(e));
      return;
    }
    this.changed.fire(node.parent);
    if (cont) void this.loadMore(cont, true);
  }

  private countLater(node: CommitNode): void {
    const target = this.target;
    if (!target || node.counting || node.count !== undefined) return;
    node.counting = true;
    const gen = this.generation;
    const signal = this.abort.signal;
    void this.counter
      .run(() =>
        // Queued counts for a file the user already left never start.
        signal.aborted ? Promise.reject(new Error("cancelled")) : target.source.count(node.commit, node.level, signal)
      )
      .then(
        (n) => {
          if (gen !== this.generation) return;
          node.count = n;
          this.changed.fire(node);
        },
        () => undefined // leave the row expandable; expanding will show the error
      );
  }

  /**
   * Stable id for a node. Without one VS Code derives the handle from the label,
   * so the "(N commits)" update on a merge row would point at a handle that no
   * longer exists ("Data tree node not found"). A commit appears at most once per
   * level, so the chain of revisions down to it is unique.
   */
  private nodeId(node: Node): string {
    const parent = node.parent ? this.nodeId(node.parent) : this.target?.source.key ?? "";
    switch (node.type) {
      case "commit":
        return `${parent}/${node.commit.rev}`;
      case "more":
        return `${parent}/more:${JSON.stringify(node.next)}`;
      case "info":
        return `${parent}/info:${node.key ?? ""}`;
      case "files":
        return `${parent}/files`;
      case "file":
        return `${parent}/f:${node.file.path}`;
    }
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const item = this.makeItem(node);
    item.id = this.nodeId(node);
    return item;
  }

  private makeItem(node: Node): vscode.TreeItem {
    if (node.type === "info") {
      const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(
        node.icon ?? (node.command ? "gear" : "info"),
        node.iconColor ? new vscode.ThemeColor(node.iconColor) : undefined
      );
      if (node.warn) item.resourceUri = WARN_URI;
      item.description = node.description;
      item.tooltip = node.tooltip ?? node.text;
      item.command = node.command;
      item.contextValue = node.contextValue;
      return item;
    }
    if (node.type === "files") {
      const c = node.parent.commit;
      const n = this.target?.source.scoped ? scopedFiles(c).inside.length : c.filesTotal ?? c.files?.length ?? 0;
      const item = new vscode.TreeItem(`Changed files (${n})`, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon("files");
      return item;
    }
    if (node.type === "file") return this.fileItem(node);
    if (node.type === "more") return this.moreItem(node);

    const c = node.commit;
    const t = this.target;
    const scoped = !!t?.source.scoped;
    if (c.isMerge && !t?.source.flat) this.countLater(node);
    const label =
      c.isMerge && node.count !== undefined && node.count > 0 && !t?.source.flat
        ? `${c.subject} (${node.count} ${t?.source.vcs === "svn" ? "revision" : "commit"}${node.count === 1 ? "" : "s"})`
        : c.subject;
    const collapsible =
      scoped || this.expandsToMerged(node) || hasOtherFiles(c)
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(label, collapsible);

    // No revision here: it's in the tooltip, and on the row it's clutter.
    const bits = [c.author, relativeTime(c.date)];
    if (c.isPullMerge) bits.unshift("pull merge");
    else if (this.expandsToMerged(node)) bits.unshift("merge");
    if (node.incoming) bits.unshift("incoming");
    else if (c.unpushed) bits.unshift("unpushed");
    if (!scoped) {
      // How the file itself changed (for a folder these would describe the folder, which reads oddly).
      if (c.status?.startsWith("R") && c.oldPath) {
        const same = path.posix.basename(c.oldPath) === path.posix.basename(c.path);
        bits.push(same ? `moved from ${path.posix.dirname(c.oldPath)}/` : `renamed from ${path.posix.basename(c.oldPath)}`);
      }
      if (c.status?.startsWith("C") && c.oldPath) bits.push(`copied from /${c.oldPath}@${c.parents[0]}`);
      if (c.status?.startsWith("A")) bits.push("added");
      if (c.status?.startsWith("D")) bits.push("deleted");
    }
    const refs = shortRefs(c.refs);
    if (refs.length) bits.push(refs.join(", "));
    item.description = bits.join(" · ");

    // A bubble with the author's initial, colored per author.
    item.iconPath = vscode.Uri.parse(avatarDataUri(c.author));
    const kind = c.isMerge && !t?.source.flat ? "merge" : "commit";
    item.contextValue = scoped ? `stitch.scoped.${kind}` : `stitch.${kind}`;
    item.tooltip = this.tooltip(c, node.incoming ? node.incomingNote : undefined, node.incoming ? undefined : c.unpushed);
    item.command = scoped
      ? { command: "stitch.openCommit", title: "Open Changes", arguments: [c] }
      : { command: "stitch.diffWithPrevious", title: "Diff with Previous", arguments: [node] };
    return item;
  }

  private moreItem(node: MoreNode): vscode.TreeItem {
    if (node.mode === "searching") {
      const item = new vscode.TreeItem(`Searching… ${node.through ? `back to ${node.through}` : ""}`, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("loading~spin");
      item.tooltip = "Stitch is going through older revisions for ones that match the filters.";
      return item;
    }
    if (node.mode === "further") {
      // Not the end (that row says "No older revisions …"): a pause, so the label is the action.
      const item = new vscode.TreeItem("Search further back…", vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("search");
      item.description = node.through ? `searched back to ${node.through}` : undefined;
      item.tooltip =
        `The search paused${node.through ? ` at ${node.through}` : ""}, so it doesn't run on through a long history by itself. ` +
        "Click (or the search button) to look further back; ✕ clears the filters.";
      item.command = { command: "stitch.loadMore", title: "Search Further", arguments: [node] };
      item.contextValue = "stitch.further";
      return item;
    }
    const item = new vscode.TreeItem("Load more…", vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon("ellipsis");
    item.command = { command: "stitch.loadMore", title: "Load More", arguments: [node] };
    return item;
  }

  private fileItem(node: FileNode): vscode.TreeItem {
    const f = node.file;
    const item = new vscode.TreeItem(path.posix.basename(f.path), vscode.TreeItemCollapsibleState.None);
    const dir = path.posix.dirname(f.path);
    const isThis = f.path === node.commit.path;
    item.description = [dir === "." ? "" : dir, isThis ? "this file" : ""].filter(Boolean).join(" · ");
    const [icon, color] = FILE_ICONS[f.status[0]] ?? ["diff-modified", "gitDecoration.modifiedResourceForeground"];
    item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    const from = f.oldPath ? ` (from ${f.oldPath}${f.fromRev && f.status !== "R" ? `@${f.fromRev}` : ""})` : "";
    item.tooltip = `${STATUS_WORDS[f.status[0]] ?? f.status}: ${f.path}${from}`;
    item.contextValue = "stitch.file";
    item.command = { command: "stitch.diffFile", title: "Diff File", arguments: [node] };
    return item;
  }

  private tooltip(c: Commit, incoming?: string, unpushed?: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    if (incoming) md.appendMarkdown(`$(cloud-download) _${escapeMd(incoming)}_\n\n`);
    if (unpushed) md.appendMarkdown(`$(cloud-upload) _${escapeMd(unpushed)}_\n\n`);
    md.appendMarkdown(`**${escapeMd(c.subject)}**\n\n`);
    if (c.body) md.appendText(c.body + "\n\n");
    const who = c.email ? `${escapeMd(c.author)} <${escapeMd(c.email)}>` : escapeMd(c.author);
    md.appendMarkdown(`\`${c.rev}\` · ${who} · ${escapeMd(c.date.toLocaleString())}`);
    const refs = shortRefs(c.refs);
    if (refs.length) md.appendMarkdown(`\n\n$(tag) ${escapeMd(refs.join(", "))}`);
    if (c.isPullMerge) {
      md.appendMarkdown(
        "\n\n_Pull merge: its first parent is the local work, so the branch shown under it is the remote's trunk._"
      );
    }
    // Paths and messages come from the repository: always escaped, and the tooltip is never trusted (no command links).
    if (c.oldPath && c.oldPath !== c.path) md.appendMarkdown(`\n\nPreviously ${escapeMd(c.oldPath)}`);
    return md;
  }

  dispose(): void {
    this.view.dispose();
    this.changed.dispose();
    this.decorations.dispose();
  }
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>$]/g, "\\$&");
}
