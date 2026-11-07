// Starts the mod_dav_svn test server (test/fixtures/svn-server) in podman.
// Test-only: runs podman directly. Returns undefined when podman isn't usable
// or STITCH_NO_PODMAN is set, so the server tests skip instead of failing.
import { execFileSync } from "child_process";
import * as http from "http";
import * as path from "path";

const IMAGE = "localhost/stitch-svn-server";
const CONTEXT = path.resolve(__dirname, "..", "..", "test", "fixtures", "svn-server");

export interface Server {
  /** http://127.0.0.1:<port> */
  base: string;
  expected(name: string): Promise<Buffer>;
  stop(): void;
}

function fetch(url: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      })
      .on("error", reject);
  });
}

export async function startServer(): Promise<Server | undefined> {
  if (process.env.STITCH_NO_PODMAN) return undefined;
  const podman = (...args: string[]) => execFileSync("podman", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    podman("--version");
  } catch {
    return undefined;
  }
  podman("build", "-q", "-t", IMAGE, CONTEXT); // cached after the first run
  const id = podman("run", "-d", "--rm", "-p", "127.0.0.1::80", IMAGE);
  const stop = () => {
    try {
      podman("rm", "-f", id);
    } catch {
      // already gone
    }
  };
  try {
    const port = podman("port", id, "80").split("\n")[0].replace(/.*:/, "");
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; ; i++) {
      const ok = await fetch(`${base}/expected/ready`).then((r) => r.status === 200, () => false);
      if (ok) break;
      if (i > 100) throw new Error("svn test server didn't start");
      await new Promise((r) => setTimeout(r, 100));
    }
    return {
      base,
      async expected(name) {
        const r = await fetch(`${base}/expected/${name}`);
        if (r.status !== 200) throw new Error(`expected/${name}: HTTP ${r.status}`);
        return r.body;
      },
      stop,
    };
  } catch (e) {
    stop();
    throw e;
  }
}
