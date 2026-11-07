// Read-only `stitch:` file system: serves a file's content at a revision, or
// its SVN BASE text. It returns raw bytes (not strings) so VS Code decodes them
// with the same encoding rules as the editor; that matters for non-UTF-8 files.
import * as path from "path";
import * as vscode from "vscode";
import { Side } from "./backend";
import { describeError, isNotFound } from "./errors";
import { log } from "./log";

export const SCHEME = "stitch";

export type Vcs = "git" | "svn";

export interface Spec {
  vcs: Vcs;
  root: string;
  side: Side;
  /** svn revisions: the repository's http(s) root URL they are fetched from. */
  remote?: string;
  /** svn revisions: expand svn:keywords (for comparing with the working file). */
  keywords?: boolean;
}

/** Loads the bytes for a spec whose side isn't "empty". */
export type Loader = (spec: Spec) => Promise<Uint8Array>;

/** URI for one side of a diff. The URI path is the file's real path, so language detection works. */
export function sideUri(
  vcs: Vcs,
  root: string,
  side: Side,
  svn?: { remote: string; keywords?: boolean }
): vscode.Uri {
  const display = vscode.Uri.file(path.join(root, side.path)).path;
  const spec: Spec = { vcs, root, side, ...(svn ? { remote: svn.remote, ...(svn.keywords ? { keywords: true } : {}) } : {}) };
  return vscode.Uri.from({ scheme: SCHEME, path: display, query: JSON.stringify(spec) });
}

function parseSpec(uri: vscode.Uri): Spec {
  try {
    const spec = JSON.parse(uri.query) as Spec;
    return { ...spec, vcs: spec.vcs ?? "git" };
  } catch {
    throw vscode.FileSystemError.FileNotFound(uri);
  }
}

const MAX_CACHED = 64;

export class RevisionFileSystem implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  /** Content at fixed revisions never changes, so it's kept in a small LRU. */
  private readonly cache = new Map<string, Promise<Uint8Array>>();
  /** BASE content changes after an update, commit or revert; these are invalidated by baseChanged(). */
  private readonly baseCache = new Map<string, Promise<Uint8Array>>();
  /** Reported as BASE's mtime; VS Code's etag is mtime + size, so it must move when BASE may have changed. */
  private baseEpoch = Date.now();
  /** Every BASE URI handed out (including ones evicted from the cache), to notify on change. */
  private readonly baseServed = new Set<string>();

  constructor(private readonly load: Loader) {}

  private content(uri: vscode.Uri): Promise<Uint8Array> {
    const key = uri.toString();
    const spec = parseSpec(uri);
    const cache = spec.side.kind === "base" ? this.baseCache : this.cache;
    if (spec.side.kind === "base") this.baseServed.add(key);
    let p = cache.get(key);
    if (p) {
      // Refresh LRU position.
      cache.delete(key);
      cache.set(key, p);
      return p;
    }
    p = this.read(uri, spec);
    p.catch(() => cache.delete(key));
    cache.set(key, p);
    if (cache.size > MAX_CACHED) {
      cache.delete(cache.keys().next().value as string);
    }
    return p;
  }

  private async read(uri: vscode.Uri, spec: Spec): Promise<Uint8Array> {
    if (spec.side.kind === "empty") return new Uint8Array();
    try {
      return await this.load(spec);
    } catch (e) {
      const where = `${spec.side.path}${spec.side.kind === "rev" ? `@${spec.side.rev}` : " (BASE)"}`;
      if (isNotFound(e)) {
        log.info(`${where}: not found (${describeError(e)})`);
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      // Not "not found": say why (server unreachable, timeout, …) instead of a misleading "file not found".
      log.warn(`${where}: ${describeError(e)}`);
      throw vscode.FileSystemError.Unavailable(`${where}: ${describeError(e)}`);
    }
  }

  /** Tells VS Code that BASE content under `root` may have changed, so open diffs and gutters re-read it. */
  baseChanged(root: string): void {
    this.baseEpoch = Math.max(Date.now(), this.baseEpoch + 1);
    const events: vscode.FileChangeEvent[] = [];
    for (const key of this.baseServed) {
      const uri = vscode.Uri.parse(key);
      if (parseSpec(uri).root !== root) continue;
      this.baseCache.delete(key);
      events.push({ type: vscode.FileChangeType.Changed, uri });
    }
    if (events.length) this.emitter.fire(events);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const data = await this.content(uri);
    const mtime = parseSpec(uri).side.kind === "base" ? this.baseEpoch : 0;
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime,
      size: data.byteLength,
      permissions: vscode.FilePermission.Readonly,
    };
  }

  readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.content(uri);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  // Everything below would write; this file system never does.
  createDirectory(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  writeFile(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  delete(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  rename(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
}
