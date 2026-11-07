import * as assert from "assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { previousDiff } from "../src/backend";
import { buildArgv } from "../src/git/exec";
import { parseLog, toCommits } from "../src/git/parse";
import { relativeTime, shortRefs } from "../src/history/format";
import { Resolver } from "../src/resolver";

const rec = (fields: string[], changes: string[]) => "\x1e" + fields.join("\0") + "\0\0\n" + changes.join("\0") + "\0";

describe("parseLog / toCommits", function () {
  it("parses headers, multi-line bodies, renames and merges without changes", function () {
    const out =
      rec(["h3", "p1 p2", "Ann", "ann@x", "1700000200", "HEAD -> main, tag: v2", "Merge stuff", "line a\nline b\n"], []) +
      rec(["h2", "h1", "Bob", "bob@x", "1700000100", "", "Rename", ""], ["R092", "old/a.txt", "new/a.txt"]) +
      rec(["h1", "", "Cy", "cy@x", "1700000000", "", "Add", ""], ["A", "old/a.txt"]);
    const raws = parseLog(out);
    assert.strictEqual(raws.length, 3);
    assert.deepStrictEqual(raws[0].parents, ["p1", "p2"]);
    assert.deepStrictEqual(raws[0].refs, ["HEAD -> main", "tag: v2"]);
    assert.strictEqual(raws[0].body, "line a\nline b");
    assert.deepStrictEqual(raws[1].changes, [{ status: "R092", oldPath: "old/a.txt", path: "new/a.txt" }]);

    const cs = toCommits(raws, "new/a.txt");
    assert.strictEqual(cs[0].isMerge, true);
    assert.strictEqual(cs[0].path, "new/a.txt"); // merge without name-status keeps the tracked path
    assert.strictEqual(cs[0].oldPath, "new/a.txt");
    assert.strictEqual(cs[1].oldPath, "old/a.txt");
    assert.strictEqual(cs[2].path, "old/a.txt");
    assert.strictEqual(cs[2].oldPath, undefined);
    assert.strictEqual(previousDiff(cs[2]).left.kind, "empty");
    assert.strictEqual(cs[2].date.getTime(), 1700000000 * 1000);
  });

  it("detects pull merges by subject", function () {
    const mk = (subject: string) =>
      toCommits(parseLog(rec(["h", "a b", "x", "x@x", "0", "", subject, ""], [])), "f")[0].isPullMerge;
    assert.strictEqual(mk("Merge branch 'main' of https://host/repo"), true);
    assert.strictEqual(mk("Merge remote-tracking branch 'origin/main'"), true);
    assert.strictEqual(mk("Merge branch 'feature'"), false);
    assert.strictEqual(mk("Merge pull request #42 from x/y"), false);
  });

  it("a deletion has an empty right side", function () {
    const cs = toCommits(parseLog(rec(["h2", "h1", "x", "x@x", "0", "", "rm", ""], ["D", "a.txt"])), "a.txt");
    const { left, right } = previousDiff(cs[0]);
    assert.strictEqual(left.kind, "rev");
    assert.strictEqual(right.kind, "empty");
  });
});

describe("buildArgv", function () {
  it("puts safety config before the subcommand and safety flags before --", function () {
    const argv = buildArgv(["log", "-n5", "--", "a.txt"]);
    const sub = argv.indexOf("log");
    assert.ok(argv.slice(0, sub).includes("core.fsmonitor=false"));
    assert.ok(argv.slice(0, sub).includes("log.showSignature=false"));
    assert.deepStrictEqual(argv.slice(sub), ["log", "--no-textconv", "--no-ext-diff", "-n5", "--", "a.txt"]);
    assert.ok(!buildArgv(["rev-list", "--count", "HEAD"]).includes("--no-textconv"));
  });
});

describe("Resolver", function () {
  let root: string;
  before(function () {
    root = mkdtempSync(path.join(tmpdir(), "stitch-resolve-"));
    // root/.svn                      svn working copy
    // root/sub/gitrepo/.git          git repo nested in svn
    // root/sub/gitrepo/wt/.git       worktree-style .git *file*
    mkdirSync(path.join(root, ".svn"));
    mkdirSync(path.join(root, "sub", "gitrepo", ".git"), { recursive: true });
    mkdirSync(path.join(root, "sub", "gitrepo", "wt"), { recursive: true });
    writeFileSync(path.join(root, "sub", "gitrepo", "wt", ".git"), "gitdir: ../.git/worktrees/wt\n");
  });
  after(function () {
    rmSync(root, { recursive: true, force: true });
  });

  it("picks the nearest marker", async function () {
    const r = new Resolver();
    assert.deepStrictEqual(await r.forFile(path.join(root, "a.txt")), { kind: "svn", dir: root });
    assert.deepStrictEqual(await r.forFile(path.join(root, "sub", "b.txt")), { kind: "svn", dir: root });
    assert.deepStrictEqual(await r.forFile(path.join(root, "sub", "gitrepo", "c.txt")), {
      kind: "git",
      dir: path.join(root, "sub", "gitrepo"),
    });
    assert.deepStrictEqual(await r.forFile(path.join(root, "sub", "gitrepo", "wt", "d.txt")), {
      kind: "git",
      dir: path.join(root, "sub", "gitrepo", "wt"),
    });
  });
});

describe("format", function () {
  it("relative times and refs", function () {
    const now = new Date("2024-06-01T00:00:00Z");
    assert.strictEqual(relativeTime(new Date("2024-06-01T00:00:00Z"), now), "just now");
    assert.strictEqual(relativeTime(new Date("2024-05-31T23:55:00Z"), now), "5 min ago");
    assert.strictEqual(relativeTime(new Date("2024-05-29T00:00:00Z"), now), "3 d ago");
    assert.strictEqual(relativeTime(new Date("2022-05-01T00:00:00Z"), now), "2 y ago");
    assert.deepStrictEqual(shortRefs(["HEAD -> main", "origin/main", "tag: v1"]), ["main", "origin/main", "tag: v1"]);
  });
});

import { authorColor, authorInitial, avatarDataUri, avatarSvg, PALETTE } from "../src/history/avatar";

describe("author bubbles", function () {
  it("uses the first letter or digit, upper-cased", function () {
    assert.strictEqual(authorInitial("alice"), "A");
    assert.strictEqual(authorInitial("Bob Smith"), "B");
    assert.strictEqual(authorInitial("  (jörg)"), "J");
    assert.strictEqual(authorInitial("ölaf"), "Ö");
    assert.strictEqual(authorInitial("7of9"), "7");
    assert.strictEqual(authorInitial("---"), "?");
  });

  it("gives an author the same color every time, ignoring case and spaces", function () {
    assert.strictEqual(authorColor("alice"), authorColor(" Alice "));
    assert.ok(PALETTE.includes(authorColor("bob")));
    const colors = new Set(["alice", "bob", "carol", "dave", "erin", "frank", "grace", "heidi"].map(authorColor));
    assert.ok(colors.size >= 5, `expected varied colors, got ${colors.size}`);
  });

  it("produces a valid, escaped SVG data URI", function () {
    assert.match(avatarSvg("<x>"), />X</);
    assert.match(avatarSvg("&"), />\?</);
    assert.match(avatarSvg("(no author)"), />\?</);
    const uri = avatarDataUri("alice");
    assert.ok(uri.startsWith("data:image/svg+xml;base64,"));
    assert.match(Buffer.from(uri.split(",")[1], "base64").toString(), /<circle[^>]*fill="#[0-9a-f]{6}"/);
  });
});
