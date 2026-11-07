import * as assert from "assert";
import { createHash } from "crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { Commit, previousDiff } from "../src/backend";
import { git, GitError } from "../src/git/exec";
import { GitRepo } from "../src/git/gitBackend";
import { buildFixture, Fixture } from "./gitFixture";

const opts = () => ({ gitPath: "git", timeoutMs: 30000 });

function hashTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.set(path.relative(dir, p), createHash("sha1").update(readFileSync(p)).digest("hex"));
    }
  };
  walk(dir);
  return out;
}

describe("git backend (fixture repo)", function () {
  let fx: Fixture;
  let repo: GitRepo;
  let byHash: Map<string, string>;
  let gitDirBefore: Map<string, string>;
  const names = (cs: Commit[]) => cs.map((c) => byHash.get(c.rev) ?? c.rev);
  const find = (cs: Commit[], name: string) => {
    const c = cs.find((x) => x.rev === fx.rev[name]);
    assert.ok(c, `${name} not in list`);
    return c;
  };

  before(async function () {
    const dir = mkdtempSync(path.join(tmpdir(), "stitch-git-"));
    fx = buildFixture(dir);
    byHash = new Map(Object.entries(fx.rev).map(([k, v]) => [v, k]));
    gitDirBefore = hashTree(path.join(dir, ".git"));
    ({ repo } = await GitRepo.open(dir, opts));
  });

  after(function () {
    if (fx) rmSync(fx.dir, { recursive: true, force: true });
  });

  it("finds the repo root and the file's prefix", async function () {
    const { repo: r, prefix } = await GitRepo.open(fx.dir, opts);
    assert.strictEqual(r.root, repo.root);
    assert.strictEqual(prefix, "");
  });

  it("top level is the first-parent trunk, without merges that didn't change the file on trunk", async function () {
    const { commits, next } = await repo.page({ from: "HEAD", path: "h.txt", limit: 50 });
    assert.deepStrictEqual(names(commits), ["PM", "p1", "M3", "c6", "c5", "M2", "c4", "c3", "M1", "c1", "c0"]);
    assert.strictEqual(next, undefined);
    assert.ok(!names(commits).includes("MB"), "MB must not appear");
  });

  it("tracks the path across trunk and branch renames", async function () {
    const { commits } = await repo.page({ from: "HEAD", path: "h.txt", limit: 50 });
    const m3 = find(commits, "M3");
    assert.strictEqual(m3.path, "h.txt");
    assert.strictEqual(m3.oldPath, "g.txt");
    const c5 = find(commits, "c5");
    assert.strictEqual(c5.path, "g.txt");
    assert.strictEqual(c5.oldPath, "f.txt");
    assert.ok(c5.status?.startsWith("R"));
    assert.strictEqual(find(commits, "c4").path, "f.txt");
  });

  it("marks merges, pull merges, refs and the root commit", async function () {
    const { commits } = await repo.page({ from: "HEAD", path: "h.txt", limit: 50 });
    const pm = find(commits, "PM");
    assert.ok(pm.isMerge && pm.isPullMerge);
    assert.ok(find(commits, "M1").isMerge && !find(commits, "M1").isPullMerge);
    assert.ok(!find(commits, "c3").isMerge);
    assert.ok(find(commits, "c1").refs.includes("tag: v1.0"));
    const root = find(commits, "c0");
    assert.deepStrictEqual(root.parents, []);
    assert.strictEqual(previousDiff(root).left.kind, "empty");
  });

  it("pages along the first-parent chain, following renames between pages", async function () {
    const all: string[] = [];
    let req: Parameters<GitRepo["page"]>[0] | undefined = { from: "HEAD", path: "h.txt", limit: 4 };
    let pages = 0;
    while (req) {
      const page = await repo.page(req);
      all.push(...names(page.commits));
      req = page.next;
      pages++;
    }
    assert.deepStrictEqual(all, ["PM", "p1", "M3", "c6", "c5", "M2", "c4", "c3", "M1", "c1", "c0"]);
    assert.strictEqual(pages, 3);
  });

  it("expands a merge into the branch commits it brought in", async function () {
    const { commits } = await repo.page({ from: "HEAD", path: "h.txt", limit: 50 });
    const expand = async (name: string) =>
      names((await repo.branchPage(find(commits, name), [], 50)).commits);
    assert.deepStrictEqual(await expand("PM"), ["r1"]);
    assert.deepStrictEqual(await expand("M3"), ["e2", "e1"]);
    assert.deepStrictEqual(await expand("M2"), ["cc2", "S", "cc1"]);
    assert.deepStrictEqual(await expand("M1"), ["a2", "N", "a1"]);
  });

  it("follows a rename made on the branch", async function () {
    const { commits } = await repo.page({ from: "HEAD", path: "h.txt", limit: 50 });
    const branch = (await repo.branchPage(find(commits, "M3"), [], 50)).commits;
    const e1 = find(branch, "e1");
    assert.strictEqual(e1.path, "h.txt");
    assert.strictEqual(e1.oldPath, "g.txt");
  });

  it("nests: a merge inside a branch expands to its own branch, excluding outer lines", async function () {
    const { commits } = await repo.page({ from: "HEAD", path: "h.txt", limit: 50 });
    const m1 = find(commits, "M1");
    const level1 = (await repo.branchPage(m1, [], 50)).commits;
    const n = find(level1, "N");
    const exclude = GitRepo.childExclude(m1, []);
    assert.deepStrictEqual(names((await repo.branchPage(n, exclude, 50)).commits), ["d1"]);
    assert.strictEqual(await repo.branchCount(n, exclude), 1);

    // The sync merge S only brought in trunk work, which the outer level already shows.
    const m2 = find(commits, "M2");
    const s = find((await repo.branchPage(m2, [], 50)).commits, "S");
    const sExclude = GitRepo.childExclude(m2, []);
    assert.deepStrictEqual((await repo.branchPage(s, sExclude, 50)).commits, []);
    assert.strictEqual(await repo.branchCount(s, sExclude), 0);
  });

  it("counts branch commits for merge rows", async function () {
    const { commits } = await repo.page({ from: "HEAD", path: "h.txt", limit: 50 });
    assert.strictEqual(await repo.branchCount(find(commits, "PM"), []), 1);
    assert.strictEqual(await repo.branchCount(find(commits, "M3"), []), 2);
    assert.strictEqual(await repo.branchCount(find(commits, "M2"), []), 3);
    assert.strictEqual(await repo.branchCount(find(commits, "M1"), []), 3);
  });

  it("diff with previous uses the first parent and the old path", async function () {
    const { commits } = await repo.page({ from: "HEAD", path: "h.txt", limit: 50 });
    const m3 = find(commits, "M3");
    const { left, right } = previousDiff(m3);
    assert.deepStrictEqual(left, { kind: "rev", rev: m3.parents[0], path: "g.txt" });
    assert.deepStrictEqual(right, { kind: "rev", rev: m3.rev, path: "h.txt" });
    // Merge diff vs first parent shows the whole branch's change: e2's line arrives.
    const before = (await repo.show(left.rev, left.path)).toString();
    const after = (await repo.show(right.rev, right.path)).toString();
    assert.ok(!before.includes("e2") && after.includes("e2"));
  });

  it("starts from another ref", async function () {
    const { commits } = await repo.page({ from: "v1.0", path: "f.txt", limit: 50 });
    assert.deepStrictEqual(names(commits), ["c1", "c0"]);
    const refs = await repo.refs();
    assert.ok(refs.branches.includes("main") && refs.tags.includes("v1.0"));
  });

  it("returns an empty page for an untracked file", async function () {
    const { commits } = await repo.page({ from: "HEAD", path: "untracked.txt", limit: 50 });
    assert.deepStrictEqual(commits, []);
  });

  it("left .git byte-for-byte unchanged", function () {
    const afterHashes = hashTree(path.join(fx.dir, ".git"));
    assert.deepStrictEqual([...afterHashes.entries()].sort(), [...gitDirBefore.entries()].sort());
  });

  it("rejects write commands before spawning git", async function () {
    // A nonexistent git path proves no process was started: it would fail as "notFound".
    const bad = { gitPath: "/nonexistent/git", timeoutMs: 1000 };
    for (const args of [
      ["commit", "-m", "x"],
      ["push"],
      ["reset", "--hard"],
      ["checkout", "main"],
      ["gc"],
      ["config", "user.name", "x"],
      ["log", "--output=/tmp/stitch-x"],
      ["log", "--ext-diff"],
      ["show", "--textconv", "HEAD"],
      [],
    ]) {
      await assert.rejects(git(bad, fx.dir, args), (e: unknown) => e instanceof GitError && e.kind === "notAllowed");
    }
    // An allowed command with the bad path fails as notFound, i.e. it did try to spawn.
    await assert.rejects(git(bad, fx.dir, ["log"]), (e: unknown) => e instanceof GitError && e.kind === "notFound");
  });
  it("lists every file a commit changed, against its first parent", async function () {
    const { execFileSync } = await import("child_process");
    const names = ["c0", "c1", "c5", "M1", "MB", "M2", "e1", "N"];
    const files = await repo.changedFiles(names.map((n) => fx.rev[n]));
    for (const n of names) {
      const rev = fx.rev[n];
      // What git itself says (test-only direct call): diff against the first parent, or the root's adds.
      const parent = execFileSync("git", ["rev-list", "--parents", "-n1", rev], { cwd: fx.dir, encoding: "utf8" }).trim().split(" ")[1];
      const args = parent ? ["diff", "-M", "--name-status", parent, rev] : ["show", "--format=", "--name-status", rev];
      const want = execFileSync("git", args, { cwd: fx.dir, encoding: "utf8" })
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const [status, a, b] = l.split("\t");
          return b ? { path: b, status: status[0], oldPath: a } : { path: a, status: status[0] };
        });
      assert.deepStrictEqual(files.get(rev), want, n);
    }
    assert.deepStrictEqual(files.get(fx.rev.c0)!.map((f) => f.path), ["f.txt", "other.txt"]);
    assert.deepStrictEqual(files.get(fx.rev.c5), [{ path: "g.txt", status: "R", oldPath: "f.txt" }]);
  });

  it("fills Commit.files for a page through GitSource", async function () {
    const { GitSource } = await import("../src/history/source");
    const source = new GitSource(repo, "h.txt", "HEAD");
    const page = await source.top(50);
    await source.files(page.commits);
    for (const c of page.commits) {
      assert.ok(c.files, `${byHash.get(c.rev)} has files`);
      assert.ok(c.files.some((f) => f.path === c.path) || c.isMerge, `${byHash.get(c.rev)} lists its own file`);
    }
  });
});

describe("git incoming commits (upstream not in the branch)", function () {
  let dir: string;
  let repo: GitRepo;
  const revs: Record<string, string> = {};
  let gitBefore: Map<string, string>;

  // Test-only setup with git directly: main, plus origin/main ahead of it.
  //   main:        c1
  //   origin/main: c1 ─ u1 (f) ─ um (merge of s1, which changed f) ─ u3 (other only)
  before(async function () {
    const { execFileSync } = await import("child_process");
    const { writeFileSync, appendFileSync } = await import("fs");
    dir = mkdtempSync(path.join(tmpdir(), "stitch-up-"));
    const g = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@x", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@x" },
      }).trim();
    const commit = (name: string, file: string) => {
      appendFileSync(path.join(dir, file), `${name}\n`);
      g("add", file);
      g("commit", "-q", "-m", name);
      revs[name] = g("rev-parse", "HEAD");
    };
    g("init", "-q", "-b", "main");
    writeFileSync(path.join(dir, "other.txt"), "o\n");
    commit("c1", "f.txt");
    g("checkout", "-q", "-b", "up");
    commit("u1", "f.txt");
    g("checkout", "-q", "-b", "side");
    commit("s1", "f.txt");
    g("checkout", "-q", "up");
    g("merge", "-q", "--no-ff", "-m", "um", "side");
    revs.um = g("rev-parse", "HEAD");
    commit("u3", "other.txt");
    g("update-ref", "refs/remotes/origin/main", "up");
    g("checkout", "-q", "main");
    g("branch", "-q", "-D", "up", "side");
    g("config", "remote.origin.url", "https://example.invalid/r.git");
    g("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    g("config", "branch.main.remote", "origin");
    g("config", "branch.main.merge", "refs/heads/main");
    repo = (await GitRepo.open(dir, opts)).repo;
    gitBefore = hashTree(path.join(dir, ".git"));
  });

  after(function () {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const top = async (ref = "HEAD", limit = 50) => {
    const { GitSource } = await import("../src/history/source");
    return new GitSource(repo, "f.txt", ref).top(limit);
  };

  it("lists upstream commits that changed the file, newest first", async function () {
    const page = await top();
    assert.deepStrictEqual(page.incoming?.commits.map((c) => c.subject), ["um", "u1"]);
    assert.strictEqual(page.incoming?.label, "your branch: main");
    assert.strictEqual(page.incoming?.description, "origin/main, not fetched yet");
    assert.match(page.incoming!.rowTooltip, /On origin\/main, not in main/);
    assert.deepStrictEqual(page.commits.map((c) => c.subject), ["c1"]);
    const small = await top("HEAD", 1);
    assert.deepStrictEqual(small.incoming?.commits.map((c) => c.subject), ["um"]);
    assert.strictEqual(small.incoming?.truncated, true);
  });

  it("expands an incoming merge to only what it brings in", async function () {
    const { GitSource } = await import("../src/history/source");
    const source = new GitSource(repo, "f.txt", "HEAD");
    const inc = (await source.top(50)).incoming!;
    const um = inc.commits[0];
    assert.ok(um.isMerge);
    assert.strictEqual(await source.count(um, inc.level), 1);
    assert.deepStrictEqual((await source.expand(um, inc.level, 50)).commits.map((c) => c.subject), ["s1"]);
  });

  it("says when the upstream was last fetched", async function () {
    const { writeFileSync } = await import("fs");
    const fetchHead = path.join(dir, ".git", "FETCH_HEAD");
    writeFileSync(fetchHead, ""); // test-only: simulate a fetch
    try {
      assert.strictEqual((await top()).incoming?.description, "origin/main, fetched just now");
    } finally {
      rmSync(fetchHead);
    }
  });

  it("has no incoming section without an upstream (a hash, a remote ref) or when up to date", async function () {
    assert.deepStrictEqual(await repo.upstream("HEAD"), { name: "origin/main", hash: revs.u3 });
    assert.deepStrictEqual(await repo.upstream("main"), { name: "origin/main", hash: revs.u3 });
    assert.strictEqual((await top(revs.c1)).incoming, undefined); // detached-style: a hash has no upstream
    assert.strictEqual((await top("origin/main")).incoming, undefined); // a remote ref has no upstream
    assert.strictEqual(await repo.upstream("origin/main"), undefined);
  });

  it("leaves .git unchanged", function () {
    assert.deepStrictEqual(hashTree(path.join(dir, ".git")), gitBefore);
  });
});
