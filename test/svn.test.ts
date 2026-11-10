// Checks the .svn readers against what a real svn client says about the same
// working copy (test/fixtures/<name>.tar.gz, built by make-svn-fixtures.sh).
process.env.TZ = "UTC"; // the fixture client ran in UTC; $Date$ uses local time

import * as assert from "assert";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "fs";
import { DatabaseSync } from "node:sqlite";
import * as os from "os";
import * as path from "path";
import { contractKeywords, expandKeywords, parseKeywords } from "../src/svn/keywords";
import { parseProps } from "../src/svn/skel";
import { isNotFound } from "../src/errors";
import { encodeReposPath, nodeUrl, SvnError, SvnRepo } from "../src/svn/svnBackend";
import { closeWcDb } from "../src/svn/wcdb";

const FIXTURES = path.resolve(__dirname, "..", "..", "test", "fixtures");

function tag(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];
}

function hashTree(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = statSync(p);
      h.update(path.relative(dir, p) + "\0" + st.mtimeMs + "\0");
      if (st.isDirectory()) walk(p);
      else h.update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}

const FILES = ["a.txt", "sub/c.txt", "old.txt", "latin1.txt", "kw.txt", "eol.txt", "with space.txt", "new.txt", "copied.txt"];

for (const fixture of ["svn16", "svn18", "svn114"]) {
  describe(`svn working copy: ${fixture}`, function () {
    let tmp: string;
    let wc: string;
    let expected: string;
    let repo: SvnRepo;
    let svnHash: string;

    before(async function () {
      tmp = mkdtempSync(path.join(os.tmpdir(), `stitch-${fixture}-`));
      execFileSync("tar", ["xzf", path.join(FIXTURES, `${fixture}.tar.gz`), "-C", tmp]);
      wc = path.join(tmp, "wc");
      expected = path.join(tmp, "expected");
      svnHash = hashTree(path.join(wc, ".svn"));
      repo = await SvnRepo.open(wc);
    });

    after(function () {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    });

    const exp = (f: string, ext: string) => path.join(expected, `${f.replace(/[/ ]/g, "_")}.${ext}`);

    for (const f of FILES) {
      it(`${f}: URL, revision and UUID match svn info`, async function () {
        const info = readFileSync(exp(f, "info.xml"), "utf8");
        const node = await repo.node(path.join(wc, f));
        assert.ok(node, "node found");
        // svn 1.6 omits the UUID for added files; ours is inherited from the folder.
        if (tag(info, "uuid")) assert.strictEqual(node.uuid, tag(info, "uuid"));
        const schedule = tag(info, "schedule");
        if (tag(info, "copy-from-url")) {
          assert.strictEqual(node.schedule, "copied");
          assert.strictEqual(nodeUrl(node), tag(info, "copy-from-url"));
          assert.strictEqual(String(node.revision), tag(info, "copy-from-rev"));
        } else if (schedule === "add") {
          assert.strictEqual(node.schedule, "added");
          assert.strictEqual(node.hasBase, false);
        } else {
          assert.strictEqual(node.schedule, "normal");
          assert.strictEqual(nodeUrl(node), tag(info, "url"));
          assert.strictEqual(node.reposRoot, tag(info, "root"));
          assert.strictEqual(String(node.revision), /<entry[^>]*revision="(\d+)"/.exec(info)?.[1]);
          const sum = tag(info, "checksum");
          assert.strictEqual(sum?.length === 32 ? node.md5 : node.sha1, sum);
        }
      });

      it(`${f}: BASE text matches svn cat -r BASE`, async function () {
        const node = (await repo.node(path.join(wc, f)))!;
        const want = existsSync(exp(f, "base")) ? readFileSync(exp(f, "base")) : Buffer.alloc(0);
        assert.strictEqual(Buffer.from(await repo.original(node)).toString("latin1"), want.toString("latin1"));
        if (existsSync(exp(f, "base-raw"))) {
          assert.deepStrictEqual(Buffer.from(await repo.wc.pristine(node)), readFileSync(exp(f, "base-raw")));
        }
      });
    }

    it("modification state matches svn status", async function () {
      const status = readFileSync(path.join(expected, "status.txt"), "utf8");
      const flagged = new Set(
        status
          .split("\n")
          .filter((l) => /^[MA]/.test(l))
          .map((l) => l.slice(8))
      );
      for (const f of FILES) {
        const node = (await repo.node(path.join(wc, f)))!;
        assert.strictEqual(await repo.isModified(path.join(wc, f), node), flagged.has(f), f);
      }
    });

    it("unversioned and missing files have no node", async function () {
      assert.strictEqual(await repo.node(path.join(wc, "unversioned.txt")), undefined);
      assert.strictEqual(await repo.node(path.join(wc, "nope.txt")), undefined);
      assert.strictEqual(await repo.node(path.join(wc, "sub")), undefined); // a directory
    });

    it("finds the working-copy root from a subfolder", async function () {
      // Only 1.6 has a .svn in subfolders; for 1.7+ the resolver always lands on the root.
      if (!existsSync(path.join(wc, "sub", ".svn"))) this.skip();
      const sub = await SvnRepo.open(path.join(wc, "sub"));
      assert.strictEqual(sub.root, wc);
      assert.strictEqual((await sub.node(path.join(wc, "sub", "c.txt")))?.reposPath, "sub/c.txt");
    });

    it("leaves .svn untouched", function () {
      assert.strictEqual(hashTree(path.join(wc, ".svn")), svnHash);
    });
  });
}

for (const fixture of ["svn16", "svn114"]) {
  describe(`BASE change detection: ${fixture}`, function () {
    let tmp: string;
    let wc: string;

    beforeEach(function () {
      tmp = mkdtempSync(path.join(os.tmpdir(), `stitch-changed-${fixture}-`));
      execFileSync("tar", ["xzf", path.join(FIXTURES, `${fixture}.tar.gz`), "-C", tmp]);
      wc = path.join(tmp, "wc");
    });

    afterEach(function () {
      rmSync(tmp, { recursive: true, force: true });
    });

    /** What `svn update` does to the metadata, as far as change detection can tell. */
    const touchMetadata = () => {
      const db = path.join(wc, ".svn", "wc.db");
      const meta = existsSync(db) ? db : path.join(wc, ".svn", "entries");
      const t = new Date(statSync(meta).mtimeMs + 5000);
      utimesSync(meta, t, t);
    };

    it("still reports a change after a read saw the new metadata", async function () {
      const repo = await SvnRepo.open(wc);
      assert.ok(await repo.node(path.join(wc, "a.txt")));
      assert.strictEqual(await repo.changed(), false);
      touchMetadata();
      // An editor switch reads the file's node before the BASE check runs.
      assert.ok(await repo.node(path.join(wc, "a.txt")));
      assert.strictEqual(await repo.changed(), true);
      assert.strictEqual(await repo.changed(), false, "reported once");
    });
  });
}

describe("skel properties", function () {
  it("parses implicit and explicit atoms", function () {
    const props = parseProps(Buffer.from("(svn:keywords 6 Id Rev custom:p 0 svn:eol-style native)"));
    assert.deepStrictEqual([...props], [
      ["svn:keywords", "Id Rev"],
      ["custom:p", ""],
      ["svn:eol-style", "native"],
    ]);
    assert.strictEqual(parseProps(Buffer.from("()")).size, 0);
    assert.strictEqual(parseProps(null).size, 0);
  });
});

describe("svn keywords", function () {
  const info = {
    rev: 42,
    url: "https://h/svn/r/trunk/dir/my%20file.c",
    reposRoot: "https://h/svn/r",
    author: "jörg",
    date: new Date(Date.UTC(2024, 0, 2, 3, 4, 5)),
  };
  const run = (prop: string, text: string) =>
    Buffer.from(expandKeywords(Buffer.from(text, "utf8"), parseKeywords(prop), info)).toString("utf8");

  it("expands the built-in keywords and their aliases", function () {
    assert.strictEqual(run("Rev", "$Rev$ $Revision$ $LastChangedRevision$"), "$Rev: 42 $ $Revision: 42 $ $LastChangedRevision: 42 $");
    assert.strictEqual(run("id", "$Id$"), "$Id: my file.c 42 2024-01-02 03:04:05Z jörg $");
    assert.strictEqual(run("Header", "$Header$"), "$Header: https://h/svn/r/trunk/dir/my%20file.c 42 2024-01-02 03:04:05Z jörg $");
    assert.strictEqual(run("Date", "$Date$"), "$Date: 2024-01-02 03:04:05 +0000 (Tue, 02 Jan 2024) $");
    assert.strictEqual(run("URL Author", "$HeadURL$ $Author$"), "$HeadURL: https://h/svn/r/trunk/dir/my%20file.c $ $Author: jörg $");
  });

  it("only expands enabled keywords, and re-expands old values", function () {
    assert.strictEqual(run("Rev", "$Id$ $Rev: 7 $"), "$Id$ $Rev: 42 $");
    assert.strictEqual(run("REVISION", "$Rev$"), "$Rev$"); // only the short name is case-insensitive
    assert.strictEqual(run("Rev", "$$Rev$$"), "$$Rev: 42 $$");
    assert.strictEqual(run("Rev", "cost $5 and $Rev$"), "cost $5 and $Rev: 42 $");
  });

  it("keeps fixed-width keywords at their width", function () {
    assert.strictEqual(run("Rev", "$Rev::     $"), "$Rev:: 42  $");
    assert.strictEqual(run("Author", "$Author:: $"), "$Author:: $");
    assert.strictEqual(run("URL", "$URL::      $"), "$URL:: http#$");
  });

  it("supports custom keyword formats", function () {
    assert.strictEqual(run("MyKw=%P@%r%_%%", "$MyKw$"), "$MyKw: trunk/dir/my file.c@42 % $");
  });

  it("contracts expanded keywords", function () {
    const set = parseKeywords("Id Rev");
    const out = contractKeywords(Buffer.from("$Id: x 1 y $ $Rev: 9 $ $Date: d $"), set);
    assert.strictEqual(Buffer.from(out).toString(), "$Id$ $Rev$ $Date: d $");
  });

  it("encodes repository paths like svn", function () {
    assert.strictEqual(encodeReposPath("a b/c#d/e@f+g"), "a%20b/c%23d/e@f+g");
  });
});

describe("damaged and busy svn 1.7+ working copies", function () {
  let tmp: string;
  let wc: string;
  let db: string;

  beforeEach(function () {
    tmp = mkdtempSync(path.join(os.tmpdir(), "stitch-broken-"));
    execFileSync("tar", ["xzf", path.join(FIXTURES, "svn114.tar.gz"), "-C", tmp]);
    wc = path.join(tmp, "wc");
    db = path.join(wc, ".svn", "wc.db");
  });

  afterEach(function () {
    rmSync(tmp, { recursive: true, force: true });
  });

  const damaged = (re: RegExp) => (e: unknown) => e instanceof SvnError && e.kind === "damaged" && re.test(e.message);
  const a = () => path.join(wc, "a.txt");
  /** Writes to the fixture's wc.db the way svn would (tests only). */
  const write = (sql: string) => {
    const w = new DatabaseSync(db);
    w.exec(sql);
    w.close();
  };

  it("reads while svn holds a write lock (immutable: no locks, no journal)", async function () {
    const repo = await SvnRepo.open(wc);
    const w = new DatabaseSync(db);
    try {
      w.exec("BEGIN EXCLUSIVE; UPDATE NODES SET changed_author = 'someone-else'");
      const node = await repo.node(a());
      assert.ok(node);
      assert.notStrictEqual(node.changedAuthor, "someone-else"); // the committed state
    } finally {
      w.exec("ROLLBACK");
      w.close();
    }
  });

  it("notices when svn changed wc.db and reads the new state", async function () {
    const repo = await SvnRepo.open(wc);
    const before = (await repo.node(a()))!;
    assert.strictEqual(await repo.changed(), false);
    write(`UPDATE NODES SET changed_author = 'after-update' WHERE local_relpath = 'a.txt'`);
    assert.strictEqual(await repo.changed(), true);
    const after = (await repo.node(a()))!;
    assert.notStrictEqual(before.changedAuthor, "after-update");
    assert.strictEqual(after.changedAuthor, "after-update");
    assert.strictEqual(await repo.changed(), false);
  });

  it("keeps reading after an interrupted svn command (work queue not empty)", async function () {
    write(`INSERT INTO WORK_QUEUE (work) VALUES (x'00')`);
    assert.ok(await (await SvnRepo.open(wc)).node(a()));
  });

  it("says so when wc.db is truncated, garbage or empty", async function () {
    const bytes = readFileSync(db);
    writeFileSync(db, bytes.subarray(0, Math.floor(bytes.length / 3)));
    await assert.rejects((await SvnRepo.open(wc)).node(a()), damaged(/damaged|cleanup/));
    writeFileSync(db, Buffer.alloc(bytes.length, 0x5a));
    await assert.rejects((await SvnRepo.open(wc)).node(a()), damaged(/damaged/));
    writeFileSync(db, Buffer.alloc(0));
    await assert.rejects((await SvnRepo.open(wc)).node(a()), damaged(/empty or damaged/));
  });

  it("says so when wc.db disappears after the working copy was opened", async function () {
    const repo = await SvnRepo.open(wc);
    rmSync(db);
    await assert.rejects(repo.node(a()), damaged(/missing/));
  });

  it("says so when a file's repository row is gone", async function () {
    write("PRAGMA foreign_keys = OFF; DELETE FROM REPOSITORY");
    await assert.rejects((await SvnRepo.open(wc)).node(a()), damaged(/no repository/));
  });

  it("says so when a BASE text is missing from .svn/pristine", async function () {
    const repo = await SvnRepo.open(wc);
    const node = (await repo.node(a()))!;
    rmSync(path.join(wc, ".svn", "pristine", node.sha1!.slice(0, 2), `${node.sha1}.svn-base`));
    await assert.rejects(repo.original(node), damaged(/pristine/));
    assert.ok(!isNotFound(new SvnError("x", "damaged")), "shown as an error, not as 'file not found'");
  });

  const timedOut = (re: RegExp) => (e: unknown) => e instanceof SvnError && e.kind === "unavailable" && re.test(e.message);
  /** Retries `f` until it resolves (a stuck reader's thread exits asynchronously). */
  const eventually = async <T>(f: () => Promise<T>, ms = 5000): Promise<T> => {
    const end = Date.now() + ms;
    for (;;) {
      try {
        return await f();
      } catch (e) {
        if (Date.now() > end) throw e;
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  };

  it("gives up on a reader that doesn't answer in time, and recovers", async function () {
    await closeWcDb(); // the next read starts a new worker, which can't answer within 0 ms
    await assert.rejects((await SvnRepo.open(wc, () => 0)).node(a()), timedOut(/took longer/));
    assert.ok(await eventually(async () => (await SvnRepo.open(wc)).node(a())));
  });

  it("doesn't pile up threads on a read that stays stuck, and reads again once it returns", async function () {
    if (process.platform === "win32") this.skip();
    // Opening a FIFO blocks in open() until a writer comes, like a read on a hung
    // share: terminate() can't interrupt it, so the thread stays stuck.
    const other = path.join(tmp, "other");
    execFileSync("tar", ["xzf", path.join(FIXTURES, "svn114.tar.gz"), "-C", tmp, "--transform", "s,^wc,other,"]);
    const saved = path.join(tmp, "wc.db.saved");
    copyFileSync(db, saved);
    rmSync(db);
    execFileSync("mkfifo", [db]);
    const repo = await SvnRepo.open(wc, () => 300);

    await assert.rejects(repo.node(a()), timedOut(/took longer than 300 ms/));
    // The same file again: refused at once, without starting another thread.
    const start = Date.now();
    await assert.rejects(repo.node(a()), timedOut(/still stuck/));
    assert.ok(Date.now() - start < 200, "refused without waiting for the timeout");
    // Other working copies still get a reader.
    assert.ok(await (await SvnRepo.open(other)).node(path.join(other, "a.txt")));

    // The "share" comes back: the blocked open() returns, the stuck thread exits,
    // and the file is read normally again.
    closeSync(openSync(db, "w"));
    rmSync(db);
    copyFileSync(saved, db);
    assert.ok(await eventually(() => repo.node(a())));
  });
});

after(() => closeWcDb());
