// Worker thread that reads .svn/wc.db with Node's built-in SQLite (node:sqlite).
//
// node:sqlite is synchronous. On a slow or hung network share a read could block
// for a long time, so it runs here instead of on the extension host's thread; the
// main side (wcdb.ts) times out and replaces a worker that stops answering.
//
// SQLite only reads the pages a query needs, so a large wc.db on a share costs a
// few KB per lookup instead of a copy of the whole file. See wcdbUri() for how the
// file is opened (read-only, immutable: no locks, no journal).
import { statSync } from "fs";
import { DatabaseSync } from "node:sqlite";
import { parentPort } from "worker_threads";
import { isReadQuery, Row, stampOf, WcDbFailure, WcDbRequest, WcDbResponse, wcdbUri } from "./wcdbProtocol";

/** Connections per wc.db, with the stamp of the file they were opened on. */
const open = new Map<string, { db: DatabaseSync; stamp: string }>();
const MAX_OPEN = 8;

/** Reads that overlap a write by svn are retried this often, this far apart. */
const ATTEMPTS = 3;
const RETRY_MS = 200;

class Failure extends Error {
  constructor(message: string, readonly kind: WcDbFailure, readonly code?: string) {
    super(message);
  }
}

function stamp(file: string): string {
  try {
    return stampOf(statSync(file, { bigint: true }));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    throw new Failure(err.message, "missing", err.code);
  }
}

function close(file: string): void {
  const c = open.get(file);
  open.delete(file);
  try {
    c?.db.close();
  } catch {
    // already closed
  }
}

function connection(file: string, st: string): DatabaseSync {
  const cur = open.get(file);
  if (cur && cur.stamp === st) {
    open.delete(file); // re-insert: most recently used last
    open.set(file, cur);
    return cur.db;
  }
  close(file);
  const db = new DatabaseSync(wcdbUri(file), { readOnly: true });
  // A wc.db in an untrusted folder could be crafted: don't let its views or triggers call
  // functions SQLite deems unsafe (SQLite's advice for untrusted database files). This
  // setting lives on the connection, not in the file.
  db.prepare("PRAGMA trusted_schema = OFF").run();
  open.set(file, { db, stamp: st });
  if (open.size > MAX_OPEN) close(open.keys().next().value as string);
  return db;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** SQLite errors that a read overlapping a write can cause (the file looked damaged or truncated). */
const TORN = /malformed|not a database|disk i\/o error|database corrupt|SQLITE_CORRUPT|SQLITE_NOTADB|SQLITE_IOERR/i;

function run(req: WcDbRequest): { stamp: string; results: Row[][] } {
  for (const q of req.queries) {
    if (!isReadQuery(q.sql)) throw new Failure(`Refusing to run a non-read statement on wc.db: ${q.sql.slice(0, 40)}`, "error");
  }
  let last: Failure | undefined;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (attempt > 1) sleep(RETRY_MS);
    const before = stamp(req.path);
    try {
      const db = connection(req.path, before);
      const results = req.queries.map((q) => db.prepare(q.sql).all(...q.params) as Row[]);
      if (stamp(req.path) === before) return { stamp: before, results };
      last = new Failure("wc.db kept changing while it was read (is svn running?)", "damaged");
    } catch (e) {
      if (e instanceof Failure) throw e;
      const msg = (e as Error).message;
      const code = (e as { code?: string }).code;
      if (!TORN.test(msg) && !TORN.test(code ?? "")) throw new Failure(msg, "error", code);
      last = new Failure(msg, "damaged", code);
    }
    close(req.path); // its page cache may hold a half-written state
  }
  throw last!;
}

parentPort?.on("message", (req: WcDbRequest) => {
  let res: WcDbResponse;
  try {
    res = { id: req.id, ok: true, ...run(req) };
  } catch (e) {
    const f = e instanceof Failure ? e : new Failure((e as Error).message, "error");
    res = { id: req.id, ok: false, message: f.message, code: f.code, kind: f.kind };
  }
  parentPort!.postMessage(res);
});
