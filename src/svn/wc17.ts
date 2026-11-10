// Reads SVN 1.7+ working copies (entries format "12"; wc.db user_version 29–31,
// i.e. clients 1.7–1.14). All metadata lives in <root>/.svn/wc.db; BASE text is
// in <root>/.svn/pristine/<sha1[0:2]>/<sha1>.svn-base.
//
// Read-only: wc.db is opened by Node's built-in SQLite in a worker thread
// (wcdb.ts, wcdbWorker.ts), read-only and immutable, so SQLite reads only the
// pages a lookup needs and takes no locks. Damaged or half-written working
// copies give an SvnError ("damaged") that says what to do, not a crash.
import { promises as fs } from "fs";
import * as path from "path";
import { log } from "../log";
import { parseProps } from "./skel";
import { SvnError, SvnNode, SvnWorkingCopy } from "./types";
import { queryWcDb, WcDbError } from "./wcdb";
import { Row, stampOf } from "./wcdbProtocol";

/** wc.db formats this reader understands (svn 1.7 = 29, 1.8–1.14 = 31). */
const FORMATS = [29, 30, 31];

const NODE_SQL = `
  SELECT n.op_depth, n.repos_path, n.revision, n.presence, n.kind, n.properties, n.checksum,
         n.translated_size, n.last_mod_time, n.changed_revision, n.changed_date, n.changed_author,
         r.root, r.uuid
  FROM NODES n LEFT JOIN REPOSITORY r ON r.id = n.repos_id
  WHERE n.wc_id = (SELECT id FROM WCROOT ORDER BY id LIMIT 1) AND n.local_relpath = ?
  ORDER BY n.op_depth DESC`;

interface NodeRow {
  op_depth: number;
  repos_path: string | null;
  revision: number | null;
  presence: string;
  kind: string;
  properties: Uint8Array | null;
  checksum: string | null;
  translated_size: number | null;
  last_mod_time: number | null;
  changed_revision: number | null;
  changed_date: number | null;
  changed_author: string | null;
  root: string | null;
  uuid: string | null;
}

const CLEANUP = "Running svn cleanup (or a fresh checkout) should fix it.";

export class Wc17 implements SvnWorkingCopy {
  readonly format = "1.7+";
  /** Stamp of wc.db at the last successful read. */
  private stamp?: string;
  /** Stamp of wc.db when changed() last looked (or at the first read). Reads don't move it. */
  private checked?: string;
  private warnedQueue?: string;

  constructor(
    readonly root: string,
    private readonly timeoutMs: () => number = () => 15000
  ) {}

  private get dbPath(): string {
    return path.join(this.root, ".svn", "wc.db");
  }

  /**
   * Whether wc.db changed since the previous call (cheap: one stat). Measured
   * against the last check, not the last read: a read after `svn update` (an
   * editor switch looking up the file) must not hide the update from the caller
   * that drops cached BASE text.
   */
  async changed(): Promise<boolean> {
    if (this.checked === undefined) return false;
    let now: string;
    try {
      now = stampOf(await fs.stat(this.dbPath, { bigint: true }));
    } catch {
      return true;
    }
    if (now === this.checked) return false;
    this.checked = now;
    return true;
  }

  private async query(relPath: string): Promise<{ version: number; reposUuid?: string; queued: number; rows: NodeRow[] }> {
    let res;
    try {
      res = await queryWcDb(
        this.dbPath,
        [
          { sql: "PRAGMA user_version", params: [] },
          { sql: "SELECT uuid FROM REPOSITORY LIMIT 2", params: [] },
          { sql: "SELECT count(*) AS n FROM WORK_QUEUE", params: [] },
          { sql: NODE_SQL, params: [relPath] },
        ],
        this.timeoutMs()
      );
    } catch (e) {
      throw this.explain(e);
    }
    this.stamp = res.stamp;
    this.checked ??= res.stamp;
    const [[ver], repos, [queue], rows] = res.results as [Row[], Row[], Row[], Row[]];
    return {
      version: Number(ver?.user_version ?? 0),
      // The working copy's repository, when it has exactly one (the usual case).
      reposUuid: repos.length === 1 ? ((repos[0].uuid as string | null) ?? undefined) : undefined,
      queued: Number(queue?.n ?? 0),
      rows: rows as unknown as NodeRow[],
    };
  }

  /** A failed read, in words a user can act on. */
  private explain(e: unknown): Error {
    const where = this.dbPath;
    if (!(e instanceof WcDbError)) return e instanceof Error ? e : new Error(String(e));
    switch (e.kind) {
      case "missing":
        return e.code === "EACCES" || e.code === "EPERM"
          ? new SvnError(`Can't read ${where}: permission denied.`, "damaged")
          : new SvnError(`${where} is missing; this .svn folder looks incomplete. ${CLEANUP}`, "damaged");
      case "damaged":
        return new SvnError(`${where} can't be read (${e.message}). The working copy may be damaged. ${CLEANUP}`, "damaged");
      case "timeout":
        return new SvnError(e.message, "unavailable");
      case "unavailable":
        return new SvnError(e.message, "unsupported");
      default:
        // Missing tables or columns: an empty file, or not an SVN working copy database.
        if (/no such (table|column)/i.test(e.message)) {
          return new SvnError(`${where} is empty or damaged (${e.message}). ${CLEANUP}`, "damaged");
        }
        return new SvnError(`Can't read ${where}: ${e.message}`, "other");
    }
  }

  async node(relPath: string): Promise<SvnNode | undefined> {
    const { version, reposUuid, queued, rows } = await this.query(relPath);
    if (!FORMATS.includes(version)) {
      throw new SvnError(
        version === 0
          ? `${this.dbPath} is empty or damaged. ${CLEANUP}`
          : version > 31
            ? `This working copy (format ${version}) is from an svn newer than 1.14, which isn't supported yet.`
            : `Unsupported working copy format ${version} (supported: svn 1.7–1.14).`,
        version === 0 ? "damaged" : "unsupported"
      );
    }
    if (queued > 0 && this.warnedQueue !== this.stamp) {
      // An svn command was interrupted (svn itself asks for cleanup now). The metadata is
      // usually still consistent, so keep going, but say so once per version of wc.db.
      this.warnedQueue = this.stamp;
      log.warn(`${this.root}: an svn operation was interrupted (${queued} pending work items); svn cleanup will finish it`);
    }
    const top = rows[0];
    if (!top || top.kind !== "file") return undefined;
    if (top.presence !== "normal" && top.presence !== "incomplete") {
      // base-deleted / not-present / excluded / server-excluded: not a versioned file here.
      return undefined;
    }
    const base = rows.find((r) => r.op_depth === 0 && r.presence === "normal");
    // The working node's repository info is the copy source for a copy; for a
    // plain add there is none. For history, BASE wins; a copy falls back to its source.
    const origin = base ?? (top.repos_path !== null ? top : undefined);
    if (origin && (origin.root === null || origin.revision === null)) {
      throw new SvnError(`${this.dbPath} has no repository or revision for ${relPath}. ${CLEANUP}`, "damaged");
    }
    return {
      relPath,
      schedule: top.op_depth === 0 ? "normal" : top.repos_path !== null ? "copied" : "added",
      reposRoot: origin?.root ?? undefined,
      uuid: origin?.uuid ?? reposUuid,
      reposPath: origin?.repos_path ?? undefined,
      revision: origin?.revision ?? undefined,
      hasBase: !!top.checksum,
      sha1: top.checksum?.startsWith("$sha1$") ? top.checksum.slice(6) : undefined,
      props: parseProps(top.properties),
      translatedSize: top.translated_size ?? undefined,
      lastModTimeUs: top.last_mod_time ?? undefined,
      changedRev: top.changed_revision ?? undefined,
      changedDate: top.changed_date ? new Date(top.changed_date / 1000) : undefined,
      changedAuthor: top.changed_author ?? undefined,
    };
  }

  /** The unmodified text the working file is compared against, as stored (keywords contracted). */
  async pristine(node: SvnNode): Promise<Uint8Array> {
    if (!node.sha1) return new Uint8Array(); // a plain add: compare with nothing
    const p = path.join(this.root, ".svn", "pristine", node.sha1.slice(0, 2), `${node.sha1}.svn-base`);
    try {
      return new Uint8Array(await fs.readFile(p));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new SvnError(`The BASE text of ${node.relPath} is missing from .svn/pristine. The working copy is damaged. ${CLEANUP}`, "damaged");
      }
      throw new SvnError(`Can't read the BASE text of ${node.relPath}: ${(e as Error).message}`, "other");
    }
  }
}
