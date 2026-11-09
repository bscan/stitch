// Static checks that keep Stitch read-only as the code grows.
import * as assert from "assert";
import { readdirSync, readFileSync, statSync } from "fs";
import * as path from "path";
import { ALLOWED_SUBCOMMANDS, buildFetchArgv, checkArgs } from "../src/git/exec";
import { isReadQuery, wcdbUri } from "../src/svn/wcdbProtocol";

const ROOT = path.resolve(__dirname, "..", "..");
const SRC = path.join(ROOT, "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const FS_WRITE = [
  "writeFile", "writeFileSync", "appendFile", "appendFileSync", "createWriteStream",
  "unlink", "unlinkSync", "rm", "rmSync", "rmdir", "rmdirSync", "rename", "renameSync",
  "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync", "copyFile", "copyFileSync", "cp", "cpSync",
  "symlink", "symlinkSync", "link", "linkSync", "truncate", "truncateSync",
  "chmod", "chmodSync", "chown", "chownSync", "utimes", "utimesSync", "open", "openSync",
];

describe("read-only guarantee", function () {
  const files = sources(SRC);

  it("no source file uses fs write APIs", function () {
    const banned = new RegExp(`\\b(fs|fsp|promises)\\s*\\.\\s*(${FS_WRITE.join("|")})\\b`);
    const fsImport = /import\s*\{([^}]*)\}\s*from\s*["'](node:)?fs(\/promises)?["']/g;
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      assert.ok(!banned.test(text), `${path.relative(ROOT, f)} calls an fs write API`);
      for (const m of text.matchAll(fsImport)) {
        const names = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]);
        const bad = names.filter((n) => FS_WRITE.includes(n));
        assert.deepStrictEqual(bad, [], `${path.relative(ROOT, f)} imports ${bad.join(", ")} from fs`);
      }
    }
  });

  it("only src/git/exec.ts starts processes", function () {
    for (const f of files) {
      if (f === path.join(SRC, "git", "exec.ts")) continue;
      const text = readFileSync(f, "utf8");
      assert.ok(!/["'](node:)?child_process["']/.test(text), `${path.relative(ROOT, f)} imports child_process`);
    }
  });

  it("only src/svn/dav.ts makes network requests", function () {
    for (const f of files) {
      if (f === path.join(SRC, "svn", "dav.ts")) continue;
      const text = readFileSync(f, "utf8");
      const net = /(from\s+|require\(\s*|import\(\s*)["'](node:)?(https?|http2|net|tls|dgram)["']/;
      assert.ok(!net.test(text), `${path.relative(ROOT, f)} imports a network module`);
    }
  });

  it("opens SQLite only in the wc.db worker, read-only and immutable, and runs only reads", function () {
    const worker = path.join(SRC, "svn", "wcdbWorker.ts");
    for (const f of files) {
      if (f === worker) continue;
      const text = readFileSync(f, "utf8");
      assert.ok(!/["']node:sqlite["']|["']sql\.js["']|better-sqlite3|["']sqlite3["']/.test(text), `${path.relative(ROOT, f)} uses SQLite`);
    }
    const text = readFileSync(worker, "utf8");
    const opens = text.match(/new DatabaseSync\(.*\);/g) ?? [];
    assert.deepStrictEqual(opens, ["new DatabaseSync(wcdbUri(file), { readOnly: true });"]);
    assert.ok(!/\.exec\s*\(/.test(text), "the worker runs statements only through prepare() after isReadQuery()");
    assert.ok(/if \(!isReadQuery\(q\.sql\)\) throw/.test(text));
    // The URI: read-only mode, immutable (no locks, no journal), special characters escaped.
    assert.strictEqual(wcdbUri("/wc/.svn/wc.db"), "file:///wc/.svn/wc.db?mode=ro&immutable=1");
    assert.strictEqual(wcdbUri("/a b/x?#%/.svn/wc.db"), "file:///a b/x%3F%23%25/.svn/wc.db?mode=ro&immutable=1");
    assert.strictEqual(wcdbUri("C:\\wc\\.svn\\wc.db"), "file:///C:/wc/.svn/wc.db?mode=ro&immutable=1");
    assert.strictEqual(wcdbUri("\\\\server\\share\\wc\\.svn\\wc.db"), "file:////server/share/wc/.svn/wc.db?mode=ro&immutable=1");
    for (const ok of ["PRAGMA user_version", "SELECT 1", "  select x from t where a = ?"]) assert.ok(isReadQuery(ok), ok);
    for (const bad of ["PRAGMA journal_mode=WAL", "DELETE FROM t", "SELECT 1; DELETE FROM t", "ATTACH 'x' AS y", "VACUUM"]) {
      assert.ok(!isReadQuery(bad), bad);
    }
  });

  it("only the VS Code glue modules import vscode (the rest stays testable with mocha)", function () {
    const glue = ["extension.ts", "content.ts", "quickDiff.ts", path.join("history", "historyView.ts")].map((f) =>
      path.join(SRC, f)
    );
    for (const f of files) {
      if (glue.includes(f)) continue;
      const text = readFileSync(f, "utf8");
      assert.ok(!/from\s+["']vscode["']/.test(text), `${path.relative(ROOT, f)} imports vscode`);
    }
  });

  it("is safe to enable in untrusted workspaces", function () {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    assert.deepStrictEqual(pkg.capabilities.untrustedWorkspaces, { supported: true });
    // Settings that pick a program to run or where requests go must not be settable by a
    // workspace (a folder's .vscode/settings.json): "machine" scope is user settings only.
    const props = pkg.contributes.configuration.properties;
    // The fetch exclusions decide where Stitch may write, so a workspace can't loosen them either.
    const machine = ["stitch.git.path", "stitch.svn.urlMap", "stitch.git.fetchExcludePaths", "stitch.git.fetchLocalDrives"];
    for (const key of machine) assert.strictEqual(props[key].scope, "machine", key);
    for (const key of Object.keys(props)) {
      if (!machine.includes(key)) {
        assert.ok(
          ["stitch.logLimit", "stitch.timeoutMs", "stitch.svn.refreshInterval"].includes(key),
          `review ${key} for untrusted workspaces, then list it here`
        );
      }
    }
    // Repository text (messages, paths) is shown in tooltips: never as trusted markdown.
    for (const f of files) {
      assert.ok(!/isTrusted\s*[:=]\s*true/.test(readFileSync(f, "utf8")), `${path.relative(ROOT, f)} trusts markdown`);
    }
  });

  it("contributes only read commands, plus Fetch", function () {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const commands = (pkg.contributes.commands as { command: string }[]).map((c) => c.command).sort();
    assert.deepStrictEqual(commands, [
      "stitch.copyDiff",
      "stitch.copyRevision",
      "stitch.diffFile",
      "stitch.diffWithPrevious",
      "stitch.diffWithWorking",
      "stitch.fetch", // the one write: see the next test
      "stitch.loadMore",
      "stitch.openChanges",
      "stitch.openRevision",
      "stitch.pickRef",
      "stitch.refresh",
      "stitch.revertChange", // edits the editor buffer only: see the next test
    ]);
  });

  it("Revert Change only edits the editor buffer: nothing in src/ saves a document", function () {
    // Saving is left to the user, so Stitch itself still never writes the file.
    const save = /\.save\s*\(|saveAll\s*\(|\.saveAs\s*\(/;
    for (const f of files) {
      assert.ok(!save.test(readFileSync(f, "utf8")), `${path.relative(ROOT, f)} saves a document`);
    }
    // applyEdit is used in one place: the stitch.revertChange command.
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      const at = text.indexOf("applyEdit(");
      if (at === -1) continue;
      assert.strictEqual(f, path.join(SRC, "extension.ts"), `${path.relative(ROOT, f)} applies workspace edits`);
      const cmd = text.indexOf('registerCommand("stitch.revertChange"');
      const next = text.indexOf("registerCommand(", cmd + 1);
      assert.ok(cmd !== -1 && at > cmd && (next === -1 || at < next), "applyEdit is called inside stitch.revertChange");
      assert.strictEqual(text.indexOf("applyEdit(", at + 1), -1, "applyEdit is called once");
    }
  });

  it("the only git write is the Fetch button's fixed `git fetch <remote>`", function () {
    // fetch isn't a regular command: git() refuses it.
    assert.ok(!ALLOWED_SUBCOMMANDS.has("fetch"));
    assert.throws(() => checkArgs(["fetch", "origin"]), /not allowed/);
    // gitFetch's argv is fixed; only the remote varies, and it can't be an option.
    const argv = buildFetchArgv("origin");
    const sub = argv.indexOf("fetch");
    assert.deepStrictEqual(argv.slice(sub), ["fetch", "--no-prune", "--no-prune-tags", "--no-recurse-submodules", "--", "origin"]);
    for (const c of ["core.hooksPath=", "gc.auto=0", "maintenance.auto=false", "protocol.ext.allow=never"]) {
      assert.ok(argv.some((a) => a.startsWith(c)), c);
    }
    for (const bad of ["", ".", "--upload-pack=x", "-u"]) assert.throws(() => buildFetchArgv(bad), /not a remote/);
    // gitFetch is called from one place: the stitch.fetch command.
    for (const f of files) {
      if (f === path.join(SRC, "git", "exec.ts")) continue;
      const text = readFileSync(f, "utf8");
      const calls = text.match(/\bgitFetch\s*\(/g) ?? [];
      if (f === path.join(SRC, "extension.ts")) {
        assert.strictEqual(calls.length, 1, "extension.ts calls gitFetch once");
        const cmd = text.indexOf('registerCommand("stitch.fetch"');
        const next = text.indexOf("registerCommand(", cmd + 1);
        const at = text.search(/\bgitFetch\s*\(/);
        assert.ok(cmd !== -1 && at > cmd && (next === -1 || at < next), "gitFetch is called inside the stitch.fetch command");
      } else {
        assert.ok(!/\bgitFetch\b/.test(text), `${path.relative(ROOT, f)} uses gitFetch`);
      }
    }
  });
});
