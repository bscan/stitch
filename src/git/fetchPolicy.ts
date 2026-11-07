// Where the Fetch button is offered. A fetch writes into the repository's .git
// folder; on a network share that is slow (and the share may be used by others),
// so repositories on network paths are excluded:
//   - every platform: paths under a `stitch.git.fetchExcludePaths` prefix;
//   - Linux: anything /proc/mounts reports on a network file system;
//   - Windows: UNC paths (\\server\share), and drives not in `stitch.git.fetchLocalDrives`.
// Read-only: at most one read of /proc/mounts.
import { promises as fs } from "fs";

export interface FetchPolicy {
  /** Path prefixes to exclude; they match whole path segments ("/smb" matches /smb/x, not /smbx). */
  excludePaths: string[];
  /** Windows: drive letters that are local disks ("C:", "D"). */
  localDrives: string[];
  platform: NodeJS.Platform;
  /** Linux: the contents of /proc/mounts, if it could be read. */
  mounts?: string;
}

/** File system types (from /proc/mounts) that live on another machine. */
const NETWORK_FS = new Set([
  "cifs", "smb3", "smbfs", "nfs", "nfs4", "sshfs", "fuse.sshfs", "fuse.rclone", "davfs", "fuse.davfs2",
  "afs", "ceph", "glusterfs", "fuse.glusterfs", "9p", "lustre", "gpfs", "beegfs",
]);

export async function readMounts(platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  if (platform !== "linux") return undefined;
  try {
    return await fs.readFile("/proc/mounts", "utf8");
  } catch {
    return undefined;
  }
}

/** Why fetching is not offered for a repository with these folders (root and .git), or undefined if it is. */
export function fetchBlockedReason(paths: string[], policy: FetchPolicy): string | undefined {
  for (const p of paths) {
    const why = blocked(p, policy);
    if (why) return why;
  }
  return undefined;
}

function blocked(p: string, policy: FetchPolicy): string | undefined {
  const win = policy.platform === "win32";
  const norm = (s: string) => (win ? s.replace(/\\/g, "/").toLowerCase() : s);
  const file = norm(p);

  if (win) {
    if (/^\/\//.test(file)) return `${p} is a network path (UNC)`;
    const drive = /^([a-z]):/.exec(file)?.[1];
    const local = policy.localDrives.map((d) => d.trim().replace(/[:\\/]+$/, "").toLowerCase());
    if (drive && !local.includes(drive)) {
      return `${drive.toUpperCase()}: isn't one of the local drives in stitch.git.fetchLocalDrives`;
    }
  }

  for (const prefix of policy.excludePaths) {
    const pre = norm(prefix).replace(/\/+$/, "");
    if (pre && (file === pre || file.startsWith(pre + "/"))) return `${p} is under ${prefix} (stitch.git.fetchExcludePaths)`;
  }

  if (policy.platform === "linux" && policy.mounts) {
    const m = mountFor(file, policy.mounts);
    if (m && NETWORK_FS.has(m.type)) return `${p} is on a network file system (${m.type} at ${m.point})`;
  }
  return undefined;
}

/** The mount (longest mount point containing `file`) from /proc/mounts text. */
export function mountFor(file: string, mounts: string): { point: string; type: string } | undefined {
  let best: { point: string; type: string } | undefined;
  for (const line of mounts.split("\n")) {
    const f = line.split(" ");
    if (f.length < 3) continue;
    // /proc/mounts escapes space, tab, newline and backslash as octal (\040).
    const point = f[1].replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
    const inside = point === "/" || file === point || file.startsWith(point + "/");
    if (inside && (!best || point.length >= best.point.length)) best = { point, type: f[2] };
  }
  return best;
}
