import * as assert from "assert";
import { createHash } from "crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { Commit, previousDiff } from "../src/backend";
import { git, GitError } from "../src/git/exec";
import { GitRepo } from "../src/git/gitBackend";
import { TopPage } from "../src/history/source";
import { setLogSink } from "../src/log";
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

describe("git unpushed commits (in the branch, not in its upstream)", function () {
  let dir: string;
  let repo: GitRepo;
  let gitBefore: Map<string, string>;

  // Test-only setup with git directly: main ahead of origin/main, which it has merged.
  //   origin/main: c1 ─ c2 ─ r1
  //   main:        c1 ─ c2 ─ l1 ─ pm (pull merge of origin/main) ─ lm (merge of local s1) ─ l2
  before(async function () {
    const { execFileSync } = await import("child_process");
    const { writeFileSync, appendFileSync } = await import("fs");
    dir = mkdtempSync(path.join(tmpdir(), "stitch-ahead-"));
    const g = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@x", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@x" },
      }).trim();
    const commit = (name: string) => {
      appendFileSync(path.join(dir, "f.txt"), `${name}\n`);
      g("add", "f.txt");
      g("commit", "-q", "-m", name);
    };
    g("init", "-q", "-b", "main");
    commit("c1");
    commit("c2");
    g("checkout", "-q", "-b", "up");
    commit("r1");
    g("update-ref", "refs/remotes/origin/main", "up");
    g("checkout", "-q", "main");
    g("branch", "-q", "-D", "up");
    commit("l1");
    assert.throws(() => g("merge", "-q", "origin/main")); // both sides appended a line
    writeFileSync(path.join(dir, "f.txt"), "c1\nc2\nr1\nl1\n");
    g("add", "f.txt");
    g("commit", "-q", "-m", "Merge remote-tracking branch 'origin/main'");
    g("checkout", "-q", "-b", "side");
    commit("s1");
    g("checkout", "-q", "main");
    g("merge", "-q", "--no-ff", "-m", "lm", "side");
    g("branch", "-q", "-D", "side");
    commit("l2");
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

  const newSource = async (ref = "HEAD") => new (await import("../src/history/source")).GitSource(repo, "f.txt", ref);
  const marks = (commits: { subject: string; unpushed?: string }[]) => commits.map((c) => `${c.subject.slice(0, 5)}${c.unpushed ? "*" : ""}`);

  it("marks the branch's commits that the upstream doesn't have", async function () {
    const page = await (await newSource()).top(50);
    assert.deepStrictEqual(marks(page.commits), ["l2*", "lm*", "Merge*", "l1*", "c2", "c1"]);
    assert.match(page.commits[0].unpushed!, /Not on origin\/main yet/);
    assert.strictEqual(page.pushedLine?.label, "upstream: origin/main");
    assert.strictEqual(page.pushedLine?.description, "not fetched yet");
    assert.strictEqual(page.incoming, undefined); // r1 is merged already
  });

  it("marks them on later pages and under merges too", async function () {
    const source = await newSource();
    const first = await source.top(2);
    assert.deepStrictEqual(marks(first.commits), ["l2*", "lm*"]);
    const second = await source.more(first.next, 2);
    assert.deepStrictEqual(marks(second.commits), ["Merge*", "l1*"]);
    assert.deepStrictEqual(marks((await source.more(second.next!, 2)).commits), ["c2", "c1"]);
    // A local branch's commits aren't pushed; what a pull merge brought in came from the upstream.
    assert.deepStrictEqual(marks((await source.expand(first.commits[1], first.level, 50)).commits), ["s1*"]);
    assert.deepStrictEqual(marks((await source.expand(second.commits[0], first.level, 50)).commits), ["r1"]);
  });

  it("keeps the marks when the history is reused", async function () {
    const source = await newSource();
    await source.top(2);
    const again = await source.top(2);
    assert.deepStrictEqual(marks(again.commits), ["l2*", "lm*"]);
    assert.strictEqual(again.pushedLine?.label, "upstream: origin/main");
    assert.deepStrictEqual(marks((await source.more(again.next, 2)).commits), ["Merge*", "l1*"]);
  });

  it("marks nothing without an upstream (a remote ref)", async function () {
    const page = await (await newSource("origin/main")).top(50);
    assert.deepStrictEqual(marks(page.commits), ["r1", "c2", "c1"]);
    assert.strictEqual(page.pushedLine, undefined);
  });

  it("leaves .git unchanged", function () {
    assert.deepStrictEqual(hashTree(path.join(dir, ".git")), gitBefore);
  });
});

describe("git history cache (GitSource remembers top() while the ref and upstream stay put)", function () {
  let dir: string;
  let repo: GitRepo;
  const revs: Record<string, string> = {};
  let g: (...args: string[]) => string;

  //   main:        c1 ─ c2
  //   origin/main: c1 ─ c2 ─ um (merge of s1, which changed f)
  before(async function () {
    const { execFileSync } = await import("child_process");
    const { writeFileSync, appendFileSync } = await import("fs");
    dir = mkdtempSync(path.join(tmpdir(), "stitch-cache-"));
    g = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@x", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@x" },
      }).trim();
    const commit = (name: string, ...files: string[]) => {
      for (const f of files) appendFileSync(path.join(dir, f), `${name}\n`);
      g("add", ...files);
      g("commit", "-q", "-m", name);
      revs[name] = g("rev-parse", "HEAD");
    };
    g("init", "-q", "-b", "main");
    writeFileSync(path.join(dir, "other.txt"), "o\n");
    commit("c1", "f.txt", "other.txt");
    commit("c2", "f.txt", "other.txt");
    g("checkout", "-q", "-b", "up");
    g("checkout", "-q", "-b", "side");
    commit("s1", "f.txt");
    g("checkout", "-q", "up");
    g("merge", "-q", "--no-ff", "-m", "um", "side");
    revs.um = g("rev-parse", "HEAD");
    g("update-ref", "refs/remotes/origin/main", "up");
    g("checkout", "-q", "main");
    g("branch", "-q", "-D", "up", "side");
    g("config", "remote.origin.url", "https://example.invalid/r.git");
    g("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    g("config", "branch.main.remote", "origin");
    g("config", "branch.main.merge", "refs/heads/main");
    repo = (await GitRepo.open(dir, opts)).repo;
  });

  after(function () {
    setLogSink(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** The git subcommands run while `fn` runs (every git() call logs one line, also when cancelled). */
  async function gitDuring(fn: () => Promise<unknown>): Promise<string[]> {
    const ran: string[] = [];
    setLogSink((_level, m) => {
      const sub = /^git (\S+)/.exec(m);
      if (sub) ran.push(sub[1]);
    });
    try {
      await fn();
    } finally {
      setLogSink(() => undefined);
    }
    return ran;
  }
  const heavy = (ran: string[]) => ran.filter((s) => s !== "rev-parse");
  const newSource = async () => new (await import("../src/history/source")).GitSource(repo, "f.txt", "HEAD");

  it("serves the second top() at an unchanged state without git log, with files and merge counts kept", async function () {
    const source = await newSource();
    let first!: TopPage;
    assert.ok(heavy(await gitDuring(async () => (first = await source.top(50)))).includes("log"));
    await source.files([...first.commits, ...first.incoming!.commits]); // what the view's settle() does
    const um = first.incoming!.commits[0];
    assert.strictEqual(um.subject, "um");
    assert.strictEqual(await source.count(um, first.incoming!.level), 1);

    let again!: TopPage;
    const ran = await gitDuring(async () => {
      again = await source.top(50);
      assert.strictEqual(await source.count(again.incoming!.commits[0], again.incoming!.level), 1);
    });
    assert.deepStrictEqual(heavy(ran), [], `only rev-parse, ran: ${ran.join(", ")}`);
    assert.deepStrictEqual(again.commits.map((c) => c.subject), ["c2", "c1"]);
    assert.ok(again.commits.every((c) => c.files !== undefined), "changed files are still filled in");
    assert.deepStrictEqual(again.incoming?.commits.map((c) => c.subject), ["um"]);
    assert.strictEqual(await source.moved(), false);
  });

  it("still reuses everything after the view that loaded it was left (its signal aborted)", async function () {
    // Like the view: every visit has its own signal, aborted when another file is shown.
    const source = await newSource();
    const visit1 = new AbortController();
    const first = await source.top(50, visit1.signal);
    await source.files([...first.commits, ...first.incoming!.commits], visit1.signal);
    assert.strictEqual(await source.count(first.incoming!.commits[0], first.incoming!.level, visit1.signal), 1);
    visit1.abort(); // switched to another file

    const visit2 = new AbortController();
    const ran = await gitDuring(async () => {
      const page = await source.top(50, visit2.signal);
      const missing = [...page.commits, ...page.incoming!.commits].filter((c) => !c.files);
      assert.deepStrictEqual(missing, [], "changed files are still filled in");
      assert.strictEqual(await source.count(page.incoming!.commits[0], page.incoming!.level, visit2.signal), 1);
    });
    assert.deepStrictEqual(heavy(ran), [], `only rev-parse, ran: ${ran.join(", ")}`);
  });

  it("doesn't reuse a merge count that was cancelled before it finished", async function () {
    const source = await newSource();
    const first = await source.top(50);
    const um = first.incoming!.commits[0];
    const left = new AbortController();
    const pending = source.count(um, first.incoming!.level, left.signal);
    left.abort();
    await assert.rejects(pending);
    let n!: number;
    const ran = await gitDuring(async () => (n = await source.count(um, first.incoming!.level, new AbortController().signal)));
    assert.strictEqual(n, 1);
    assert.ok(ran.includes("rev-list"), ran.join(", "));
  });

  it("computes the separator's fetch time when the page is served, not when it was loaded", async function () {
    const { writeFileSync } = await import("fs");
    const source = await newSource();
    assert.strictEqual((await source.top(50)).incoming?.description, "origin/main, not fetched yet");
    const fetchHead = path.join(dir, ".git", "FETCH_HEAD");
    writeFileSync(fetchHead, ""); // test-only: simulate a fetch that moved nothing
    try {
      let page!: TopPage;
      assert.deepStrictEqual(heavy(await gitDuring(async () => (page = await source.top(50)))), []);
      assert.strictEqual(page.incoming?.description, "origin/main, fetched just now");
      assert.match(page.incoming!.tooltip, /as of the last fetch \(\d/);
    } finally {
      rmSync(fetchHead);
    }
  });

  it("loads afresh when the ref or its upstream moved", async function () {
    const source = await newSource();
    await source.top(50);
    g("update-ref", "refs/remotes/origin/main", revs.c2); // test-only: as if a fetch moved origin/main
    try {
      assert.strictEqual(await source.moved(), true);
      let page!: TopPage;
      assert.ok(heavy(await gitDuring(async () => (page = await source.top(50)))).includes("log"));
      assert.strictEqual(page.incoming, undefined); // up to date now
      assert.strictEqual(await source.moved(), false);
    } finally {
      g("update-ref", "refs/remotes/origin/main", revs.um);
    }
    // Moved back: top() notices by itself too (no moved() call needed).
    let page!: TopPage;
    assert.ok(heavy(await gitDuring(async () => (page = await source.top(50)))).includes("log"));
    assert.deepStrictEqual(page.incoming?.commits.map((c) => c.subject), ["um"]);
  });

  it("queries again after invalidate() (Refresh, settings, the Fetch button)", async function () {
    const source = await newSource();
    const first = await source.top(50);
    await source.count(first.incoming!.commits[0], first.incoming!.level);
    source.invalidate();
    const ran = await gitDuring(async () => {
      const page = await source.top(50);
      await source.count(page.incoming!.commits[0], page.incoming!.level);
    });
    assert.ok(ran.includes("log"), ran.join(", "));
    assert.ok(ran.includes("rev-list"), ran.join(", "));
  });

  it("doesn't remember a cancelled load", async function () {
    const source = await newSource();
    const ac = new AbortController();
    const p = source.top(50, ac.signal);
    ac.abort();
    await assert.rejects(p);
    assert.ok(heavy(await gitDuring(() => source.top(50))).includes("log"));
    // An already-cancelled call doesn't leave a result behind either.
    const fresh = await newSource();
    const done = new AbortController();
    done.abort();
    await assert.rejects(fresh.top(50, done.signal));
    assert.ok(heavy(await gitDuring(() => fresh.top(50))).includes("log"));
  });

  it("a different starting ref is a different history", async function () {
    const { GitSource } = await import("../src/history/source");
    const head = await new GitSource(repo, "f.txt", "HEAD").top(50);
    const up = await new GitSource(repo, "f.txt", "origin/main").top(50);
    assert.deepStrictEqual(head.commits.map((c) => c.subject), ["c2", "c1"]);
    assert.deepStrictEqual(up.commits.map((c) => c.subject), ["um", "c2", "c1"]);
  });
});
