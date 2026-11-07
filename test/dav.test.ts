// SVN history over HTTP, checked against a real mod_dav_svn 1.14 server (podman)
// and against what the real svn client says about the same repository.
import * as assert from "assert";
import * as net from "net";
import { Commit, fileDiff, previousDiff } from "../src/backend";
import { checkRequest, DavClient, DavError, parseLogReport, RepoInfo, request } from "../src/svn/dav";
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

  /** Counts HTTP requests (every request() logs one line) while `fn` runs. */
  async function requestsDuring(fn: () => Promise<unknown>): Promise<number> {
    let n = 0;
    setLogSink((_level, m) => {
      if (/^(OPTIONS|GET|REPORT) /.test(m)) n++;
    });
    try {
      await fn();
    } finally {
      setLogSink(() => undefined);
    }
    return n;
  }

  it("asks the server about a file at most once per interval", async function () {
    const source = new SvnSource(client, info, "/wc", "trunk/b.txt", 20, () => 60_000);
    let first: unknown;
    assert.ok((await requestsDuring(async () => (first = await source.top(50)))) >= 3); // youngest + log + incoming
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
  it("allows only OPTIONS, GET and log-report REPORTs", function () {
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
