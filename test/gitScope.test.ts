// Git history beyond one file's trunk: folders, the whole repository, and author,
// message and line filters (flat lists). Built on the fixture repo, plus a few
// commits by other authors that add a folder and merge a branch into it:
//
//   k1  Alice: add src/x.txt, src/y.txt
//   k2  Bob:   edit h.txt ("fix PROJ-7")
//   F:  f1 Alice: edit src/x.txt
//   k3  Bob:   edit other.txt
//   MF  merge F
//   k4  Alice: edit src/y.txt ("fix proj-7 again")
import * as assert from "assert";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { Commit } from "../src/backend";
import { GitRepo, LogQuery } from "../src/git/gitBackend";
import { GitSource } from "../src/history/source";
import { buildFixture, Fixture } from "./gitFixture";

const opts = () => ({ gitPath: "git", timeoutMs: 30000 });

describe("git history scopes and filters (fixture repo)", function () {
  let fx: Fixture;
  let repo: GitRepo;
  let byHash: Map<string, string>;
  const names = (cs: Commit[]) => cs.map((c) => byHash.get(c.rev) ?? c.rev);
  /** git's own answer, for comparison. */
  const gitLog = (...args: string[]) =>
    execFileSync("git", ["log", "--format=%H", ...args], { cwd: fx.dir, encoding: "utf8" }).split("\n").filter(Boolean).map((h) => byHash.get(h) ?? h);

  before(async function () {
    const dir = mkdtempSync(path.join(tmpdir(), "stitch-gitscope-"));
    fx = buildFixture(dir);
    let tick = 1000;
    const run = (who: string, ...args: string[]) => {
      tick++;
      const date = new Date(Date.UTC(2024, 0, 1, 0, 0, tick)).toISOString();
      return execFileSync("git", args, {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: who,
          GIT_AUTHOR_EMAIL: `${who.toLowerCase()}@example.com`,
          GIT_COMMITTER_NAME: who,
          GIT_COMMITTER_EMAIL: `${who.toLowerCase()}@example.com`,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
        encoding: "utf8",
      }).trim();
    };
    const commit = (who: string, name: string, msg = name) => {
      run(who, "commit", "-q", "-m", msg);
      fx.rev[name] = run(who, "rev-parse", "HEAD");
    };
    const edit = (who: string, file: string, text: string) => {
      const p = path.join(dir, file);
      writeFileSync(p, readFileSync(p, "utf8").replace(/^line 26$/m, text).replace(/^line 2$/m, text));
      run(who, "add", file);
    };
    mkdirSync(path.join(dir, "src"));
    const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    writeFileSync(path.join(dir, "src", "x.txt"), body);
    writeFileSync(path.join(dir, "src", "y.txt"), body);
    run("Alice", "add", "src");
    commit("Alice", "k1", "k1 add src");
    edit("Bob", "h.txt", "k2");
    commit("Bob", "k2", "k2 fix PROJ-7");
    run("Bob", "checkout", "-q", "-b", "F");
    edit("Alice", "src/x.txt", "f1");
    commit("Alice", "f1", "f1 feature");
    run("Bob", "checkout", "-q", "main");
    writeFileSync(path.join(dir, "other.txt"), "k3\n");
    run("Bob", "add", "other.txt");
    commit("Bob", "k3", "k3 other");
    run("Tester", "merge", "-q", "--no-ff", "F", "-m", "MF merge F");
    fx.rev.MF = run("Tester", "rev-parse", "HEAD");
    edit("Alice", "src/y.txt", "k4");
    commit("Alice", "k4", "k4 fix proj-7 again");
    byHash = new Map(Object.entries(fx.rev).map(([k, v]) => [v, k]));
    ({ repo } = await GitRepo.open(dir, opts));
  });

  after(function () {
    if (fx) rmSync(fx.dir, { recursive: true, force: true });
  });

  const page = (p: string, query: LogQuery, limit = 50) => repo.page({ from: "HEAD", path: p, limit, query });

  it("a folder: its first-parent trunk, with merges that changed it expanding to their branch", async function () {
    const { commits, next } = await page("src", { kind: "dir" });
    assert.deepStrictEqual(names(commits), ["k4", "MF", "k1"]);
    assert.strictEqual(next, undefined);
    assert.deepStrictEqual(commits.map((c) => c.path), ["src", "src", "src"]);
    assert.strictEqual(commits[0].files, undefined, "a folder's changed files are listed when a commit is expanded");
    const mf = commits[1];
    assert.ok(mf.isMerge);
    const branch = await repo.branchPage(mf, [], 50, undefined, { kind: "dir" });
    assert.deepStrictEqual(names(branch.commits), ["f1"]);
    assert.strictEqual(await repo.branchCount(mf, [], undefined, { kind: "dir" }), 1);
  });

  it("pages a folder's history along the first-parent chain", async function () {
    const seen: string[] = [];
    let req = { from: "HEAD", path: "src", limit: 1, query: { kind: "dir" } as LogQuery } as Parameters<GitRepo["page"]>[0] | undefined;
    while (req) {
      const p = await repo.page(req);
      seen.push(...names(p.commits));
      req = p.next;
    }
    assert.deepStrictEqual(seen, ["k4", "MF", "k1"]);
  });

  it("the whole repository: every first-parent commit, like git log --first-parent", async function () {
    const { commits } = await page("", { kind: "all" }, 100);
    assert.deepStrictEqual(names(commits), gitLog("--first-parent"));
    assert.deepStrictEqual(names(commits).slice(0, 5), ["k4", "MF", "k3", "k2", "k1"]);
  });

  it("filters by author as a flat list, branch commits included", async function () {
    assert.deepStrictEqual(names((await page("", { kind: "all", author: "alice" })).commits), ["k4", "f1", "k1"]);
    assert.deepStrictEqual(names((await page("", { kind: "all", author: "<alice@example.com>" })).commits), ["k4", "f1", "k1"]);
    assert.deepStrictEqual(names((await page("", { kind: "all", author: "<alic@example.com>" })).commits), []);
    assert.deepStrictEqual(names((await page("src", { kind: "dir", author: "ALICE" })).commits), ["k4", "f1", "k1"]);
  });

  it("filters by message (any case, as plain text) and by author and message together", async function () {
    assert.deepStrictEqual(names((await page("", { kind: "all", message: "proj-7" })).commits), ["k4", "k2"]);
    assert.deepStrictEqual(names((await page("", { kind: "all", message: "proj-7", author: "bob" })).commits), ["k2"]);
    assert.deepStrictEqual(names((await page("", { kind: "all", message: "[a-z]" })).commits), [], "not a regex");
  });

  it("filters a file's history (following renames) by author", async function () {
    const got = names((await page("h.txt", { kind: "file", author: "tester" })).commits);
    assert.deepStrictEqual(got, gitLog("--follow", "--author=tester", "-i", "--", "h.txt"));
    assert.ok(got.includes("d1") && got.includes("e2"), "branch commits are in the flat list");
    assert.ok(!got.includes("k2"));
  });

  it("follows lines back through renames and onto branches (-L), with each row's path", async function () {
    const { commits } = await page("h.txt", { kind: "file", lines: { start: 2, end: 6 } });
    assert.deepStrictEqual(names(commits), ["d1", "a1", "c1", "c0"]);
    assert.deepStrictEqual(commits.map((c) => c.path), ["f.txt", "f.txt", "f.txt", "f.txt"]);
    assert.deepStrictEqual(commits.map((c) => c.oldPath), ["f.txt", "f.txt", "f.txt", undefined]);
    // Line 26 was changed by k2 only (since c0).
    assert.deepStrictEqual(names((await page("h.txt", { kind: "file", lines: { start: 26, end: 26 } })).commits), ["k2", "c0"]);
  });

  it("pages flat lists with --skip", async function () {
    const first = await page("h.txt", { kind: "file", lines: { start: 2, end: 6 } }, 3);
    assert.deepStrictEqual(names(first.commits), ["d1", "a1", "c1"]);
    assert.ok(first.next);
    const second = await repo.page(first.next!);
    assert.deepStrictEqual(names(second.commits), ["c0"]);
    assert.strictEqual(second.next, undefined);
  });

  it("counts what the filters hide in a folder or the whole repository", async function () {
    const count = (...a: string[]) => Number(execFileSync("git", ["rev-list", "--count", ...a], { cwd: fx.dir, encoding: "utf8" }).trim());
    assert.deepStrictEqual(await repo.filterCounts("HEAD", "", { kind: "all", author: "bob" }), {
      shown: 2,
      total: count("HEAD", "--"),
    });
    assert.deepStrictEqual(await repo.filterCounts("HEAD", "src", { kind: "dir", message: "again" }), {
      shown: 1,
      total: count("HEAD", "--", "src"),
    });
  });

  it("GitSource: a folder's rows load their files when asked; flat lists don't expand merges", async function () {
    const src = new GitSource(repo, "src", "HEAD", { kind: "dir" });
    assert.ok(src.scoped && !src.flat);
    const top = await src.top(20);
    assert.deepStrictEqual(names(top.commits), ["k4", "MF", "k1"]);
    await src.files([top.commits[1]]);
    assert.deepStrictEqual(top.commits[1].files?.map((f) => f.path), ["src/x.txt"]);
    const flat = new GitSource(repo, "", "HEAD", { kind: "all", message: "merge" });
    assert.ok(flat.flat && flat.scoped);
    assert.ok(names((await flat.top(20)).commits).includes("MF"));
    assert.deepStrictEqual(await flat.filterCounts(), { shown: (await page("", { kind: "all", message: "merge" }, 100)).commits.length, total: Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: fx.dir, encoding: "utf8" })) });
    assert.notStrictEqual(src.key, flat.key);
    assert.notStrictEqual(new GitSource(repo, "src", "HEAD", { kind: "dir", author: "a" }).key, new GitSource(repo, "src", "HEAD", { kind: "dir", author: "b" }).key);
  });

  it("lines: no incoming list and no hidden count", async function () {
    const src = new GitSource(repo, "h.txt", "HEAD", { kind: "file", lines: { start: 2, end: 6 } });
    const top = await src.top(20);
    assert.strictEqual(top.incoming, undefined);
    assert.strictEqual(await src.filterCounts(), undefined);
  });
});
