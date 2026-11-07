// Reads SVN 1.4–1.6 working copies (entries formats 8, 9, 10). Every versioned
// folder has its own .svn/ with:
//   entries                 line-based records, one per child, separated by "\f\n"
//   text-base/<name>.svn-base   BASE text (keywords contracted)
//   prop-base/<name>.svn-base   BASE properties (hash-dump format)
//   props/<name>.svn-work       working properties
// Read-only: files are only read, and parsed entries are re-read when the
// entries file's mtime or size changes.
import { promises as fs } from "fs";
import * as path from "path";
import { SvnNode, SvnWorkingCopy } from "./types";

/** Field order of an entry in formats 8–10 (libsvn_wc/entries.c, read_entry). */
const FIELDS = [
  "name", "kind", "revision", "url", "repos", "schedule", "textTime", "checksum",
  "cmtDate", "cmtRev", "cmtAuthor", "hasProps", "hasPropMods", "cachableProps", "presentProps",
  "conflictOld", "conflictNew", "conflictWrk", "prejFile", "copied", "copyfromUrl", "copyfromRev",
  "deleted", "absent", "incomplete", "uuid", "lockToken", "lockOwner", "lockComment",
  "lockCreationDate", "changelists", "keepLocal", "workingSize", "depth", "treeConflicts",
  "fileExternalPath", "fileExternalPegRev", "fileExternalRev",
] as const;

export type Entry = Partial<Record<(typeof FIELDS)[number], string>>;

export const ENTRIES_FORMATS = [8, 9, 10];

/** Values are escaped as \xHH for control characters and backslashes. */
const unescape = (s: string) => s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

/** Parses an entries file. The first record is the folder itself (name ""). */
export function parseEntries(text: string): { format: number; entries: Entry[] } {
  const nl = text.indexOf("\n");
  const format = parseInt(text.slice(0, nl), 10);
  if (!ENTRIES_FORMATS.includes(format)) throw new Error(`Unsupported entries format ${format}`);
  const entries: Entry[] = [];
  for (const record of text.slice(nl + 1).split("\f\n")) {
    if (!record.trim() && entries.length > 0) continue;
    const lines = record.split("\n");
    const e: Entry = {};
    FIELDS.forEach((f, i) => {
      const v = lines[i];
      if (v) e[f] = unescape(v);
    });
    if (lines[0] === "" && entries.length === 0) e.name = "";
    entries.push(e);
  }
  return { format, entries };
}

/** Parses svn's hash-dump format ("K <len>\n<key>\nV <len>\n<value>\n … END\n"). */
export function parseHashDump(data: Uint8Array): Map<string, string> {
  const props = new Map<string, string>();
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let i = 0;
  const line = () => {
    const end = buf.indexOf(0x0a, i);
    if (end < 0) throw new Error("hash dump: truncated");
    const s = buf.toString("latin1", i, end);
    i = end + 1;
    return s;
  };
  const block = (prefix: string) => {
    const header = line();
    if (!header.startsWith(prefix + " ")) throw new Error(`hash dump: expected ${prefix}`);
    const len = parseInt(header.slice(2), 10);
    const value = buf.toString("utf8", i, i + len);
    i += len + 1; // value + "\n"
    return value;
  };
  while (i < buf.length) {
    if (buf.toString("latin1", i, i + 3) === "END") break;
    const key = block("K");
    props.set(key, block("V"));
  }
  return props;
}

interface Dir {
  mtimeMs: number;
  size: number;
  entries: Map<string, Entry>;
  self: Entry;
}

function encodeName(name: string): string {
  return encodeURIComponent(name).replace(/%(21|24|26|27|28|29|2A|2B|2C|3B|3D|3A|40)/gi, (_, h) =>
    String.fromCharCode(parseInt(h, 16))
  );
}

function decodeUrlPath(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/** "2024-01-02T03:04:05.123456Z" → microseconds since the epoch. */
export function isoToMicros(s: string | undefined): number | undefined {
  const m = s && /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?Z$/.exec(s);
  if (!m) return undefined;
  const ms = Date.parse(m[1] + "Z");
  return ms * 1000 + parseInt((m[2] ?? "").padEnd(6, "0"), 10);
}

export class Wc16 implements SvnWorkingCopy {
  readonly format = "1.4–1.6";
  private readonly dirs = new Map<string, Promise<Dir>>();
  private readonly seen = new Map<string, { mtimeMs: number; size: number }>();

  constructor(readonly root: string) {}

  /**
   * The working-copy root for a folder with a format 8–10 .svn: the highest
   * ancestor whose entries list the folder below it as a child directory.
   * (svn:externals have their own .svn but aren't listed by the parent, so they stay separate.)
   */
  static async findRoot(dir: string): Promise<string> {
    let cur = dir;
    for (;;) {
      const parent = path.dirname(cur);
      if (parent === cur) return cur;
      let text: string;
      try {
        text = await fs.readFile(path.join(parent, ".svn", "entries"), "utf8");
      } catch {
        return cur;
      }
      let listed = false;
      try {
        listed = parseEntries(text).entries.some((e) => e.name === path.basename(cur) && e.kind === "dir");
      } catch {
        listed = false;
      }
      if (!listed) return cur;
      cur = parent;
    }
  }

  private async dir(rel: string): Promise<Dir> {
    const file = path.join(this.root, rel, ".svn", "entries");
    const st = await fs.stat(file);
    const cached = this.dirs.get(rel);
    if (cached) {
      const d = await cached.catch(() => undefined);
      if (d && d.mtimeMs === st.mtimeMs && d.size === st.size) return d;
    }
    const p = fs.readFile(file, "utf8").then((text) => {
      const { entries } = parseEntries(text);
      const self = entries[0];
      const map = new Map<string, Entry>();
      for (const e of entries.slice(1)) if (e.name) map.set(e.name, e);
      this.seen.set(rel, { mtimeMs: st.mtimeMs, size: st.size });
      return { mtimeMs: st.mtimeMs, size: st.size, entries: map, self };
    });
    p.catch(() => this.dirs.delete(rel));
    this.dirs.set(rel, p);
    return p;
  }

  async changed(): Promise<boolean> {
    for (const [rel, s] of this.seen) {
      try {
        const st = await fs.stat(path.join(this.root, rel, ".svn", "entries"));
        if (st.mtimeMs !== s.mtimeMs || st.size !== s.size) return true;
      } catch {
        return true;
      }
    }
    return false;
  }

  private async props(dirRel: string, name: string, entry: Entry): Promise<Map<string, string>> {
    const svn = path.join(this.root, dirRel, ".svn");
    const candidates = [path.join(svn, "prop-base", `${name}.svn-base`)];
    // A plain add has no BASE props; its only props are the working ones.
    if (entry.schedule === "add" && !entry.copied) candidates.unshift(path.join(svn, "props", `${name}.svn-work`));
    for (const p of candidates) {
      try {
        return parseHashDump(new Uint8Array(await fs.readFile(p)));
      } catch {
        // missing: no props
      }
    }
    return new Map();
  }

  async node(relPath: string): Promise<SvnNode | undefined> {
    const dirRel = path.posix.dirname(relPath) === "." ? "" : path.posix.dirname(relPath);
    const name = path.posix.basename(relPath);
    let dir: Dir;
    try {
      dir = await this.dir(dirRel);
    } catch {
      return undefined;
    }
    const e = dir.entries.get(name);
    if (!e || e.kind !== "file") return undefined;
    if (e.deleted === "deleted" || e.absent === "absent" || e.schedule === "delete") return undefined;

    const reposRoot = e.repos ?? dir.self.repos;
    const url = e.url ?? (dir.self.url ? `${dir.self.url}/${encodeName(name)}` : undefined);
    const copied = e.copied === "copied";
    const added = e.schedule === "add" || e.schedule === "replace";
    const originUrl = copied ? e.copyfromUrl : added ? undefined : url;
    const reposPath =
      originUrl && reposRoot && (originUrl === reposRoot || originUrl.startsWith(reposRoot + "/"))
        ? decodeUrlPath(originUrl.slice(reposRoot.length + 1))
        : undefined;
    const revision = copied ? e.copyfromRev : added ? undefined : e.revision ?? dir.self.revision;
    const hasBase = !added || copied;
    const cmtDate = isoToMicros(e.cmtDate);
    return {
      relPath,
      schedule: copied ? "copied" : added ? "added" : "normal",
      reposRoot: originUrl ? reposRoot : undefined,
      uuid: e.uuid ?? dir.self.uuid,
      reposPath,
      revision: revision !== undefined ? parseInt(revision, 10) : undefined,
      md5: hasBase ? e.checksum : undefined,
      hasBase,
      props: await this.props(dirRel, name, e),
      translatedSize: e.workingSize !== undefined ? parseInt(e.workingSize, 10) : undefined,
      lastModTimeUs: isoToMicros(e.textTime),
      changedRev: e.cmtRev !== undefined ? parseInt(e.cmtRev, 10) : undefined,
      changedDate: cmtDate !== undefined ? new Date(cmtDate / 1000) : undefined,
      changedAuthor: e.cmtAuthor,
    };
  }

  async pristine(node: SvnNode): Promise<Uint8Array> {
    if (!node.hasBase) return new Uint8Array();
    const dirRel = path.posix.dirname(node.relPath) === "." ? "" : path.posix.dirname(node.relPath);
    const svn = path.join(this.root, dirRel, ".svn", "text-base");
    const name = path.posix.basename(node.relPath);
    return new Uint8Array(await fs.readFile(path.join(svn, `${name}.svn-base`)));
  }
}
