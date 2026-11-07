// The Fetch button's `git fetch`: against a real local remote, it moves the
// remote-tracking branch and nothing else. Test-only setup runs git directly.
import * as assert from "assert";
import { execFileSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { gitFetch } from "../src/git/exec";
import { GitRepo } from "../src/git/gitBackend";

const opts = () => ({ gitPath: "git", timeoutMs: 30000 });

describe("git fetch (Fetch button)", function () {
  this.timeout(30000);
  let tmp: string;
  let work: string;
  let other: string;
  const run = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "T",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@example.com",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      encoding: "utf8",
    }).trim();

  before(function () {
    tmp = mkdtempSync(path.join(tmpdir(), "stitch-fetch-"));
    const origin = path.join(tmp, "origin.git");
    work = path.join(tmp, "work");
    other = path.join(tmp, "other");
    run(tmp, "init", "-q", "--bare", "-b", "main", origin);
    run(tmp, "clone", "-q", origin, work);
    run(work, "checkout", "-q", "-b", "main");
    writeFileSync(path.join(work, "f.txt"), "one\n");
    run(work, "add", "f.txt");
    run(work, "commit", "-q", "-m", "one");
    run(work, "push", "-q", "-u", "origin", "main");
    run(work, "push", "-q", "origin", "main:gone");
    run(work, "fetch", "-q");
    // Someone else pushes a change and deletes a branch.
    run(tmp, "clone", "-q", origin, other);
    writeFileSync(path.join(other, "f.txt"), "two\n");
    run(other, "commit", "-q", "-am", "two");
    run(other, "push", "-q", "origin", "main");
    run(other, "push", "-q", "origin", "--delete", "gone");
    // The local repo asks for pruning and has a hook that fetch would run.
    run(work, "config", "fetch.prune", "true");
    run(work, "config", "remote.origin.prune", "true");
    const hooks = path.join(work, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    const hook = path.join(hooks, "reference-transaction");
    writeFileSync(hook, `#!/bin/sh\ntouch "${path.join(tmp, "hook-ran")}"\n`);
    chmodSync(hook, 0o755);
  });

  after(function () {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("finds the upstream remote and the .git folder", async function () {
    const { repo } = await GitRepo.open(work, opts);
    assert.strictEqual(await repo.upstreamRemote("HEAD"), "origin");
    assert.strictEqual(await repo.upstreamRemote("origin/main"), undefined);
    assert.strictEqual(path.resolve(await repo.commonDir()), path.resolve(work, ".git"));
  });

  it("moves origin/main and nothing else: no pruning, no hooks, local state untouched", async function () {
    const before = {
      head: run(work, "rev-parse", "HEAD"),
      branch: run(work, "symbolic-ref", "HEAD"),
      heads: run(work, "for-each-ref", "refs/heads"),
      index: readFileSync(path.join(work, ".git", "index")).toString("hex"),
      file: readFileSync(path.join(work, "f.txt"), "utf8"),
    };
    await gitFetch(opts(), work, "origin");
    assert.strictEqual(run(work, "rev-parse", "origin/main"), run(other, "rev-parse", "HEAD"));
    assert.ok(run(work, "rev-parse", "--verify", "refs/remotes/origin/gone"), "origin/gone was pruned");
    assert.ok(!existsSync(path.join(tmp, "hook-ran")), "a hook ran");
    assert.deepStrictEqual(
      {
        head: run(work, "rev-parse", "HEAD"),
        branch: run(work, "symbolic-ref", "HEAD"),
        heads: run(work, "for-each-ref", "refs/heads"),
        index: readFileSync(path.join(work, ".git", "index")).toString("hex"),
        file: readFileSync(path.join(work, "f.txt"), "utf8"),
      },
      before
    );
  });

  it("refuses a remote name that is an option", async function () {
    await assert.rejects(gitFetch(opts(), work, "--upload-pack=touch x"), /not a remote/);
  });
});
