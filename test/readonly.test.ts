// Static checks that keep Stitch read-only as the code grows.
import * as assert from "assert";
import { readdirSync, readFileSync, statSync } from "fs";
import * as path from "path";

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

  it("never serializes an SQLite database (wc.db is only read into memory)", function () {
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      assert.ok(!/\.export\s*\(/.test(text), `${path.relative(ROOT, f)} calls .export()`);
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
    for (const key of ["stitch.git.path", "stitch.svn.urlMap"]) assert.strictEqual(props[key].scope, "machine", key);
    for (const key of Object.keys(props)) {
      if (!["stitch.git.path", "stitch.svn.urlMap"].includes(key)) {
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

  it("contributes only read commands", function () {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const commands = (pkg.contributes.commands as { command: string }[]).map((c) => c.command).sort();
    assert.deepStrictEqual(commands, [
      "stitch.copyRevision",
      "stitch.diffFile",
      "stitch.diffWithPrevious",
      "stitch.diffWithWorking",
      "stitch.loadMore",
      "stitch.openChanges",
      "stitch.openRevision",
      "stitch.pickRef",
      "stitch.refresh",
    ]);
  });
});
