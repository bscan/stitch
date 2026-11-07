import * as path from "path";
import * as vscode from "vscode";
import { ChangedFile, Commit } from "../backend";
import { describeError, isCancelled } from "../errors";
import { log } from "../log";
import { avatarDataUri } from "./avatar";
import { relativeTime, shortRefs } from "./format";
import { HistorySource, Level, Next, SourcePage, TopPage } from "./source";

export interface Target {
  file: vscode.Uri;
  source: HistorySource;
  /** Shown next to the view title (file name, and the starting ref if not HEAD). */
  description: string;
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

interface MoreNode {
  type: "more";
  parent?: CommitNode;
  next: Next;
  level: Level;
}

interface InfoNode {
  type: "info";
  text: string;
  parent?: CommitNode;
  command?: vscode.Command;
  icon?: string;
  description?: string;
  tooltip?: string;
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
/** A merge row that expands to merged commits (an svn candidate with none is an ordinary commit). */
const expandsToMerged = (n: CommitNode) => n.commit.isMerge && n.count !== 0;

const FILE_ICONS: Record<string, [string, string]> = {
  A: ["diff-added", "gitDecoration.addedResourceForeground"],
  C: ["diff-added", "gitDecoration.addedResourceForeground"],
  D: ["diff-removed", "gitDecoration.deletedResourceForeground"],
  R: ["diff-renamed", "gitDecoration.renamedResourceForeground"],
};
const STATUS_WORDS: Record<string, string> = { A: "Added", C: "Copied", D: "Deleted", R: "Renamed", M: "Modified", T: "Type changed" };

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

  private target?: Target;
  private rootNodes?: Node[];
  private generation = 0;
  /** Aborted whenever the view switches to something else, so stale git/server requests stop. */
  private abort = new AbortController();
  private readonly counter = new Limiter(4);

  constructor(private readonly limit: () => number) {
    this.view = vscode.window.createTreeView("stitch.history", {
      treeDataProvider: this,
      showCollapseAll: true,
    });
    this.view.message = "Open a file to see its history.";
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

  setTarget(target: Target): void {
    this.bump();
    if (target !== this.target) this.note = undefined;
    this.target = target;
    this.rootNodes = undefined;
    this.view.message = undefined;
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

  getParent(node: Node): Node | undefined {
    return node.parent;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    const target = this.target;
    if (!target) return node ? [] : this.rootNodes ?? [];
    const gen = this.generation;
    const signal = this.abort.signal;
    if (!node) {
      if (!this.rootNodes) {
        try {
          const page = await target.source.top(this.limit(), signal);
          if (gen !== this.generation) return [];
          const nodes = [...this.incomingNodes(page), ...this.toNodes(page, page.level, undefined)];
          await this.settle(nodes, target.source, signal);
          if (gen !== this.generation) return [];
          this.rootNodes = nodes;
          if (this.rootNodes.length === 0) {
            this.view.message = "No commits touch this file (is it untracked or ignored?).";
          }
        } catch (e) {
          if (gen !== this.generation) return [];
          this.rootNodes = [];
          this.view.message = describeError(e);
        }
      }
      return this.rootNodes;
    }
    if (node.type === "files") {
      node.children ??= this.fileNodes(node.parent.commit, node);
      return node.children;
    }
    if (node.type !== "commit") return [];
    if (node.children) return node.children;
    if (!expandsToMerged(node)) {
      node.children = hasOtherFiles(node.commit) ? this.fileNodes(node.commit, node) : [];
      return node.children;
    }
    try {
      const page = await target.source.expand(node.commit, node.level, this.limit(), signal);
      if (gen !== this.generation) return [];
      const merged = this.toNodes(page, page.level, node);
      await this.settle(merged, target.source, signal);
      if (gen !== this.generation) return [];
      const files: Node[] = hasOtherFiles(node.commit) ? [{ type: "files", parent: node }] : [];
      node.children = [...files, ...merged];
      if (merged.length === 0) {
        const text = target.source.vcs === "git" ? "No branch commits changed this file." : "No merged revisions changed this file.";
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

  private toNodes(page: SourcePage, level: Level, parent: CommitNode | undefined): Node[] {
    const nodes: Node[] = page.commits.map((commit) => ({ type: "commit", commit, level, parent }));
    if (page.next) nodes.push({ type: "more", next: page.next, level, parent });
    return nodes;
  }

  /** The commit's files: the current file first, then the rest by path. */
  private fileNodes(commit: Commit, parent: CommitNode | FilesNode): Node[] {
    const files = [...(commit.files ?? [])].sort(
      (a, b) => Number(b.path === commit.path) - Number(a.path === commit.path) || a.path.localeCompare(b.path)
    );
    return files.map((file) => ({ type: "file", file, commit, parent }));
  }

  /**
   * Decides every row's expand arrow before the rows are shown. VS Code lays out a
   * level by which rows have arrows, so an arrow that appears (or disappears) after
   * the first render shifts rows sideways.
   *  - git lists a commit's files separately: one call for the whole batch.
   *  - An svn merge candidate that changed only this file expands only if it merged
   *    revisions, so its merge check runs now too (git merges always have commits behind them).
   * Merge counts for other rows still arrive later: they only change the label.
   */
  private async settle(nodes: Node[], source: HistorySource, signal: AbortSignal): Promise<void> {
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

  async loadMore(node: MoreNode): Promise<void> {
    const target = this.target;
    if (!target) return;
    const gen = this.generation;
    const container = node.parent ? node.parent.children : this.rootNodes;
    if (!container) return;
    try {
      const page = await target.source.more(node.next, this.limit(), this.abort.signal);
      if (gen !== this.generation) return;
      const added = this.toNodes(page, node.level, node.parent as CommitNode | undefined);
      await this.settle(added, target.source, this.abort.signal);
      if (gen !== this.generation) return;
      const i = container.indexOf(node);
      if (i >= 0) container.splice(i, 1, ...added);
    } catch (e) {
      if (gen !== this.generation || isCancelled(e)) return;
      void vscode.window.showWarningMessage(describeError(e));
      return;
    }
    this.changed.fire(node.parent);
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
      item.iconPath = new vscode.ThemeIcon(node.icon ?? (node.command ? "gear" : "info"));
      item.description = node.description;
      item.tooltip = node.tooltip ?? node.text;
      item.command = node.command;
      return item;
    }
    if (node.type === "files") {
      const n = node.parent.commit.files?.length ?? 0;
      const item = new vscode.TreeItem(`Changed files (${n})`, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon("files");
      return item;
    }
    if (node.type === "file") return this.fileItem(node);
    if (node.type === "more") {
      const item = new vscode.TreeItem("Load more…", vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("ellipsis");
      item.command = { command: "stitch.loadMore", title: "Load More", arguments: [node] };
      return item;
    }

    const c = node.commit;
    if (c.isMerge) this.countLater(node);
    const label =
      c.isMerge && node.count !== undefined && node.count > 0
        ? `${c.subject} (${node.count} ${this.target?.source.vcs === "svn" ? "revision" : "commit"}${node.count === 1 ? "" : "s"})`
        : c.subject;
    const collapsible =
      expandsToMerged(node) || hasOtherFiles(c)
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(label, collapsible);

    // No revision here: it's in the tooltip, and on the row it's clutter.
    const bits = [c.author, relativeTime(c.date)];
    if (c.isPullMerge) bits.unshift("pull merge");
    else if (expandsToMerged(node)) bits.unshift("merge");
    if (node.incoming) bits.unshift("incoming");
    if (c.status?.startsWith("R") && c.oldPath) {
      const same = path.posix.basename(c.oldPath) === path.posix.basename(c.path);
      bits.push(same ? `moved from ${path.posix.dirname(c.oldPath)}/` : `renamed from ${path.posix.basename(c.oldPath)}`);
    }
    if (c.status?.startsWith("C") && c.oldPath) bits.push(`copied from /${c.oldPath}@${c.parents[0]}`);
    if (c.status?.startsWith("A")) bits.push("added");
    if (c.status?.startsWith("D")) bits.push("deleted");
    const refs = shortRefs(c.refs);
    if (refs.length) bits.push(refs.join(", "));
    item.description = bits.join(" · ");

    // A bubble with the author's initial, colored per author.
    item.iconPath = vscode.Uri.parse(avatarDataUri(c.author));
    item.contextValue = c.isMerge ? "stitch.merge" : "stitch.commit";
    item.tooltip = this.tooltip(c, node.incoming ? node.incomingNote : undefined);
    item.command = { command: "stitch.diffWithPrevious", title: "Diff with Previous", arguments: [node] };
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

  private tooltip(c: Commit, incoming?: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    if (incoming) md.appendMarkdown(`$(cloud-download) _${escapeMd(incoming)}_\n\n`);
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
  }
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>$]/g, "\\$&");
}
