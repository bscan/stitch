// History scope and filters: the pure parts (line mapping, scopes, filter matching,
// finding a workspace's repositories).
import * as assert from "assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { Commit } from "../src/backend";
import { mapRange, textLines } from "../src/history/patch";
import {
  endText,
  filterSummary,
  folderScope,
  isInside,
  matchesFilters,
  normalSpec,
  sameSpec,
  scopeContains,
  scopeName,
  scopesFor,
} from "../src/history/scope";
import { childRepositories, findRepositories } from "../src/repos";
import { Resolver } from "../src/resolver";

const lines = (n: number, edit: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

describe("mapRange (line ranges through a diff)", function () {
  it("keeps the range when nothing changed", function () {
    assert.deepStrictEqual(mapRange(lines(10), lines(10), { start: 3, end: 5 }), { range: { start: 3, end: 5 }, changed: false });
  });

  it("reports an edit inside the range, and the range is unchanged", function () {
    assert.deepStrictEqual(mapRange(lines(10, { 4: "edited" }), lines(10), { start: 3, end: 5 }), { range: { start: 3, end: 5 }, changed: true });
  });

  it("keeps an edited line in the range wherever it sits, so the range doesn't shrink", function () {
    for (const at of [3, 4, 5]) {
      assert.deepStrictEqual(mapRange(lines(10, { [at]: "edited" }), lines(10), { start: 3, end: 5 }), { range: { start: 3, end: 5 }, changed: true }, `line ${at}`);
    }
    assert.deepStrictEqual(mapRange(lines(10, { 4: "edited" }), lines(10), { start: 4, end: 4 }), { range: { start: 4, end: 4 }, changed: true });
    // Two lines replaced by three: the range covers both old lines.
    const newer = lines(10).replace("line 4\nline 5\n", "x\ny\nz\n");
    assert.deepStrictEqual(mapRange(newer, lines(10), { start: 5, end: 5 }), { range: { start: 4, end: 5 }, changed: true });
  });

  it("ignores edits outside the range and shifts it over lines added or removed above", function () {
    const older = lines(10);
    const newer = "new a\nnew b\n" + older.replace("line 9\n", "line nine\n");
    // Lines 5–7 now are lines 3–5 before.
    assert.deepStrictEqual(mapRange(newer, older, { start: 5, end: 7 }), { range: { start: 3, end: 5 }, changed: false });
    const fewer = older.replace("line 1\n", "");
    assert.deepStrictEqual(mapRange(fewer, older, { start: 2, end: 3 }), { range: { start: 3, end: 4 }, changed: false });
  });

  it("counts lines inserted or removed between range lines, not at its edges", function () {
    const older = lines(10);
    const inserted = older.replace("line 5\n", "line 5\ninserted\n");
    assert.deepStrictEqual(mapRange(inserted, older, { start: 4, end: 7 }), { range: { start: 4, end: 6 }, changed: true });
    assert.deepStrictEqual(mapRange(inserted, older, { start: 7, end: 8 }), { range: { start: 6, end: 7 }, changed: false });
    const removed = older.replace("line 5\n", "");
    // Lines 4–5 now are 4 and 6 before: line 5 was removed from between them.
    assert.deepStrictEqual(mapRange(removed, older, { start: 4, end: 5 }), { range: { start: 4, end: 6 }, changed: true });
    // Removed right above the range: not part of it.
    assert.deepStrictEqual(mapRange(removed, older, { start: 5, end: 6 }), { range: { start: 6, end: 7 }, changed: false });
  });

  it("has no older range when every line of it is new", function () {
    const older = lines(5);
    const newer = older.replace("line 3\n", "line 3\nnew 1\nnew 2\n");
    assert.deepStrictEqual(mapRange(newer, older, { start: 4, end: 5 }), { range: undefined, changed: true });
    assert.deepStrictEqual(mapRange(newer, "", { start: 1, end: 2 }), { range: undefined, changed: true });
  });

  it("ignores line endings and clamps the range to the file", function () {
    assert.deepStrictEqual(mapRange(lines(5).replace(/\n/g, "\r\n"), lines(5), { start: 2, end: 9 }), { range: { start: 2, end: 5 }, changed: false });
    assert.deepStrictEqual(mapRange(lines(3), lines(3), { start: 7, end: 9 }), { changed: false });
    assert.deepStrictEqual(textLines("a\r\nb"), ["a", "b"]);
  });
});

describe("history scopes", function () {
  const root = path.resolve("/wc");
  const file = path.join(root, "src", "history", "view.ts");

  it("lists the file, its folders up to the working copy, then the working copy", function () {
    const scopes = scopesFor(file, "git", root);
    assert.deepStrictEqual(scopes.map((s) => [s.kind, scopeName(s)]), [
      ["file", "view.ts"],
      ["folder", "src/history"],
      ["folder", "src"],
      ["workingCopy", "wc"],
    ]);
    assert.deepStrictEqual(scopesFor(path.join(root, "a.txt"), "svn", root).map((s) => s.kind), ["file", "workingCopy"]);
  });

  it("treats the working copy's root folder as the working-copy scope", function () {
    assert.strictEqual(folderScope("git", root, root).kind, "workingCopy");
    assert.strictEqual(folderScope("git", root, path.join(root, "src")).kind, "folder");
  });

  it("knows which files a scope covers", function () {
    const src = folderScope("git", root, path.join(root, "src"));
    assert.ok(scopeContains(src, file));
    assert.ok(!scopeContains(src, path.join(root, "srcx", "a.ts")));
    assert.ok(!scopeContains(src, path.join(root, "README.md")));
    assert.ok(scopeContains({ kind: "file", vcs: "git", root, path: file }, file));
    assert.ok(!isInside(path.resolve("/other/x"), root));
  });

  it("compares a spec with the normal view (follow setting, scope, filters)", function () {
    const normal = normalSpec(file, "git", root, "file");
    assert.ok(sameSpec({ scope: { kind: "file", vcs: "git", root, path: file }, filters: {} }, normal));
    assert.ok(!sameSpec({ scope: normal.scope, filters: { message: "fix" } }, normal));
    const wc = normalSpec(file, "svn", root, "workingCopy");
    assert.deepStrictEqual(wc.scope, { kind: "workingCopy", vcs: "svn", root, path: root });
    assert.ok(sameSpec({ scope: folderScope("svn", root, root), filters: {} }, wc));
  });

  it("matches author and message filters like the git side does (any case, part of the text)", function () {
    const c = { author: "Brian Smith", email: "brian@example.com", subject: "Fix the parser", body: "PROJ-12" } as Commit;
    assert.ok(matchesFilters(c, { author: { text: "brian" } }));
    assert.ok(matchesFilters(c, { author: { text: "EXAMPLE.COM" } }));
    assert.ok(!matchesFilters(c, { author: { text: "Brian" , exact: true } }));
    assert.ok(matchesFilters(c, { author: { text: "Brian Smith", exact: true } }));
    assert.ok(matchesFilters(c, { message: "proj-12" }));
    assert.ok(!matchesFilters(c, { message: "proj-13" }));
    assert.ok(!matchesFilters(c, { author: { text: "brian" }, message: "nope" }));
  });

  it("describes filters and the end of a filtered list", function () {
    const f = { author: { text: "<b@x>", exact: true, label: "Brian" }, message: "fix", lines: { editor: { start: 3, end: 5 }, uncommitted: false } };
    assert.strictEqual(filterSummary(f), "lines 3–5 · author Brian · message “fix”");
    assert.strictEqual(endText({ author: { text: "brian" } }, "git"), "No more commits by brian");
    assert.strictEqual(endText({ lines: { editor: { start: 1, end: 1 }, uncommitted: false } }, "svn"), "No older revisions changed these lines");
  });
});

describe("finding a workspace's repositories", function () {
  let dir: string;
  const git = (p: string) => {
    mkdirSync(path.join(p, ".git"), { recursive: true });
    writeFileSync(path.join(p, ".git", "HEAD"), "ref: refs/heads/main\n");
  };
  const svn = (p: string) => mkdirSync(path.join(p, ".svn"), { recursive: true });

  before(function () {
    dir = mkdtempSync(path.join(tmpdir(), "stitch-repos-"));
    // Two repositories side by side, one with a nested folder.
    git(path.join(dir, "one"));
    mkdirSync(path.join(dir, "one", "sub", "deep"), { recursive: true });
    svn(path.join(dir, "two"));
    // A folder holding several repositories, plus a plain folder and a hidden one.
    git(path.join(dir, "many", "a"));
    svn(path.join(dir, "many", "b"));
    mkdirSync(path.join(dir, "many", "plain"));
    git(path.join(dir, "many", ".hidden"));
    // A repository inside a nested folder of "many": not an immediate child, so not found.
    git(path.join(dir, "many", "plain", "nested"));
  });

  after(function () {
    rmSync(dir, { recursive: true, force: true });
  });

  const rel = (ms: { kind: string; dir: string }[]) => ms.map((m) => `${m.kind}:${path.relative(dir, m.dir)}`);

  it("two repositories as workspace folders", async function () {
    assert.deepStrictEqual(rel(await findRepositories([path.join(dir, "one"), path.join(dir, "two")], new Resolver())), ["git:one", "svn:two"]);
  });

  it("a workspace folder inside a repository finds that repository", async function () {
    assert.deepStrictEqual(rel(await findRepositories([path.join(dir, "one", "sub")], new Resolver())), ["git:one"]);
  });

  it("a workspace folder holding several repositories finds each (not recursively)", async function () {
    assert.deepStrictEqual(rel(await findRepositories([path.join(dir, "many")], new Resolver())), ["git:many/a", "svn:many/b"]);
    assert.deepStrictEqual(rel(await childRepositories(path.join(dir, "many"))), ["git:many/a", "svn:many/b"]);
  });

  it("lists a repository once when folders overlap", async function () {
    const found = await findRepositories([path.join(dir, "one"), path.join(dir, "one", "sub"), dir], new Resolver());
    assert.deepStrictEqual(rel(found), ["git:one", "svn:two"]);
  });
});
