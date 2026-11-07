// Reads SVN 1.7+ working copies (entries format "12"; wc.db user_version 29–31,
// i.e. clients 1.7–1.14). All metadata lives in <root>/.svn/wc.db; BASE text is
// in <root>/.svn/pristine/<sha1[0:2]>/<sha1>.svn-base.
//
// Read-only: wc.db is read into memory with fs.readFile and opened by sql.js from
// that copy. It is re-read only when its mtime or size changes, because it can be
// large and may sit on a network share.
import { promises as fs } from "fs";
import * as path from "path";
import { parseProps } from "./skel";
import { Database, openDatabase } from "./sqlite";
import { SvnError, SvnNode, SvnWorkingCopy } from "./types";

interface Loaded {
  mtimeMs: number;
  size: number;
  db: Database;
  wcId: number;
  /** UUID of the working copy's repository, when it has exactly one (the usual case). */
  uuid?: string;
}

/** wc.db formats this reader understands (svn 1.7 = 29, 1.8–1.14 = 31). */
const FORMATS = [29, 30, 31];

const NODE_SQL = `
  SELECT n.op_depth, n.repos_path, n.revision, n.presence, n.kind, n.properties, n.checksum,
         n.translated_size, n.last_mod_time, n.changed_revision, n.changed_date, n.changed_author,
         r.root, r.uuid
  FROM NODES n LEFT JOIN REPOSITORY r ON r.id = n.repos_id
  WHERE n.wc_id = ? AND n.local_relpath = ?
  ORDER BY n.op_depth DESC`;

type Row = {
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
};

export class Wc17 implements SvnWorkingCopy {
  readonly format = "1.7+";
  private loading?: Promise<Loaded>;
  private loaded?: Loaded;

  constructor(readonly root: string) {}

  private get dbPath(): string {
    return path.join(this.root, ".svn", "wc.db");
  }

  /** The database, re-read if the file changed since the last read. */
  private async db(): Promise<Loaded> {
    const st = await fs.stat(this.dbPath);
    const cur = this.loaded;
    if (cur && cur.mtimeMs === st.mtimeMs && cur.size === st.size) return cur;
    if (!this.loading) {
      const read = async () => {
        const bytes = await fs.readFile(this.dbPath);
        const db = await openDatabase(bytes);
        try {
          const version = db.exec("PRAGMA user_version")[0]?.values[0]?.[0] as number;
          if (!FORMATS.includes(version)) {
            throw new SvnError(
              version > 31
                ? `This working copy (format ${version}) is from an svn newer than 1.14, which isn't supported yet.`
                : `Unsupported working copy format ${version} (supported: svn 1.7–1.14).`,
              "unsupported"
            );
          }
          const wcId = (db.exec("SELECT id FROM WCROOT ORDER BY id LIMIT 1")[0]?.values[0]?.[0] as number) ?? 1;
          const repos = db.exec("SELECT uuid FROM REPOSITORY")[0]?.values ?? [];
          const uuid = repos.length === 1 ? (repos[0][0] as string) : undefined;
          const next: Loaded = { mtimeMs: st.mtimeMs, size: st.size, db, wcId, uuid };
          this.loaded?.db.close();
          this.loaded = next;
          return next;
        } catch (e) {
          db.close();
          throw e;
        }
      };
      // svn may be rewriting wc.db right now (an update or commit, maybe over a slow
      // share), so a torn read is possible: retry once after a short pause.
      this.loading = read()
        .catch(async (e) => {
          if (e instanceof SvnError) throw e;
          await new Promise((r) => setTimeout(r, 300));
          return read();
        })
        .finally(() => (this.loading = undefined));
    }
    return this.loading;
  }

  /** Whether the metadata changed since it was last read (cheap: one stat). */
  async changed(): Promise<boolean> {
    if (!this.loaded) return false;
    try {
      const st = await fs.stat(this.dbPath);
      return st.mtimeMs !== this.loaded.mtimeMs || st.size !== this.loaded.size;
    } catch {
      return true;
    }
  }

  async node(relPath: string): Promise<SvnNode | undefined> {
    const { db, wcId, uuid } = await this.db();
    const stmt = db.prepare(NODE_SQL, [wcId, relPath]);
    const rows: Row[] = [];
    try {
      while (stmt.step()) rows.push(stmt.getAsObject() as unknown as Row);
    } finally {
      stmt.free();
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
    return {
      relPath,
      schedule: top.op_depth === 0 ? "normal" : top.repos_path !== null ? "copied" : "added",
      reposRoot: origin?.root ?? undefined,
      uuid: origin?.uuid ?? uuid,
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
    return new Uint8Array(await fs.readFile(p));
  }
}
