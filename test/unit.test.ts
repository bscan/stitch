import * as assert from "assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { Commit, previousDiff } from "../src/backend";
import { decodeText, formatDiff, unifiedHunks } from "../src/history/patch";
import { buildArgv } from "../src/git/exec";
import { parseLog, toCommits } from "../src/git/parse";
import { fetchNote, relativeTime, shortRefs, staleFetchMs } from "../src/history/format";
import { fetchBlockedReason, FetchPolicy, mountFor } from "../src/git/fetchPolicy";
import { Resolver } from "../src/resolver";
import { changedFiles, MAX_FILES, svnDisplayPath, toCommit } from "../src/svn/svnHistory";
import { LogItem } from "../src/svn/dav";

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
    // root/.git                      empty shell (no HEAD), e.g. left by a sandbox: ignored
    // root/sub/shell/.git            empty shell with stray subfolders: ignored
    // root/sub/notgit/.git           file that isn't "gitdir:": ignored
    mkdirSync(path.join(root, ".svn"));
    mkdirSync(path.join(root, ".git", "info"), { recursive: true });
    writeFileSync(path.join(root, ".git", "info", ".claude-sandbox-noreplace"), "");
    mkdirSync(path.join(root, "sub", "shell", ".git", "branches"), { recursive: true });
    mkdirSync(path.join(root, "sub", "notgit"), { recursive: true });
    writeFileSync(path.join(root, "sub", "notgit", ".git"), "");
    mkdirSync(path.join(root, "sub", "gitrepo", ".git"), { recursive: true });
    writeFileSync(path.join(root, "sub", "gitrepo", ".git", "HEAD"), "ref: refs/heads/main\n");
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

  it("ignores .git shells that aren't real repos", async function () {
    const r = new Resolver();
    assert.deepStrictEqual(await r.forFile(path.join(root, "e.txt")), { kind: "svn", dir: root });
    assert.deepStrictEqual(await r.forFile(path.join(root, "sub", "shell", "f.txt")), { kind: "svn", dir: root });
    assert.deepStrictEqual(await r.forFile(path.join(root, "sub", "notgit", "g.txt")), { kind: "svn", dir: root });
  });
});

describe("svn changed files", function () {
  const item = (paths: LogItem["paths"]): LogItem => ({ rev: 7, paths, hasChildren: false, subtractive: false, children: [] });

  it("lists a move once, as R, and leaves folders out", function () {
    const { files, total } = changedFiles(
      item([
        { action: "A", path: "/trunk/b.txt", kind: "file", copyFromPath: "/trunk/a.txt", copyFromRev: 6 },
        { action: "D", path: "/trunk/a.txt", kind: "file" },
        { action: "A", path: "/trunk/c.txt", kind: "file", copyFromPath: "/trunk/x.txt", copyFromRev: 6 },
        { action: "M", path: "/trunk", kind: "dir", propMods: true },
      ])
    );
    assert.strictEqual(total, 2);
    assert.deepStrictEqual(files, [
      { path: "trunk/b.txt", status: "R", oldPath: "trunk/a.txt", fromRev: "6" },
      { path: "trunk/c.txt", status: "C", oldPath: "trunk/x.txt", fromRev: "6" },
    ]);
  });

  it(`keeps at most ${MAX_FILES} files per revision, always including the history's own file`, function () {
    const paths = Array.from({ length: 5000 }, (_, i) => ({ action: "M" as const, path: `/trunk/f${String(i).padStart(5, "0")}.txt`, kind: "file" }));
    const big = item(paths);
    const own = "/trunk/f04321.txt";
    const { commit } = toCommit(big, own);
    assert.strictEqual(commit.files!.length, MAX_FILES);
    assert.strictEqual(commit.filesTotal, 5000);
    assert.ok(commit.files!.some((f) => f.path === "trunk/f04321.txt"));
    assert.strictEqual(commit.files![0].path, "trunk/f00000.txt");
    // Small revisions are untouched.
    const small = toCommit(item(paths.slice(0, 3)), "/trunk/f00001.txt").commit;
    assert.strictEqual(small.files!.length, 3);
    assert.strictEqual(small.filesTotal, undefined);
  });
});

describe("svnDisplayPath", function () {
  // Working copy at /wc, checked out from ^/trunk/scripts/debug.
  const root = path.join(path.sep, "wc");
  const file = path.join(root, "sub", "job.pl");
  const reposPath = "trunk/scripts/debug/sub/job.pl";
  it("maps paths inside the checkout into the working copy", function () {
    assert.strictEqual(svnDisplayPath(root, file, reposPath, reposPath), file);
    assert.strictEqual(svnDisplayPath(root, file, reposPath, "/trunk/scripts/debug/old.pl"), path.join(root, "old.pl"));
  });
  it("shows other paths as repository paths", function () {
    assert.strictEqual(svnDisplayPath(root, file, reposPath, "branches/x/scripts/debug/sub/job.pl"), "/branches/x/scripts/debug/sub/job.pl");
    assert.strictEqual(svnDisplayPath(root, file, reposPath, "trunk/scripts/debugger/a.pl"), "/trunk/scripts/debugger/a.pl");
  });
  it("works when the checkout is the repository root", function () {
    assert.strictEqual(svnDisplayPath(root, file, "sub/job.pl", "other/a.pl"), path.join(root, "other", "a.pl"));
  });
});

describe("fetch policy", function () {
  const linux: FetchPolicy = {
    excludePaths: ["/drives/", "/mnt/", "/smb"],
    localDrives: ["C:", "D:"],
    platform: "linux",
    mounts: [
      "/dev/nvme0n1p3 / btrfs rw 0 0",
      "//nas/share /srv/share cifs rw 0 0",
      "nas:/export /home/me/nfs\\040dir nfs4 rw 0 0",
      "/dev/sdb1 /srv/share/local ext4 rw 0 0",
    ].join("\n"),
  };
  const win: FetchPolicy = { ...linux, platform: "win32", mounts: undefined };
  const ok = (p: string, pol: FetchPolicy) => assert.strictEqual(fetchBlockedReason([p], pol), undefined, p);
  const no = (p: string, pol: FetchPolicy) => assert.ok(fetchBlockedReason([p], pol), p);

  it("Linux: excluded prefixes match whole segments", function () {
    no("/drives/h/repo", linux);
    no("/mnt/x", linux);
    no("/smb", linux);
    no("/smb/x/repo", linux);
    ok("/smbx/repo", linux);
    ok("/home/me/repo", linux);
  });

  it("Linux: network mounts from /proc/mounts, innermost mount wins", function () {
    no("/srv/share/repo", linux);
    no("/home/me/nfs dir/repo", linux);
    ok("/srv/share/local/repo", linux);
    ok("/home/me/nfsdir", linux);
    assert.deepStrictEqual(mountFor("/srv/share/local/r", linux.mounts!), { point: "/srv/share/local", type: "ext4" });
  });

  it("Windows: UNC paths and non-local drives", function () {
    ok("C:\\src\\repo", win);
    ok("d:\\repo", win);
    no("E:\\repo", win);
    no("\\\\server\\share\\repo", win);
    no("//server/share/repo", win);
    ok("E:\\repo", { ...win, localDrives: ["c", "E:\\"] });
    no("C:\\mnt\\repo", { ...win, excludePaths: ["c:/mnt"] });
  });

  it("checks every folder given (a worktree's .git can live elsewhere)", function () {
    assert.ok(fetchBlockedReason(["/home/me/wt", "/drives/h/repo/.git"], linux));
  });
});

describe("fetch note", function () {
  const now = new Date("2024-06-01T12:00:00Z");
  const ago = (min: number) => new Date(now.getTime() - min * 60_000);
  it("is hidden while fetches are recent, shown once they're stale or missing", function () {
    const hour = staleFetchMs(false, 180);
    assert.strictEqual(fetchNote(ago(5), hour, now), undefined);
    assert.strictEqual(fetchNote(ago(59), hour, now), undefined);
    assert.strictEqual(fetchNote(ago(3 * 24 * 60), hour, now), "fetched 3 d ago");
    assert.strictEqual(fetchNote(undefined, hour, now), "never fetched");
  });
  it("waits for two autofetch periods when autofetch is on with a long period", function () {
    assert.strictEqual(staleFetchMs(true, 180), 60 * 60_000); // default 3 min period: the hour wins
    assert.strictEqual(staleFetchMs("all", 3600), 2 * 60 * 60_000);
    assert.strictEqual(staleFetchMs(false, 3600), 60 * 60_000); // period ignored when autofetch is off
    assert.strictEqual(staleFetchMs(true, undefined), 60 * 60_000);
    assert.strictEqual(fetchNote(ago(90), staleFetchMs(true, 3600), now), undefined);
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

describe("Copy Diff (patch.ts)", function () {
  const commit = (over: Partial<Commit> = {}): Commit => ({
    rev: "abcdef1234567890",
    shortRev: "abcdef1",
    parents: ["1111111aaaa"],
    author: "Ann",
    email: "ann@x",
    date: new Date(Date.UTC(2026, 10, 8, 9, 5, 7)),
    subject: "Fix the thing",
    body: "Longer story.\n\nSecond paragraph.",
    refs: [],
    isMerge: false,
    isPullMerge: false,
    path: "src/a.txt",
    oldPath: "src/a.txt",
    ...over,
  });

  it("produces hunks with context, merging nearby changes", function () {
    const a = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
    const b = a.replace("l2\n", "L2\n").replace("l5\n", "").replace("l18\n", "l18\nnew\n");
    assert.strictEqual(
      unifiedHunks(a, b),
      [
        "@@ -1,8 +1,7 @@",
        " l1",
        "-l2",
        "+L2",
        " l3",
        " l4",
        "-l5",
        " l6",
        " l7",
        " l8",
        "@@ -16,5 +15,6 @@",
        " l16",
        " l17",
        " l18",
        "+new",
        " l19",
        " l20",
        "",
      ].join("\n")
    );
    assert.strictEqual(unifiedHunks(a, a), "");
  });

  it("handles added/deleted files and missing final newlines", function () {
    assert.strictEqual(unifiedHunks("", "x\ny\n"), "@@ -0,0 +1,2 @@\n+x\n+y\n");
    assert.strictEqual(unifiedHunks("x\n", ""), "@@ -1 +0,0 @@\n-x\n");
    assert.strictEqual(
      unifiedHunks("a\nb", "a\nb\n"),
      "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n"
    );
    assert.strictEqual(unifiedHunks("a\nb", "a\nc"), "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n");
  });

  it("finds a minimal diff in the middle of a file", function () {
    const a = "a\nb\nc\nd\ne\nf\ng\n";
    const b = "a\nx\nb\nc\ne\nf\ny\ng\n";
    const out = unifiedHunks(a, b, 0);
    assert.strictEqual(out, "@@ -1,0 +2 @@\n+x\n@@ -4 +4,0 @@\n-d\n@@ -6,0 +7 @@\n+y\n");
  });

  it("decodes UTF-8, falls back to Latin-1, and detects binary", function () {
    assert.strictEqual(decodeText(Buffer.from("héllo", "utf8")), "héllo");
    assert.strictEqual(decodeText(Uint8Array.from([0x63, 0x61, 0x66, 0xe9])), "café");
    assert.strictEqual(decodeText(Uint8Array.from([0x50, 0x00, 0x01])), undefined);
  });

  it("formats a git commit with a renamed file", function () {
    const c = commit({ path: "src/b.txt", oldPath: "src/a.txt", status: "R090" });
    const { left, right } = previousDiff(c);
    const out = formatDiff({ vcs: "git", commit: c, left: { side: left, text: "one\n" }, right: { side: right, text: "two\n" }, tzOffset: -60 });
    assert.strictEqual(
      out,
      [
        "commit abcdef1234567890",
        "Author: Ann <ann@x>",
        "Date:   Sun Nov 8 10:05:07 2026 +0100",
        "",
        "    Fix the thing",
        "",
        "    Longer story.",
        "",
        "    Second paragraph.",
        "",
        "diff --git a/src/a.txt b/src/b.txt",
        "rename from src/a.txt",
        "rename to src/b.txt",
        "--- a/src/a.txt",
        "+++ b/src/b.txt",
        "@@ -1 +1 @@",
        "-one",
        "+two",
        "",
      ].join("\n")
    );
  });

  it("formats an svn revision that added the file, and binary files", function () {
    const c = commit({ rev: "42", shortRev: "r42", parents: ["41"], body: "", status: "A", oldPath: undefined, path: "trunk/a.txt" });
    const { left, right } = previousDiff(c);
    const out = formatDiff({ vcs: "svn", commit: c, left: { side: left, text: "" }, right: { side: right, text: "hi\n" }, tzOffset: 300 });
    const rule = "-".repeat(72);
    assert.strictEqual(
      out,
      [
        rule,
        "r42 | Ann | 2026-11-08 04:05:07 -0500 (Sun, 08 Nov 2026) | 1 line",
        "",
        "Fix the thing",
        rule,
        "",
        "Index: trunk/a.txt",
        "=".repeat(67),
        "--- trunk/a.txt\t(nonexistent)",
        "+++ trunk/a.txt\t(revision 42)",
        "@@ -0,0 +1 @@",
        "+hi",
        "",
      ].join("\n")
    );
    const bin = formatDiff({ vcs: "git", commit: commit(), left: { side: left, text: undefined }, right: { side: right, text: "x" } });
    assert.match(bin, /Binary files \/dev\/null and b\/trunk\/a.txt differ\n$/);
  });
});
