// Builds a git repository whose history exercises every case the trunk view
// must handle. Test-only: runs git directly (not through src/git/exec.ts).
//
// File history (the file is f.txt, renamed to g.txt on trunk, then to h.txt on a branch):
//
//   c0  root: add f.txt, other.txt
//   c1  trunk edits f
//   A:  a1 (f) ── D: d1 (f) ── N "merge D into A" ── a2 (f)     (nested branch-of-branch)
//   c2  trunk edits other.txt only
//   M1  merge A
//   B:  b1 (other.txt only), branched from c1
//   c3  trunk edits f
//   MB  merge B  — must NOT appear (B never touched f; MB still differs from its 2nd parent)
//   C:  cc1 (f) ── S "sync main into C" ── cc2 (f)              (sync merge inside a branch)
//   c4  trunk edits f (before S)
//   M2  merge C
//   c5  trunk renames f.txt → g.txt
//   c6  trunk edits g
//   E:  e1 renames g.txt → h.txt ── e2 (h)                      (rename on a branch)
//   c7  trunk edits other.txt only
//   M3  merge E
//   remote: r1 (h)
//   p1  trunk edits h
//   PM  "Merge branch 'main' of https://example.com/stitch"      (pull merge)
import { execFileSync } from "child_process";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import * as path from "path";

export type Fixture = { dir: string; rev: Record<string, string> };

export function buildFixture(dir: string): Fixture {
  mkdirSync(dir, { recursive: true });
  let tick = 0;
  const run = (...args: string[]) => {
    tick++;
    const date = new Date(Date.UTC(2024, 0, 1, 0, 0, tick)).toISOString();
    return execFileSync("git", args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Tester",
        GIT_AUTHOR_EMAIL: "tester@example.com",
        GIT_COMMITTER_NAME: "Tester",
        GIT_COMMITTER_EMAIL: "tester@example.com",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      encoding: "utf8",
    }).trim();
  };
  const rev: Record<string, string> = {};
  const head = (name: string) => (rev[name] = run("rev-parse", "HEAD"));
  const setLine = (file: string, line: number, text: string) => {
    const p = path.join(dir, file);
    const lines = readFileSync(p, "utf8").split("\n");
    // Edits sit on even lines only: git treats changes to adjacent lines in two branches as a conflict.
    lines[line * 2 - 1] = text;
    writeFileSync(p, lines.join("\n"));
    run("add", file);
  };
  const commit = (name: string) => {
    run("commit", "-q", "-m", name);
    head(name);
  };
  const merge = (branch: string, name: string, message = name) => {
    run("merge", "-q", "--no-ff", branch, "-m", message);
    head(name);
  };
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

  run("init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "f.txt"), lines);
  writeFileSync(path.join(dir, "other.txt"), lines);
  run("add", ".");
  commit("c0");
  setLine("f.txt", 1, "c1");
  commit("c1");

  run("checkout", "-q", "-b", "A");
  setLine("f.txt", 2, "a1");
  commit("a1");
  run("checkout", "-q", "-b", "D");
  setLine("f.txt", 3, "d1");
  commit("d1");
  run("checkout", "-q", "A");
  merge("D", "N", "N merge D into A");
  setLine("f.txt", 4, "a2");
  commit("a2");

  run("checkout", "-q", "main");
  setLine("other.txt", 1, "c2");
  commit("c2");
  merge("A", "M1");

  run("checkout", "-q", "-b", "B", rev.c1);
  setLine("other.txt", 2, "b1");
  commit("b1");
  run("checkout", "-q", "main");
  setLine("f.txt", 5, "c3");
  commit("c3");
  merge("B", "MB");

  run("checkout", "-q", "-b", "C");
  setLine("f.txt", 6, "cc1");
  commit("cc1");
  run("checkout", "-q", "main");
  setLine("f.txt", 7, "c4");
  commit("c4");
  run("checkout", "-q", "C");
  merge("main", "S", "S sync main into C");
  setLine("f.txt", 8, "cc2");
  commit("cc2");
  run("checkout", "-q", "main");
  merge("C", "M2");

  run("mv", "f.txt", "g.txt");
  commit("c5");
  setLine("g.txt", 9, "c6");
  commit("c6");

  run("checkout", "-q", "-b", "E");
  run("mv", "g.txt", "h.txt");
  commit("e1");
  setLine("h.txt", 10, "e2");
  commit("e2");
  run("checkout", "-q", "main");
  setLine("other.txt", 3, "c7");
  commit("c7");
  merge("E", "M3");

  run("checkout", "-q", "-b", "remote");
  setLine("h.txt", 11, "r1");
  commit("r1");
  run("checkout", "-q", "main");
  setLine("h.txt", 12, "p1");
  commit("p1");
  merge("remote", "PM", "Merge branch 'main' of https://example.com/stitch");
  run("tag", "v1.0", rev.c1);

  // Name lookup by hash, for readable assertions.
  return { dir, rev };
}
