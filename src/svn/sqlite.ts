// Loads sql.js (SQLite compiled to WebAssembly). SVN 1.7+ keeps its working-copy
// metadata in .svn/wc.db; reading it with sql.js needs no native module and no
// svn binary. Databases are always opened from an in-memory copy of the file
// bytes, so nothing is ever written back to disk.
import { existsSync, promises as fs } from "fs";
import * as path from "path";
import initSqlJs, { Database, SqlJsStatic } from "sql.js";

let loaded: Promise<SqlJsStatic> | undefined;

/** The wasm file: next to the bundle (dist/), or in node_modules when running tests. */
function wasmPath(): string {
  const bundled = path.join(__dirname, "sql-wasm.wasm");
  if (existsSync(bundled)) return bundled;
  // Indirect, so esbuild doesn't try to bundle the lookup (the bundled path above is used there).
  const resolve: (id: string) => string = require.resolve;
  return path.join(path.dirname(resolve("sql.js")), "sql-wasm.wasm");
}

function sqlJs(): Promise<SqlJsStatic> {
  if (!loaded) {
    loaded = fs.readFile(wasmPath()).then((b) => initSqlJs({ wasmBinary: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer }));
    loaded.catch(() => (loaded = undefined));
  }
  return loaded;
}

/** Opens a database from bytes already read from disk. */
export async function openDatabase(bytes: Uint8Array): Promise<Database> {
  const SQL = await sqlJs();
  return new SQL.Database(bytes);
}

export type { Database };
