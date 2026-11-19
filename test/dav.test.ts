// SVN history over HTTP, checked against a real mod_dav_svn 1.14 server (podman)
// and against what the real svn client says about the same repository.
import * as assert from "assert";
import * as net from "net";
import { Commit, fileDiff, previousDiff } from "../src/backend";
import { checkRequest, DavClient, DavError, FileRev, fileRevsBody, parseLogReport, RepoInfo, request, textsOf } from "../src/svn/dav";
import { SvnSource } from "../src/svn/svnHistory";
import { mapRepoUrl } from "../src/svn/urlMap";
import { setLogSink } from "../src/log";
import { parseXml } from "../src/svn/xml";
import { Server, startServer } from "./svnServer";

/** Revisions of an `svn log --xml` document: top level, and the children of each. */
function logRevs(xml: string): { rev: number; author: string; msg: string; children: number[] }[] {
  const doc = parseXml(xml);
  const log = doc.children.find((c) => c.name === "log")!;
  return log.children
    .filter((e) => e.name === "logentry")
    .map((e) => ({
      rev: Number(e.attrs.revision),
      author: e.children.find((c) => c.name === "author")?.text ?? "",
      msg: e.children.find((c) => c.name === "msg")?.text ?? "",
      children: e.children.filter((c) => c.name === "logentry").map((c) => Number(c.attrs.revision)),
    }));
}

describe("svn history over HTTP (mod_dav_svn in podman)", function () {
  this.timeout(600000); // the first run builds the image
  let server: Server | undefined;
  let client: DavClient;
  let info: RepoInfo;

  before(async function () {
    server = await startServer();
    if (!server) {
      console.log("      (podman not available: skipping the SVN server tests)");
      this.skip();
    }
    client = new DavClient(() => 10000);
    info = await client.options(`${server.base}/svn/repo/trunk/b.txt`);
  });

  after(function () {
    server?.stop();
  });

  it("OPTIONS: repository root, UUID and youngest revision", async function () {
    assert.strictEqual(info.rootUrl, `${server!.base}/svn/repo`);
    assert.strictEqual(info.uuid, (await server!.expected("uuid.txt")).toString().trim());
    assert.strictEqual(info.youngest, 25);
    assert.strictEqual(info.revRootStub, `${server!.base}/svn/repo/!svn/rvr`);
    const other = await client.options(`${server!.base}/svn/other`);
    assert.notStrictEqual(other.uuid, info.uuid);
  });

  async function allPages(source: SvnSource, limit: number): Promise<Commit[]> {
    const first = await source.top(limit);
    const commits = [...first.commits];
    let next = first.next;
    while (next) {
      const page = await source.more(next, limit);
      commits.push(...page.commits);
      next = page.next;
    }
    return commits;
  }

  it("lists the same revisions as svn log, across pages and a rename", async function () {
    const want = logRevs((await server!.expected("log-b.xml")).toString());
    const source = new SvnSource(client, info, "/wc", "trunk/b.txt", 25);
    for (const limit of [5, 50]) {
      const commits = await allPages(source, limit);
      assert.deepStrictEqual(commits.map((c) => Number(c.rev)), want.map((w) => w.rev), `limit ${limit}`);
      assert.deepStrictEqual(commits.map((c) => c.author), want.map((w) => w.author));
      assert.deepStrictEqual(commits.map((c) => [c.subject, c.body].filter(Boolean).join("\n")), want.map((w) => w.msg));
    }
  });

  it("tracks the file's path and previous revision on every row", async function () {
    const commits = await allPages(new SvnSource(client, info, "/wc", "trunk/b.txt", 25), 50);
    const by = (rev: number) => commits.find((c) => c.rev === String(rev))!;
    assert.deepStrictEqual(
      [by(25).path, by(25).oldPath, by(25).parents, by(25).status],
      ["trunk/b.txt", "trunk/b.txt", ["24"], "M"]
    );
    assert.deepStrictEqual([by(9).path, by(9).oldPath, by(9).parents, by(9).status], ["trunk/b.txt", "trunk/a.txt", ["8"], "R"]);
    assert.deepStrictEqual([by(8).path, by(8).oldPath, by(8).parents], ["trunk/a.txt", "trunk/a.txt", ["7"]]);
    assert.deepStrictEqual([by(2).path, by(2).oldPath, by(2).parents, by(2).status], ["trunk/a.txt", undefined, [], "A"]);
  });

  it("serves content like svn cat, and every row's diff sides exist", async function () {
    for (const [rev, p] of [[2, "trunk/a.txt"], [3, "trunk/a.txt"], [5, "trunk/a.txt"], [8, "trunk/a.txt"], [9, "trunk/b.txt"], [25, "trunk/b.txt"]] as const) {
      assert.deepStrictEqual(await client.get(info, rev, p), await server!.expected(`cat-b-${rev}.txt`), `r${rev}`);
    }
    const commits = await allPages(new SvnSource(client, info, "/wc", "trunk/b.txt", 25), 50);
    for (const c of commits) {
      for (const side of Object.values(previousDiff(c))) {
        if (side.kind === "rev") await client.get(info, Number(side.rev), side.path);
      }
    }
  });

  it("expands keywords on request (?kw=1), byte-identical to svn cat", async function () {
    assert.deepStrictEqual(await client.get(info, 25, "trunk/kw.txt"), await server!.expected("cat-kw-raw.txt"));
    assert.deepStrictEqual(await client.get(info, 25, "trunk/kw.txt", { keywords: true }), await server!.expected("cat-kw.txt"));
    assert.deepStrictEqual(await client.get(info, 25, "trunk/latin1.txt"), await server!.expected("cat-latin1.txt"));
  });

  it("handles paths that need URL encoding", async function () {
    const want = logRevs((await server!.expected("log-space.xml")).toString());
    const commits = await allPages(new SvnSource(client, info, "/wc", "trunk/sp ace#%.txt", 25), 50);
    assert.deepStrictEqual(commits.map((c) => Number(c.rev)), want.map((w) => w.rev));
    assert.strictEqual((await client.get(info, 25, "trunk/sp ace#%.txt")).toString(), "odd name\n");
  });

  it("expands merges to the revisions svn log -g lists", async function () {
    const source = new SvnSource(client, info, "/wc", "trunk/b.txt", 25);
    const commits = await allPages(source, 50);
    const by = (rev: number) => commits.find((c) => c.rev === String(rev))!;
    for (const rev of [8, 15]) {
      const want = logRevs((await server!.expected(`log-g-${rev}.xml`)).toString())[0].children;
      const m = by(rev);
      assert.ok(m.isMerge, `r${rev} may be a merge (it changed svn:mergeinfo on /trunk)`);
      assert.strictEqual(await source.count(m, undefined), want.length, `r${rev} count`);
      const kids = await source.expand(m, undefined, 50);
      assert.deepStrictEqual(kids.commits.map((c) => Number(c.rev)), want, `r${rev} children`);
    }
    const kids = (await source.expand(by(15), undefined, 50)).commits;
    const r14 = kids.find((c) => c.rev === "14")!;
    assert.deepStrictEqual([r14.path, r14.oldPath, r14.parents], ["branches/two/b.txt", "branches/two/b.txt", ["13"]]);
    const r13 = kids.find((c) => c.rev === "13")!;
    assert.deepStrictEqual([r13.path, r13.oldPath, r13.parents, r13.status], ["branches/two/b.txt", "trunk/b.txt", ["12"], "C"]);
    assert.ok(!r13.isMerge && !r14.isMerge);
    for (const c of kids) {
      for (const side of Object.values(previousDiff(c))) {
        if (side.kind === "rev") await client.get(info, Number(side.rev), side.path);
      }
    }
    assert.ok(!by(10).isMerge && !by(6).isMerge && !by(3).isMerge);
  });

  it("lists incoming revisions (after BASE) above the working copy's history", async function () {
    const page = await new SvnSource(client, info, "/wc", "trunk/b.txt", 20).top(50);
    assert.deepStrictEqual(page.incoming?.commits.map((c) => c.rev), ["25", "24", "23", "22", "21"]);
    assert.strictEqual(page.incoming?.label, "your working copy: r20");
    assert.strictEqual(page.incoming?.truncated, false);
    assert.strictEqual(page.commits[0].rev, "20");
    // Limited: the newest incoming ones, flagged as truncated.
    const small = await new SvnSource(client, info, "/wc", "trunk/b.txt", 20).top(2);
    assert.deepStrictEqual(small.incoming?.commits.map((c) => c.rev), ["25", "24"]);
    assert.strictEqual(small.incoming?.truncated, true);
    // Up to date: no incoming section.
    assert.strictEqual((await new SvnSource(client, info, "/wc", "trunk/b.txt", 25).top(50)).incoming, undefined);
    // r11 changed only other.txt: a working copy at r20 or r24 for b.txt… at r24, only r25 is incoming.
    assert.deepStrictEqual((await new SvnSource(client, info, "/wc", "trunk/b.txt", 24).top(50)).incoming?.commits.map((c) => c.rev), ["25"]);
  });

  it("says when the file moved on the server after BASE", async function () {
    // A working copy at r8 has trunk/a.txt, which r9 renamed: the path is gone at HEAD.
    const page = await new SvnSource(client, info, "/wc", "trunk/a.txt", 8).top(50);
    assert.deepStrictEqual(page.incoming?.commits, []);
    assert.match(page.incoming?.note ?? "", /a\.txt isn't at this path in r25/);
    assert.strictEqual(page.commits[0].rev, "8");
  });

  it("knows when the server has new revisions", async function () {
    const source = new SvnSource(client, info, "/wc", "trunk/b.txt", 20);
    assert.strictEqual(await source.serverMoved(), false); // nothing loaded yet
    await source.top(5);
    assert.strictEqual(await source.serverMoved(), false);
  });

  it("lists each revision's changed files like svn log -v (moves folded)", async function () {
    const log = parseXml((await server!.expected("log-b.xml")).toString()).children.find((c) => c.name === "log")!;
    const commits = await allPages(new SvnSource(client, info, "/wc", "trunk/b.txt", 25), 50);
    for (const entry of log.children.filter((e) => e.name === "logentry")) {
      const rev = entry.attrs.revision;
      const paths = entry.children.find((c) => c.name === "paths")!.children;
      const files = paths.filter((p) => p.attrs.kind === "file");
      const movedFrom = new Set(files.filter((p) => p.attrs["copyfrom-path"] && files.some((d) => d.attrs.action === "D" && d.text === p.attrs["copyfrom-path"])).map((p) => p.attrs["copyfrom-path"]));
      const want = files.filter((p) => !(p.attrs.action === "D" && movedFrom.has(p.text))).map((p) => p.text.slice(1)).sort();
      const got = commits.find((c) => c.rev === rev)!.files!.map((f) => f.path);
      assert.deepStrictEqual(got, want, `r${rev}`);
    }
    const by = (rev: string) => commits.find((c) => c.rev === rev)!;
    assert.deepStrictEqual(by("2").files!.map((f) => f.status), ["A", "A", "A", "A", "A"]);
    assert.deepStrictEqual(by("9").files, [{ path: "trunk/b.txt", status: "R", oldPath: "trunk/a.txt", fromRev: "8" }]);
    // Every file's diff sides exist on the server.
    for (const f of by("2").files!) {
      const { left, right } = fileDiff(by("2"), f);
      assert.strictEqual(left.kind, "empty");
      if (right.kind === "rev") await client.get(info, Number(right.rev), right.path);
    }
    const { left } = fileDiff(by("9"), by("9").files![0]);
    assert.deepStrictEqual(left, { kind: "rev", rev: "8", path: "trunk/a.txt" });
  });

  /** Counts HTTP requests (every request() logs one line) while `fn` runs; `methods`: only those. */
  async function requestsDuring(fn: () => Promise<unknown>, methods = /^(OPTIONS|GET|REPORT) /): Promise<number> {
    let n = 0;
    setLogSink((_level, m) => {
      if (methods.test(m)) n++;
    });
    try {
      await fn();
    } finally {
      setLogSink(() => undefined);
    }
    return n;
  }

  it("reuses a fresh OPTIONS answer for the youngest revision", async function () {
    const fresh = new DavClient(() => 10000);
    const repo = await fresh.options(`${server!.base}/svn/repo`);
    // Just opened: log + incoming only, no second OPTIONS.
    const source = new SvnSource(fresh, repo, "/wc", "trunk/b.txt", 20);
    assert.strictEqual(await requestsDuring(() => source.top(50)), 2);
    // Reload checks always ask.
    assert.strictEqual(await requestsDuring(() => fresh.youngest(repo)), 1);
  });

  it("asks the server about a file at most once per interval", async function () {
    const source = new SvnSource(client, info, "/wc", "trunk/b.txt", 20, () => 60_000);
    let first: unknown;
    assert.ok((await requestsDuring(async () => (first = await source.top(50)))) >= 2); // log + incoming (+ youngest if stale)
    let again: unknown;
    assert.strictEqual(await requestsDuring(async () => (again = await source.top(50))), 0);
    assert.strictEqual(again, first);
    assert.strictEqual(await requestsDuring(() => source.needsReload()), 0); // fetched just now
    // Merge checks are fetched once and kept.
    const merge = (first as { commits: Commit[] }).commits.find((c) => c.rev === "15")!;
    await source.count(merge, undefined);
    assert.strictEqual(await requestsDuring(() => source.count(merge, undefined)), 0);
  });

  it("remembers a failure for the interval instead of asking again", async function () {
    const source = new SvnSource(client, info, "/wc", "trunk/nope.txt", 25, () => 60_000);
    await assert.rejects(source.top(50), (e: DavError) => e.kind === "notFound");
    assert.strictEqual(await requestsDuring(() => assert.rejects(source.top(50), (e: DavError) => e.kind === "notFound")), 0);
    const down = new DavClient(() => 2000, () => 60_000);
    await assert.rejects(down.options("http://127.0.0.1:1/svn/repo"));
    assert.strictEqual(await requestsDuring(() => assert.rejects(down.options("http://127.0.0.1:1/svn/repo"))), 0);
  });

  it("checks for new server revisions once the interval has passed", async function () {
    const source = new SvnSource(client, info, "/wc", "trunk/b.txt", 20, () => 0);
    await source.top(50);
    assert.strictEqual(await requestsDuring(async () => assert.strictEqual(await source.needsReload(), false)), 1);
  });

  it("reports a missing repository, a non-svn URL and an unreachable server clearly", async function () {
    await assert.rejects(client.options(`${server!.base}/svn/nope/x`), (e: DavError) => e.kind === "notFound");
    await assert.rejects(client.options(`${server!.base}/expected/`), (e: DavError) => e.kind === "protocol" || e.kind === "tooOld");
    await assert.rejects(client.get(info, 3, "trunk/b.txt"), (e: DavError) => e.kind === "notFound");
    await assert.rejects(new DavClient(() => 2000).options("http://127.0.0.1:1/svn/repo"), (e: DavError) => e.kind === "unreachable");
  });

  // ---- history scopes and filters ------------------------------------------

  /** Every row of a history, following Load more and search steps to the end, and the revisions searched. */
  async function everything(source: SvnSource, limit = 50): Promise<{ commits: Commit[]; scanned: number; steps: number }> {
    const first = await source.top(limit);
    const commits = [...first.commits];
    let scanned = first.searched?.scanned ?? 0;
    let steps = 1;
    let next = first.next;
    while (next) {
      const page = await source.more(next, limit);
      commits.push(...page.commits);
      scanned += page.searched?.scanned ?? 0;
      steps++;
      next = page.next;
    }
    return { commits, scanned, steps };
  }
  const revs = (cs: Commit[]) => cs.map((c) => Number(c.rev));

  it("a folder's history is svn log of the folder, following it through its copy", async function () {
    for (const [folder, file] of [["trunk", "log-trunk.xml"], ["branches/two", "log-two.xml"]]) {
      const want = logRevs((await server!.expected(file)).toString()).map((w) => w.rev);
      for (const limit of [3, 50]) {
        const { commits } = await everything(new SvnSource(client, info, "/wc", folder, 25, () => 0, { folder: true }), limit);
        assert.deepStrictEqual(revs(commits), want, `${folder}, pages of ${limit}`);
      }
    }
    const two = (await everything(new SvnSource(client, info, "/wc", "branches/two", 25, () => 0, { folder: true }))).commits;
    const r13 = two.find((c) => c.rev === "13")!;
    assert.deepStrictEqual([r13.path, r13.oldPath], ["branches/two", "trunk"]);
    assert.strictEqual(two.find((c) => c.rev === "10")!.path, "trunk", "older rows are at the copy source's path");
  });

  it("a folder's rows list every file they changed, and merges into it expand like svn log -g", async function () {
    const source = new SvnSource(client, info, "/wc", "trunk", 25, () => 0, { folder: true });
    assert.ok(source.scoped);
    const { commits } = await everything(source);
    const r2 = commits.find((c) => c.rev === "2")!;
    assert.deepStrictEqual(r2.files?.map((f) => f.path), ["trunk/a.txt", "trunk/kw.txt", "trunk/latin1.txt", "trunk/other.txt", "trunk/sp ace#%.txt"]);
    const r15 = commits.find((c) => c.rev === "15")!;
    assert.ok(r15.isMerge);
    const want = logRevs((await server!.expected("log-g-trunk-15.xml")).toString())[0].children;
    assert.deepStrictEqual(revs((await source.expand(r15, undefined, 50)).commits), want);
  });

  it("a folder's incoming revisions start at the folder's own BASE, which the separator explains", async function () {
    const page = await new SvnSource(client, info, "/wc", "trunk", 20, () => 0, { folder: true }).top(50);
    assert.deepStrictEqual(page.incoming?.commits.map((c) => c.rev), ["25", "24", "23", "22", "21"]);
    assert.match(page.incoming!.tooltip, /folder's own revision.*mixed-revision/);
  });

  it("filters by author or message page by page, like svn log filtered by hand", async function () {
    const all = logRevs((await server!.expected("log-b.xml")).toString());
    const byAlice = all.filter((w) => w.author === "alice").map((w) => w.rev);
    const alice = await everything(new SvnSource(client, info, "/wc", "trunk/b.txt", 25, () => 0, { filters: { author: { text: "ALICE" } } }));
    assert.deepStrictEqual(revs(alice.commits), byAlice);
    assert.strictEqual(alice.scanned, all.length, "every revision of the file was looked at");
    const exact = await everything(new SvnSource(client, info, "/wc", "trunk/b.txt", 25, () => 0, { filters: { author: { text: "alic", exact: true } } }));
    assert.deepStrictEqual(exact.commits, []);
    const edits = await everything(new SvnSource(client, info, "/wc", "trunk/b.txt", 25, () => 0, { filters: { message: "EDIT B", author: { text: "bob" } } }));
    assert.deepStrictEqual(revs(edits.commits), all.filter((w) => /edit b/i.test(w.msg) && w.author === "bob").map((w) => w.rev));
    // Incoming revisions are filtered too.
    const incoming = await new SvnSource(client, info, "/wc", "trunk/b.txt", 14, () => 0, { filters: { author: { text: "alice" } } }).top(50);
    assert.deepStrictEqual(incoming.incoming?.commits.map((c) => c.rev), ["15"]);
  });

  it("follows a line range back through the file's revisions, across a rename", async function () {
    const lines = (start: number, end: number) => ({ lines: { range: { start, end }, editor: { start, end }, uncommitted: false } });
    // r10 edited line 4 and r3 line 2 (of a.txt, renamed to b.txt in r9); r2 added the file.
    const early = await everything(new SvnSource(client, info, "/wc", "trunk/b.txt", 25, () => 0, { filters: lines(2, 4) }));
    assert.deepStrictEqual(revs(early.commits), [10, 3, 2]);
    // r16–r18 edited lines 21–23; nothing else did until the file was added.
    const late = new SvnSource(client, info, "/wc", "trunk/b.txt", 25, () => 0, { filters: lines(21, 23) });
    assert.deepStrictEqual(revs((await everything(late)).commits), [18, 17, 16, 2]);
    const top = await late.top(50);
    assert.strictEqual(top.incoming, undefined, "no incoming list for a line range");
    assert.ok(top.searched && top.searched.scanned <= 5, "a step looks at a few revisions, then the view shows progress");
    // Served again (a reload within the interval): the search can still go on from the remembered first page.
    assert.deepStrictEqual(revs((await everything(late)).commits), [18, 17, 16, 2]);
  });

  it("gets a line search's texts with one file-revs-report per log page, not a GET per revision", async function () {
    const lines = { lines: { range: { start: 21, end: 23 }, editor: { start: 21, end: 23 }, uncommitted: false } };
    const fresh = new DavClient(() => 10000);
    const repo = await fresh.options(`${server!.base}/svn/repo/trunk/b.txt`);
    let found: number[] = [];
    const gets = await requestsDuring(async () => {
      found = revs((await everything(new SvnSource(fresh, repo, "/wc", "trunk/b.txt", 25, () => 0, { filters: lines }))).commits);
    }, /^GET /);
    assert.deepStrictEqual(found, [18, 17, 16, 2]);
    assert.strictEqual(gets, 0);
  });

  it("falls back to a GET per revision when the server can't answer a file-revs-report", async function () {
    let asked = 0;
    class NoFileRevs extends DavClient {
      override async fileRevs(): Promise<FileRev[]> {
        asked++;
        throw new DavError("REPORT: HTTP 501", "http", 501);
      }
    }
    const broken = new NoFileRevs(() => 10000);
    const repo = await broken.options(`${server!.base}/svn/repo/trunk/b.txt`);
    const lines = (start: number, end: number) => ({ lines: { range: { start, end }, editor: { start, end }, uncommitted: false } });
    const search = (s: number, e: number) => everything(new SvnSource(broken, repo, "/wc", "trunk/b.txt", 25, () => 0, { filters: lines(s, e) }));
    let found: number[] = [];
    const gets = await requestsDuring(async () => {
      found = revs((await search(21, 23)).commits);
    }, /^GET /);
    assert.deepStrictEqual(found, [18, 17, 16, 2]);
    assert.ok(gets > 0);
    assert.deepStrictEqual(revs((await search(2, 4)).commits), [10, 3, 2]);
    assert.strictEqual(asked, 1, "not asked again for the same repository");
  });

  it("file-revs-report rebuilds each revision's text exactly as GET serves it, in both orders, across a rename", async function () {
    assert.strictEqual(info.reverseFileRevs, true, "1.14 sends it newest first when asked");
    const all = [2, 3, 6, 8, 9, 10, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25];
    for (const [start, end, want] of [[0, 25, all], [25, 0, [...all].reverse()]] as const) {
      const revs = await client.fileRevs(info, "trunk/b.txt", start, end);
      assert.deepStrictEqual(revs.map((r) => r.rev), want);
      assert.deepStrictEqual([...new Set(revs.map((r) => r.path))].sort(), ["/trunk/a.txt", "/trunk/b.txt"]);
      const texts = textsOf(revs);
      for (const [i, r] of revs.entries()) assert.ok(texts[i].equals(await client.get(info, r.rev, r.path)), `r${r.rev}`);
    }
    // A range reaches down to the last change at or before its lower end.
    assert.deepStrictEqual((await client.fileRevs(info, "trunk/b.txt", 18, 12)).map((r) => r.rev), [18, 17, 16, 15, 10]);
    // Keywords stay contracted, as stored (like get() without keywords).
    const kw = await client.fileRevs(info, "trunk/kw.txt", 25, 0);
    const kwTexts = textsOf(kw);
    for (const [i, r] of kw.entries()) assert.ok(kwTexts[i].equals(await client.get(info, r.rev, "trunk/kw.txt")), `kw r${r.rev}`);
  });

  it("GETs each revision from servers that can't send a file-revs-report newest first", async function () {
    const plain = new DavClient(() => 10000);
    const repo = { ...(await plain.options(`${server!.base}/svn/repo/trunk/b.txt`)), reverseFileRevs: false };
    const lines = { lines: { range: { start: 21, end: 23 }, editor: { start: 21, end: 23 }, uncommitted: false } };
    let asked = 0;
    const original = plain.fileRevs.bind(plain);
    plain.fileRevs = (...args) => (asked++, original(...args));
    let found: number[] = [];
    const gets = await requestsDuring(async () => {
      found = revs((await everything(new SvnSource(plain, repo, "/wc", "trunk/b.txt", 25, () => 0, { filters: lines }))).commits);
    }, /^GET /);
    assert.deepStrictEqual(found, [18, 17, 16, 2]);
    assert.strictEqual(asked, 0, "not asked for");
    assert.ok(gets > 0);
  });

  it("a file-revs-report that times out isn't asked for again (it would wait the full timeout on every page)", async function () {
    let asked = 0;
    class Slow extends DavClient {
      override async fileRevs(): Promise<FileRev[]> {
        asked++;
        throw new DavError("No answer within 15000 ms", "timeout");
      }
    }
    const slow = new Slow(() => 10000);
    const repo = await slow.options(`${server!.base}/svn/other`);
    const lines = { lines: { range: { start: 12, end: 15 }, editor: { start: 12, end: 15 }, uncommitted: false } };
    const search = () => everything(new SvnSource(slow, repo, "/wc", "lines.txt", 7, () => 0, { filters: lines }));
    assert.deepStrictEqual(revs((await search()).commits), [6, 3, 1]);
    assert.deepStrictEqual(revs((await search()).commits), [6, 3, 1]);
    assert.strictEqual(asked, 1);
  });

  it("follows lines that move: insertions and deletions above, edits and insertions inside", async function () {
    const other = await client.options(`${server!.base}/svn/other`);
    const lines = (start: number, end: number) => ({ lines: { range: { start, end }, editor: { start, end }, uncommitted: false } });
    const text = (await server!.expected("cat-lines.txt")).toString().split("\n");
    // In r7, "line 10" … "line 12" (with the line inserted in r6) are lines 12–15.
    assert.deepStrictEqual(text.slice(11, 15), ["line 10", "inserted", "line 11 o3", "line 12"]);
    const walk = (s: number, e: number) => everything(new SvnSource(client, other, "/wc", "lines.txt", 7, () => 0, { filters: lines(s, e) }));
    assert.deepStrictEqual(revs((await walk(12, 15)).commits), [6, 3, 1]);
    // Only the inserted line: it came in with r6, and the search ends there.
    const inserted = await walk(13, 13);
    assert.deepStrictEqual(revs(inserted.commits), [6]);
    assert.strictEqual(inserted.scanned, 2, "r7 and r6, nothing older");
    // The three lines on top came with r2.
    assert.deepStrictEqual(revs((await walk(1, 3)).commits), [2]);
    // Outside the range: only r4's edit and r1.
    assert.deepStrictEqual(revs((await walk(5, 5)).commits), [4, 1]);
    // With an author filter as well, both must match.
    const carol = await everything(
      new SvnSource(client, other, "/wc", "lines.txt", 7, () => 0, { filters: { ...lines(12, 15), author: { text: "carol" } } })
    );
    assert.deepStrictEqual(revs(carol.commits), [3]);
  });

  // ---- line searches on unusual histories (/srv/svn/edge, see build-repo.sh) ----

  const SPECIAL = `trunk/é &<>'".txt`;
  const edgeLines = (start: number, end: number) => ({ lines: { range: { start, end }, editor: { start, end }, uncommitted: false } });
  /** The revisions a line search on the edge repository finds (BASE r90 unless said). */
  async function edgeSearch(c: DavClient, repo: RepoInfo, file: string, start: number, end: number, peg = 90) {
    const found = await everything(new SvnSource(c, repo, "/wc", file, peg, () => 0, { filters: edgeLines(start, end) }));
    return { revs: revs(found.commits), scanned: found.scanned };
  }
  /** Every line alone, every other 3-line range, the whole file. */
  const edgeRanges = (n: number) => [
    ...Array.from({ length: n }, (_, i) => [i + 1, i + 1]),
    ...Array.from({ length: Math.max(0, n - 2) }, (_, i) => [i + 1, i + 3]).filter(([s]) => s % 2 === 1),
    [1, n],
  ];

  /**
   * Line searches over `ranges` with texts from file-revs-reports, then with a GET per
   * revision: the same revisions, and no GET at all in the first. Returns the results by "start-end".
   */
  async function sameWithoutFileRevs(file: string, ranges: number[][], peg = 90): Promise<Map<string, number[]>> {
    const reports = new DavClient(() => 10000);
    const repo = await reports.options(`${server!.base}/svn/edge`);
    assert.strictEqual(repo.reverseFileRevs, true);
    const gets = new DavClient(() => 10000);
    const plain = { ...repo, reverseFileRevs: false };
    const results = new Map<string, number[]>();
    for (const [s, e] of ranges) {
      let withReports: number[] = [];
      const n = await requestsDuring(async () => {
        withReports = (await edgeSearch(reports, repo, file, s, e, peg)).revs;
      }, /^GET /);
      assert.strictEqual(n, 0, `${file} lines ${s}–${e}: GETs with file-revs-reports`);
      assert.deepStrictEqual(withReports, (await edgeSearch(gets, plain, file, s, e, peg)).revs, `${file} lines ${s}–${e}`);
      results.set(`${s}-${e}`, withReports);
    }
    return results;
  }

  /** Per line of the file at r90, the revision svn blame names. */
  async function blame(name: string): Promise<number[]> {
    const doc = parseXml((await server!.expected(`edge-blame-${name}.xml`)).toString());
    const target = doc.children.find((c) => c.name === "blame")!.children.find((c) => c.name === "target")!;
    return target.children.filter((c) => c.name === "entry").map((e) => Number(e.children.find((c) => c.name === "commit")!.attrs.revision));
  }

  /** A single-line search's newest revision is the one svn blame names for that line. */
  async function matchesBlame(results: Map<string, number[]>, name: string) {
    const want = await blame(name);
    assert.strictEqual(want.length, 30);
    want.forEach((rev, i) => assert.strictEqual(results.get(`${i + 1}-${i + 1}`)?.[0], rev, `${name} line ${i + 1}`));
  }

  it("line search on a file replaced by a branch copy (from a revision that didn't change it there), then a property-only change", async function () {
    const r = await sameWithoutFileRevs("trunk/f.txt", edgeRanges(30));
    await matchesBlame(r, "f.txt");
    // r5 and r7 edited trunk's f.txt, which r8 replaced by branches/b/f.txt@7: their lines came from r2.
    assert.deepStrictEqual(r.get("5-5"), [2]);
    assert.deepStrictEqual(r.get("7-7"), [2]);
    assert.deepStrictEqual(r.get("6-6"), [6, 2], "r6 is the branch's edit");
    assert.deepStrictEqual(r.get("2-2"), [3, 2], "r3: before the branch");
    // r18 changed only a property: never listed.
    assert.deepStrictEqual(r.get("1-30"), [19, 9, 6, 3, 2]);
  });

  it("line search on a file deleted and brought back from an older revision of itself", async function () {
    const r = await sameWithoutFileRevs("trunk/d.txt", edgeRanges(30));
    await matchesBlame(r, "d.txt");
    assert.deepStrictEqual(r.get("5-5"), [2], "r5's edit was dropped: r11 copied d@3");
    assert.deepStrictEqual(r.get("12-12"), [12, 2]);
    assert.deepStrictEqual(r.get("1-30"), [12, 3, 2]);
  });

  it("line search on a file deleted, added again and replaced, both without copy", async function () {
    const r = await sameWithoutFileRevs("trunk/r.txt", edgeRanges(30));
    await matchesBlame(r, "r.txt");
    assert.deepStrictEqual(r.get("4-4"), [16, 15]);
    assert.deepStrictEqual(r.get("1-30"), [16, 15], "ends at the replacement: a new file");
  });

  it("line search on a path with non-ASCII and XML-special characters", async function () {
    const r = await sameWithoutFileRevs(SPECIAL, edgeRanges(30));
    await matchesBlame(r, "special");
    assert.deepStrictEqual(r.get("3-3"), [17, 2]);
    assert.deepStrictEqual(r.get("1-30"), [19, 17, 2]);
  });

  it("line search on a file emptied and filled again", async function () {
    const r = await sameWithoutFileRevs("trunk/e.txt", edgeRanges(30));
    await matchesBlame(r, "e.txt");
    // r23 emptied it: every line of r24 is new.
    assert.deepStrictEqual(r.get("7-7"), [25, 24]);
    assert.deepStrictEqual(r.get("1-1"), [24]);
    assert.deepStrictEqual(r.get("1-30"), [25, 24]);
    // From BASE r23 (0 bytes) there is no line to follow; from r22, before the emptying.
    assert.deepStrictEqual(await sameWithoutFileRevs("trunk/e.txt", [[1, 1], [2, 2], [1, 3]], 22), new Map([["1-1", [22, 2]], ["2-2", [2]], ["1-3", [22, 2]]]));
  });

  it("line search across log pages (66 revisions) and a rename, from several BASE revisions", async function () {
    const r = await sameWithoutFileRevs("trunk/q.txt", edgeRanges(30));
    await matchesBlame(r, "q.txt");
    // The newest 50 log entries are r90–r41: r39 and r2 come from the second page (through the rename in r55).
    assert.deepStrictEqual(r.get("10-10"), [69, 39, 2]);
    assert.deepStrictEqual(r.get("1-1"), [90, 60, 30, 2]);
    assert.deepStrictEqual(r.get("26-26"), [85, 2], "r55 renamed without editing line 26");
    // Other BASE revisions put the page boundary elsewhere (r75: the second page is only r2), or before the rename.
    for (const [peg, file] of [[75, "trunk/q.txt"], [60, "trunk/q.txt"], [54, "trunk/p.txt"]] as const) {
      await sameWithoutFileRevs(file, [[1, 1], [10, 10], [5, 9], [1, 30]], peg);
    }
    // Served again within the interval (the remembered first page): the same revisions.
    const fresh = new DavClient(() => 10000);
    const repo = await fresh.options(`${server!.base}/svn/edge`);
    const source = new SvnSource(fresh, repo, "/wc", "trunk/q.txt", 90, () => 60_000, { filters: edgeLines(10, 10) });
    assert.deepStrictEqual(revs((await everything(source)).commits), [69, 39, 2]);
    assert.deepStrictEqual(revs((await everything(source)).commits), [69, 39, 2]);
  });

  it("line search on a binary file ends quietly; on a file that was binary before, ends there", async function () {
    const bin = await sameWithoutFileRevs("trunk/bin.dat", [[1, 1], [1, 3]]);
    assert.deepStrictEqual(bin.get("1-1"), []);
    const repo = await client.options(`${server!.base}/svn/edge`);
    assert.strictEqual((await edgeSearch(client, repo, "trunk/bin.dat", 1, 1)).scanned, 1, "only the newest revision looked at");
    // mix.txt: text, binary in r20, text again in r21: every line's search ends at r21.
    const mix = await sameWithoutFileRevs("trunk/mix.txt", edgeRanges(30));
    for (const [range, found] of mix) assert.deepStrictEqual(found, [21], range);
  });
});

describe("svn HTTP client without a server", function () {
  it("times out on a server that never answers", async function () {
    const srv = net.createServer(() => undefined).listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      await assert.rejects(new DavClient(() => 300).options(`http://127.0.0.1:${port}/svn/repo`), (e: DavError) => e.kind === "timeout");
    } finally {
      srv.close();
    }
  });

  it("parses nested merged revisions (has-children … version-name -1)", function () {
    const items = parseLogReport(`<?xml version="1.0"?><S:log-report xmlns:S="svn:" xmlns:D="DAV:">
      <S:log-item><D:version-name>9</D:version-name><D:comment encoding="base64">${Buffer.from("héllo <x>").toString("base64")}</D:comment><S:has-children/></S:log-item>
      <S:log-item><D:version-name>7</D:version-name><S:has-children/></S:log-item>
      <S:log-item><D:version-name>5</D:version-name></S:log-item>
      <S:log-item><D:version-name>-1</D:version-name></S:log-item>
      <S:log-item><D:version-name>6</D:version-name><S:subtractive-merge/></S:log-item>
      <S:log-item><D:version-name>-1</D:version-name></S:log-item>
      <S:log-item><D:version-name>4</D:version-name><D:comment>a &amp; b</D:comment></S:log-item>
      </S:log-report>`);
    assert.deepStrictEqual(items.map((i) => i.rev), [9, 4]);
    assert.strictEqual(items[0].message, "héllo <x>");
    assert.strictEqual(items[1].message, "a & b");
    assert.deepStrictEqual(items[0].children.map((i) => i.rev), [7, 6]);
    assert.deepStrictEqual(items[0].children[0].children.map((i) => i.rev), [5]);
    assert.ok(items[0].children[1].subtractive);
  });

  it("maps svn:// URLs by the longest whole-segment prefix", function () {
    const map = { "svn://svn": "http://svn/repos", "svn://svn/special": "https://other/x/" };
    assert.deepStrictEqual(mapRepoUrl("svn://svn/project", map), { kind: "http", url: "http://svn/repos/project", mapped: true });
    assert.deepStrictEqual(mapRepoUrl("svn://svn/special/sub", map), { kind: "http", url: "https://other/x/sub", mapped: true });
    assert.strictEqual(mapRepoUrl("svn://svnx/a", map).kind, "needsMapping");
    assert.strictEqual(mapRepoUrl("svn+ssh://host/r", {}).kind, "needsMapping");
    assert.deepStrictEqual(mapRepoUrl("https://h/svn/r/", {}), { kind: "http", url: "https://h/svn/r", mapped: false });
    assert.strictEqual(mapRepoUrl("file:///r/repo", {}).kind, "unsupported");
    assert.match((mapRepoUrl("svn://svn/x", { "svn://svn": "svn://other" }) as { reason: string }).reason, /isn't an http\(s\) URL/);
  });
});

describe("read-only guarantee: SVN HTTP", function () {
  it("allows only OPTIONS, GET and log-report / file-revs-report REPORTs", function () {
    for (const m of ["PUT", "POST", "DELETE", "MKACTIVITY", "CHECKOUT", "MERGE", "PROPPATCH", "PROPFIND", "LOCK", "UNLOCK", "COPY", "MOVE", "MKCOL"]) {
      assert.throws(() => checkRequest(m), (e: DavError) => e.kind === "readonly", m);
    }
    assert.throws(() => checkRequest("REPORT", '<?xml version="1.0"?><S:update-report xmlns:S="svn:"/>'), /update-report/);
    assert.throws(() => checkRequest("REPORT", "<S:get-locations/>"), /get-locations/);
    assert.throws(() => checkRequest("REPORT", ""), /malformed/);
    assert.throws(() => checkRequest("GET", "body"), /body/);
    checkRequest("OPTIONS", "<D:options/>");
    checkRequest("GET");
    checkRequest("REPORT", '<?xml version="1.0" encoding="utf-8"?><S:log-report xmlns:S="svn:"></S:log-report>');
    checkRequest("REPORT", fileRevsBody(1, 2));
  });

  it("refuses before opening a connection", async function () {
    let connections = 0;
    const srv = net.createServer((s) => {
      connections++;
      s.destroy();
    }).listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const url = `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}/svn/repo`;
    try {
      // Cast: the type already rejects these; the runtime check must too.
      await assert.rejects(request("PUT" as "GET", url, { timeoutMs: 1000 }), /Refusing/);
      await assert.rejects(request("REPORT", url, { timeoutMs: 1000, body: "<S:update-report/>" }), /Refusing/);
      await new Promise((r) => setTimeout(r, 50));
      assert.strictEqual(connections, 0);
    } finally {
      srv.close();
    }
  });
});
