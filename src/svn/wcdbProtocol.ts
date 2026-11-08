// What the main thread and the wc.db worker (wcdbWorker.ts) send each other,
// plus the helpers both sides use. No side effects, so either side may import it.
import type { BigIntStats } from "fs";

export interface Query {
  sql: string;
  params: (string | number)[];
}

export interface WcDbRequest {
  id: number;
  /** Absolute path of a .svn/wc.db. */
  path: string;
  queries: Query[];
}

export type Row = Record<string, string | number | Uint8Array | null>;

export type WcDbResponse =
  | { id: number; ok: true; stamp: string; results: Row[][] }
  | { id: number; ok: false; message: string; code?: string; kind: WcDbFailure };

/**
 * Why a read failed: "missing" (no wc.db, or no access), "damaged" (not a valid
 * SQLite file, or kept changing mid-read), "unavailable" (node:sqlite missing,
 * i.e. VS Code older than 1.101), "error" (anything else).
 */
export type WcDbFailure = "missing" | "damaged" | "unavailable" | "error";

/** Identifies one version of wc.db on disk. Any write by svn changes it. */
export function stampOf(st: BigIntStats): string {
  return `${st.mtimeNs}:${st.size}:${st.ino}`;
}

/**
 * The SQLite URI Stitch opens wc.db with:
 *  - mode=ro: the connection can't write.
 *  - immutable=1: SQLite takes no locks and never looks at the journal, so it
 *    can't create, roll back or delete one, and it never waits on svn's locks
 *    (locking over SMB/NFS is slow and unreliable). In exchange SQLite assumes the
 *    file doesn't change, so the worker reopens the connection whenever the stamp
 *    changes, and retries a read that overlapped a write.
 * Only "%", "?" and "#" need escaping in an SQLite URI path. Windows paths become
 * file:///C:/… and UNC paths file:////server/share/… (an empty authority).
 */
export function wcdbUri(file: string): string {
  let p = file.replace(/\\/g, "/");
  if (!p.startsWith("/")) p = "/" + p;
  return "file://" + p.replace(/[%?#]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()) + "?mode=ro&immutable=1";
}

/** Statements the worker runs: SELECT and reading user_version, nothing else (belt and braces: the connection is read-only too). */
export function isReadQuery(sql: string): boolean {
  const s = sql.trim().replace(/\s+/g, " ");
  return /^select\b/i.test(s) ? !s.includes(";") : /^pragma user_version$/i.test(s);
}
