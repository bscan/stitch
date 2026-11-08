// Main-thread side of the wc.db reader: sends queries to one shared worker thread
// (wcdbWorker.ts) and gives up on it after a timeout.
//
// A read that doesn't answer in time is usually stuck in a file system call on a
// hung network share. terminate() can't interrupt such a call: the thread stays
// blocked until the call returns, possibly forever. So an abandoned worker is
// remembered, with the wc.db it was reading, until it actually exits:
//  - reads of that same wc.db fail at once instead of starting another worker
//    that would block the same way (one stuck thread per stuck file, not one per
//    editor switch);
//  - other wc.dbs get a fresh worker, so one dead share doesn't stop local ones;
//  - at most MAX_ABANDONED workers may be stuck at once; past that, every read
//    fails at once until one exits.
// When the share recovers, the blocked call returns, the thread exits, and the
// file is read normally again. Nothing here waits on a timer.
import * as path from "path";
import { Worker } from "worker_threads";
import { elapsed, log } from "../log";
import { Query, Row, WcDbFailure, WcDbRequest, WcDbResponse } from "./wcdbProtocol";

export class WcDbError extends Error {
  constructor(message: string, readonly kind: WcDbFailure | "timeout", readonly code?: string) {
    super(message);
  }
}

interface Pending {
  path: string;
  resolve: (r: { stamp: string; results: Row[][] }) => void;
  reject: (e: WcDbError) => void;
  timer: NodeJS.Timeout;
}

const MAX_ABANDONED = 4;

let worker: Worker | undefined;
/** In send order; the worker answers in order, so the first entry is the one it is running. */
const pending = new Map<number, Pending>();
/** Workers given up on that haven't exited yet, and the wc.db each was reading. */
const abandoned = new Map<Worker, string>();
let nextId = 1;

/** Next to this file: dist/ in the bundle, out/src/svn/ in tests. */
const WORKER_FILE = path.join(__dirname, "wcdbWorker.js");

function failAll(w: Worker, e: WcDbError): void {
  if (worker !== w) return;
  worker = undefined;
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    pending.delete(id);
    p.reject(e);
  }
  w.unref(); // a stuck thread must never keep the process alive
  void w.terminate().catch(() => undefined);
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(WORKER_FILE);
  worker = w;
  w.on("message", (res: WcDbResponse) => {
    const p = pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    clearTimeout(p.timer);
    if (pending.size === 0) w.unref();
    if (res.ok) p.resolve({ stamp: res.stamp, results: res.results });
    else p.reject(new WcDbError(res.message, res.kind, res.code));
  });
  w.on("error", (e) => {
    // The worker couldn't start or crashed. Not finding node:sqlite means an old VS Code.
    const missing = /node:sqlite|No such built-in module/i.test(e.message);
    log.warn(`wc.db reader stopped: ${e.message}`);
    failAll(
      w,
      missing
        ? new WcDbError("Reading SVN 1.7+ working copies needs VS Code 1.101 or newer (Node's built-in SQLite).", "unavailable")
        : new WcDbError(`The wc.db reader failed: ${e.message}`, "error")
    );
  });
  w.on("exit", () => {
    const stuckOn = abandoned.get(w);
    if (abandoned.delete(w)) log.info(`wc.db reader for ${stuckOn} finally exited; that file can be read again`);
    failAll(w, new WcDbError("The wc.db reader stopped.", "error"));
  });
  return w;
}

/** Gives up on a worker that stopped answering, blaming the read it is running. */
function abandon(w: Worker, timeoutMs: number): void {
  if (worker !== w) return;
  const stuckOn = pending.values().next().value!.path;
  abandoned.set(w, stuckOn);
  log.warn(`${stuckOn}: no answer within ${timeoutMs} ms; abandoning the reader (${abandoned.size} stuck)`);
  failAll(w, new WcDbError(`Reading ${stuckOn} took longer than ${timeoutMs} ms (slow or unreachable drive?).`, "timeout"));
}

/** Why a read of `dbPath` must fail right away, if it must. */
function refusal(dbPath: string): WcDbError | undefined {
  for (const p of abandoned.values()) {
    if (p === dbPath) {
      return new WcDbError(`An earlier read of ${dbPath} is still stuck (slow or unreachable drive?); it will be retried once that read returns.`, "timeout");
    }
  }
  if (abandoned.size >= MAX_ABANDONED) {
    return new WcDbError(`${abandoned.size} reads of SVN working copies are stuck (unreachable drives?); no new ones are started until one returns.`, "timeout");
  }
  return undefined;
}

/** Runs read queries on one wc.db, all on the same version of the file. */
export function queryWcDb(dbPath: string, queries: Query[], timeoutMs: number): Promise<{ stamp: string; results: Row[][] }> {
  const refused = refusal(dbPath);
  if (refused) return Promise.reject(refused);
  const w = getWorker();
  const id = nextId++;
  const start = Date.now();
  return new Promise<{ stamp: string; results: Row[][] }>((resolve, reject) => {
    // The worker is synchronous: everything queued behind a stuck read is stuck too.
    const timer = setTimeout(() => abandon(w, timeoutMs), timeoutMs);
    pending.set(id, { path: dbPath, resolve, reject, timer });
    w.ref();
    const req: WcDbRequest = { id, path: dbPath, queries };
    w.postMessage(req);
  }).then((r) => {
    log.debug(`wc.db ${dbPath}: ${queries.length} queries in ${elapsed(start)}`);
    return r;
  });
}

/** Stops the worker (deactivation, tests). */
export async function closeWcDb(): Promise<void> {
  const w = worker;
  if (!w) return;
  failAll(w, new WcDbError("The wc.db reader was closed.", "error"));
}
