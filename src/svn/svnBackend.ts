// SVN backend, local part: everything that comes from .svn/ alone (no network,
// no svn binary). BASE text for the gutter and Open Changes, modification
// checks, and the URL/revision that history will start from.
import { promises as fs } from "fs";
import * as path from "path";
import { contractKeywords, expandKeywords, parseKeywords } from "./keywords";
import { SvnError, SvnNode, SvnWorkingCopy } from "./types";
import { ENTRIES_FORMATS, Wc16 } from "./wc16";
import { Wc17 } from "./wc17";

export { SvnError } from "./types";

async function readEntriesFormat(dir: string): Promise<number | undefined> {
  try {
    const text = await fs.readFile(path.join(dir, ".svn", "entries"), "utf8");
    const n = parseInt(text, 10);
    return Number.isNaN(n) ? undefined : n;
  } catch {
    return undefined;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Opens the working copy whose .svn marker sits in `dir` (from the resolver). */
export async function openWorkingCopy(dir: string, timeoutMs?: () => number): Promise<SvnWorkingCopy> {
  if (await exists(path.join(dir, ".svn", "wc.db"))) return new Wc17(dir, timeoutMs);
  const format = await readEntriesFormat(dir);
  if (format !== undefined && ENTRIES_FORMATS.includes(format)) return new Wc16(await Wc16.findRoot(dir));
  throw new SvnError(
    format === undefined
      ? "This .svn folder has no wc.db or entries file, so it looks incomplete. A fresh checkout fixes it."
      : format < 8
        ? `This working copy (format ${format}) is from svn 1.3 or older, which isn't supported.`
        : `Unknown SVN working copy format ${format}.`,
    "unsupported"
  );
}

/** URI-encodes a repository path the way svn does in URLs (keeps "/" and the usual safe characters). */
export function encodeReposPath(p: string): string {
  return p
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/%(21|24|26|27|28|29|2A|2B|2C|3B|3D|3A|40)/gi, (_, h) => String.fromCharCode(parseInt(h, 16))))
    .join("/");
}

export function nodeUrl(node: SvnNode): string | undefined {
  if (!node.reposRoot || node.reposPath === undefined) return undefined;
  return node.reposPath ? `${node.reposRoot}/${encodeReposPath(node.reposPath)}` : node.reposRoot;
}

/** LF-normalizes line endings (CRLF and lone CR). */
function normalizeEol(data: Uint8Array): Uint8Array {
  if (!data.includes(0x0d)) return data;
  const out = new Uint8Array(data.length);
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b === 0x0d) {
      out[n++] = 0x0a;
      if (data[i + 1] === 0x0a) i++;
    } else {
      out[n++] = b;
    }
  }
  return out.subarray(0, n);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.compare(a, b) === 0;
}

export class SvnRepo {
  constructor(readonly wc: SvnWorkingCopy) {}

  get root(): string {
    return this.wc.root;
  }

  /** `timeoutMs`: how long a wc.db read may take (a slow network drive). */
  static async open(dir: string, timeoutMs?: () => number): Promise<SvnRepo> {
    return new SvnRepo(await openWorkingCopy(dir, timeoutMs));
  }

  relPath(file: string): string {
    return path.relative(this.root, file).split(path.sep).join("/");
  }

  /** The node for a file, or undefined if svn doesn't track it. */
  node(file: string): Promise<SvnNode | undefined> {
    return this.wc.node(this.relPath(file));
  }

  /** BASE text as the working file would show it: keywords expanded like the client does. */
  async original(node: SvnNode): Promise<Uint8Array> {
    const raw = await this.wc.pristine(node);
    const set = parseKeywords(node.props.get("svn:keywords"));
    if (set.size === 0) return raw;
    return expandKeywords(raw, set, {
      rev: node.changedRev,
      url: nodeUrl(node),
      reposRoot: node.reposRoot,
      author: node.changedAuthor,
      date: node.changedDate,
    });
  }

  /** Same answer as the "M" column of `svn status`, for files (text only, not properties). */
  async isModified(file: string, node: SvnNode): Promise<boolean> {
    if (node.schedule !== "normal") return true;
    let st;
    try {
      st = await fs.stat(file, { bigint: true });
    } catch {
      return true; // missing
    }
    if (
      node.translatedSize !== undefined &&
      node.lastModTimeUs !== undefined &&
      Number(st.size) === node.translatedSize &&
      st.mtimeNs / 1000n === BigInt(node.lastModTimeUs)
    ) {
      return false;
    }
    let working: Uint8Array = new Uint8Array(await fs.readFile(file));
    let base = await this.wc.pristine(node);
    const set = parseKeywords(node.props.get("svn:keywords"));
    if (set.size) {
      working = contractKeywords(working, set);
      base = contractKeywords(base, set);
    }
    if (node.props.has("svn:eol-style")) {
      working = normalizeEol(working);
      base = normalizeEol(base);
    }
    return !equalBytes(working, base);
  }

  /** Whether .svn metadata changed since last read (after an update, commit or revert). */
  changed(): Promise<boolean> {
    return this.wc.changed();
  }
}
