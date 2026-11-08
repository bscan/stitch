// Read-only client for Subversion's HTTP protocol (HTTPv2, servers 1.7+).
//
// Every network call goes through request(), which allows only the methods
// OPTIONS, GET and REPORT, and only the log-report REPORT. Anything else
// (PUT, MKACTIVITY, CHECKOUT, MERGE, PROPPATCH, LOCK, …) throws before a
// connection is made. Uses Node's http/https, which VS Code patches so the
// user's proxy settings and system certificates apply.
import * as http from "http";
import * as https from "https";
import { bytes, elapsed, log } from "../log";
import { encodeReposPath } from "./svnBackend";
import { child, parseXml, textOf, XmlElement } from "./xml";

export const ALLOWED_METHODS = ["OPTIONS", "GET", "REPORT"] as const;
export type Method = (typeof ALLOWED_METHODS)[number];
export const ALLOWED_REPORTS = ["log-report"];

export type DavErrorKind = "readonly" | "unreachable" | "timeout" | "cancelled" | "auth" | "notFound" | "tooOld" | "http" | "protocol";

export class DavError extends Error {
  constructor(message: string, readonly kind: DavErrorKind, readonly status?: number) {
    super(message);
  }
}

/** Throws unless the request is one this extension may send. Exported for tests. */
export function checkRequest(method: string, body?: string): void {
  if (!(ALLOWED_METHODS as readonly string[]).includes(method)) {
    throw new DavError(`Refusing to send ${method}: Stitch only reads from SVN servers.`, "readonly");
  }
  if (method === "REPORT") {
    const root = /<(?:[\w-]+:)?([\w-]+)[\s>/]/.exec((body ?? "").replace(/^<\?xml[^>]*\?>\s*/, ""))?.[1];
    if (!root || !ALLOWED_REPORTS.includes(root)) {
      throw new DavError(`Refusing to send a ${root ?? "malformed"} REPORT.`, "readonly");
    }
  } else if (method === "GET" && body) {
    throw new DavError("Refusing to send a GET with a body.", "readonly");
  }
}

export interface RequestOptions {
  body?: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** Final URL after redirects. */
  url: string;
}

const MAX_REDIRECTS = 3;

/** The only function in Stitch that talks to an SVN server. */
export async function request(method: Method, url: string, opts: RequestOptions): Promise<Response> {
  checkRequest(method, opts.body);
  let current = url;
  for (let hop = 0; ; hop++) {
    const start = Date.now();
    let res: Response;
    try {
      res = await send(method, current, opts);
    } catch (e) {
      const kind = e instanceof DavError ? e.kind : "error";
      if (kind === "cancelled") log.debug(`${method} ${current} → cancelled after ${elapsed(start)}`);
      else log.warn(`${method} ${current} → ${kind}: ${(e as Error).message} after ${elapsed(start)}`);
      throw e;
    }
    const line = `${method} ${current} → ${res.status}, ${bytes(res.body.length)} in ${elapsed(start)}`;
    if (res.status >= 400) log.warn(line);
    else log.info(line);
    const location = res.headers.location;
    if ([301, 302, 303, 307, 308].includes(res.status) && location && hop < MAX_REDIRECTS) {
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
}

function send(method: Method, url: string, opts: RequestOptions): Promise<Response> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      reject(new DavError(`Bad URL: ${url}`, "protocol"));
      return;
    }
    const mod = u.protocol === "https:" ? https : u.protocol === "http:" ? http : undefined;
    if (!mod) {
      reject(new DavError(`Unsupported URL scheme ${u.protocol}`, "protocol"));
      return;
    }
    if (opts.signal?.aborted) {
      reject(new DavError("Cancelled", "cancelled"));
      return;
    }
    const body = opts.body !== undefined ? Buffer.from(opts.body, "utf8") : undefined;
    const req = mod.request(u, {
      method,
      headers: {
        "User-Agent": "Stitch (read-only VS Code extension)",
        ...(body ? { "Content-Type": "text/xml; charset=utf-8", "Content-Length": String(body.length) } : {}),
        ...opts.headers,
      },
    });
    const timer = setTimeout(() => req.destroy(new DavError(`No answer from ${u.host} within ${opts.timeoutMs} ms`, "timeout")), opts.timeoutMs);
    const onAbort = () => req.destroy(new DavError("Cancelled", "cancelled"));
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        done();
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), url });
      });
      res.on("error", (e) => {
        done();
        reject(e instanceof DavError ? e : new DavError(e.message, "unreachable"));
      });
    });
    req.on("error", (e) => {
      done();
      reject(e instanceof DavError ? e : new DavError(`Can't reach ${u.host}: ${e.message}`, "unreachable"));
    });
    req.end(body);
  });
}

/** The message in a mod_dav_svn <D:error> body, if there is one. */
function serverMessage(body: Buffer): string | undefined {
  const text = body.toString("utf8");
  if (!text.includes("human-readable")) return undefined;
  try {
    const err = parseXml(text).children.find((c) => c.name === "error");
    return child(err, "human-readable")?.text.trim();
  } catch {
    return undefined;
  }
}

function check(res: Response, what: string): Response {
  if (res.status >= 200 && res.status < 300) return res;
  const msg = serverMessage(res.body);
  if (res.status === 401 || res.status === 403) {
    throw new DavError(`The server needs a login for ${what} (HTTP ${res.status}); Stitch supports anonymous read only.`, "auth", res.status);
  }
  if (res.status === 404) throw new DavError(msg ?? `Not found: ${what}`, "notFound", 404);
  throw new DavError(`${what}: HTTP ${res.status}${msg ? `: ${msg}` : ""}`, "http", res.status);
}

export interface RepoInfo {
  /** Repository root URL, absolute, without a trailing slash. */
  rootUrl: string;
  uuid: string;
  youngest: number;
  /** Absolute URL of the revision-root stub ("…/!svn/rvr"). */
  revRootStub: string;
}

export type ChangedPath = {
  action: "A" | "M" | "D" | "R";
  /** Absolute repository path ("/trunk/a.txt"). */
  path: string;
  kind?: string;
  copyFromPath?: string;
  copyFromRev?: number;
  textMods?: boolean;
  propMods?: boolean;
};

export interface LogItem {
  rev: number;
  author?: string;
  date?: Date;
  message?: string;
  paths: ChangedPath[];
  /** A merge: the revisions it merged follow as children (log -g). */
  hasChildren: boolean;
  /** Merged by a reverse merge. */
  subtractive: boolean;
  children: LogItem[];
}

export interface LogOptions {
  start: number;
  end: number;
  limit?: number;
  includeMerged?: boolean;
}

const ACTIONS: Record<string, ChangedPath["action"]> = {
  "added-path": "A",
  "modified-path": "M",
  "deleted-path": "D",
  "replaced-path": "R",
};

function bool(v: string | undefined): boolean | undefined {
  return v === undefined ? undefined : v === "true";
}

function parseItem(el: XmlElement): LogItem {
  const paths: ChangedPath[] = [];
  let rev = NaN;
  let author: string | undefined;
  let date: Date | undefined;
  let message: string | undefined;
  let hasChildren = false;
  let subtractive = false;
  for (const c of el.children) {
    const action = ACTIONS[c.name];
    if (action) {
      paths.push({
        action,
        path: textOf(c) ?? "",
        kind: c.attrs["node-kind"],
        copyFromPath: c.attrs["copyfrom-path"],
        copyFromRev: c.attrs["copyfrom-rev"] !== undefined ? parseInt(c.attrs["copyfrom-rev"], 10) : undefined,
        textMods: bool(c.attrs["text-mods"]),
        propMods: bool(c.attrs["prop-mods"]),
      });
      continue;
    }
    switch (c.name) {
      case "version-name": rev = parseInt(c.text, 10); break;
      case "creator-displayname": author = textOf(c); break;
      case "date": { const t = textOf(c); date = t ? new Date(t) : undefined; break; }
      case "comment": message = textOf(c); break;
      case "has-children": hasChildren = true; break;
      case "subtractive-merge": subtractive = true; break;
    }
  }
  return { rev, author, date, message, paths, hasChildren, subtractive, children: [] };
}

/** Turns the flat item list of a log-report (children follow their merge, closed by rev -1) into a tree. */
export function parseLogReport(xml: string): LogItem[] {
  const doc = parseXml(xml);
  const report = doc.children.find((c) => c.name === "log-report");
  if (!report) throw new DavError("Unexpected log response from the server", "protocol");
  const top: LogItem[] = [];
  const stack: LogItem[] = [];
  for (const el of report.children) {
    if (el.name !== "log-item") continue;
    const item = parseItem(el);
    if (!Number.isFinite(item.rev) || item.rev < 0) {
      stack.pop(); // end of a merge's children
      continue;
    }
    (stack.length ? stack[stack.length - 1].children : top).push(item);
    if (item.hasChildren) stack.push(item);
  }
  return top;
}

export function logReportBody(o: LogOptions): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<S:log-report xmlns:S="svn:">' +
    `<S:start-revision>${o.start}</S:start-revision>` +
    `<S:end-revision>${o.end}</S:end-revision>` +
    (o.limit ? `<S:limit>${o.limit}</S:limit>` : "") +
    "<S:discover-changed-paths/>" +
    (o.includeMerged ? "<S:include-merged-revisions/>" : "") +
    "<S:revprop>svn:author</S:revprop><S:revprop>svn:date</S:revprop><S:revprop>svn:log</S:revprop>" +
    "<S:path></S:path>" +
    "</S:log-report>"
  );
}

export class DavClient {
  private readonly infos = new Map<string, { p: Promise<RepoInfo>; failedAt?: number }>();
  /** Per repository root: the youngest revision in the last OPTIONS answer, and when it came. */
  private readonly seen = new Map<string, { rev: number; at: number }>();

  constructor(
    private readonly timeoutMs: () => number,
    /** After a failure, the same URL isn't asked again for this long (ms); the failure is returned instead. */
    private readonly retryAfterMs: () => number = () => 0
  ) {}

  /** Repository info for any URL inside a repository. Cached per URL; failures for retryAfterMs. */
  options(url: string, signal?: AbortSignal): Promise<RepoInfo> {
    const cached = this.infos.get(url);
    if (cached && (cached.failedAt === undefined || Date.now() - cached.failedAt < this.retryAfterMs())) return cached.p;
    const entry: { p: Promise<RepoInfo>; failedAt?: number } = { p: this.fetchOptions(url, signal) };
    entry.p.catch((e) => {
      if (e instanceof DavError && e.kind === "cancelled") this.infos.delete(url);
      else entry.failedAt = Date.now();
    });
    this.infos.set(url, entry);
    return entry.p;
  }

  private async fetchOptions(url: string, signal?: AbortSignal): Promise<RepoInfo> {
    const res = check(
      await request("OPTIONS", url, {
        body: '<?xml version="1.0" encoding="utf-8"?><D:options xmlns:D="DAV:"><D:activity-collection-set/></D:options>',
        timeoutMs: this.timeoutMs(),
        signal,
      }),
      url
    );
    const h = (name: string) => {
      const v = res.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    const stub = h("svn-rev-root-stub");
    const root = h("svn-repository-root");
    const uuid = h("svn-repository-uuid");
    if (!stub || !root || !uuid) {
      if (h("dav") === undefined) throw new DavError(`${url} is not a Subversion server.`, "protocol");
      throw new DavError("This SVN server is older than 1.7 (no HTTPv2), which Stitch doesn't support.", "tooOld");
    }
    const origin = new URL(res.url).origin;
    const info = {
      rootUrl: (origin + root).replace(/\/+$/, ""),
      uuid,
      youngest: parseInt(h("svn-youngest-rev") ?? "0", 10),
      revRootStub: origin + stub,
    };
    this.seen.set(info.rootUrl, { rev: info.youngest, at: Date.now() });
    return info;
  }

  /**
   * The server's youngest revision. Reuses the last OPTIONS answer for this repository
   * if it is at most `maxAgeMs` old (default 0: always asks).
   */
  async youngest(info: RepoInfo, signal?: AbortSignal, maxAgeMs = 0): Promise<number> {
    const last = this.seen.get(info.rootUrl);
    if (last && maxAgeMs > 0 && Date.now() - last.at <= maxAgeMs) return last.rev;
    return (await this.fetchOptions(info.rootUrl, signal)).youngest;
  }

  private revUrl(info: RepoInfo, rev: number, path: string): string {
    const p = path.replace(/^\/+/, "");
    return `${info.revRootStub}/${rev}${p ? "/" + encodeReposPath(p) : ""}`;
  }

  /** `svn log -v [-g]` for `path` as it was at `peg` (copies are followed, like svn log). */
  async log(info: RepoInfo, path: string, peg: number, o: LogOptions, signal?: AbortSignal): Promise<LogItem[]> {
    const url = this.revUrl(info, peg, path);
    const res = check(await request("REPORT", url, { body: logReportBody(o), timeoutMs: this.timeoutMs(), signal }), `log of ${path}@${peg}`);
    return parseLogReport(res.body.toString("utf8"));
  }

  /**
   * The file's bytes at a revision: as stored (keywords contracted), or with
   * svn:keywords expanded by the server (`?kw=1`, servers 1.8+; 1.7 ignores it).
   */
  async get(info: RepoInfo, rev: number, path: string, o: { keywords?: boolean } = {}, signal?: AbortSignal): Promise<Buffer> {
    const url = this.revUrl(info, rev, path) + (o.keywords ? "?kw=1" : "");
    return check(await request("GET", url, { timeoutMs: this.timeoutMs(), signal }), `${path}@${rev}`).body;
  }
}
