// svn:keywords expansion and contraction, following libsvn_subr/subst.c.
//
// BASE text (the pristine) is stored with keywords contracted ("$Rev$"); the
// working file has them expanded ("$Rev: 42 $"). To diff the two without a
// spurious change on every keyword line, the pristine is expanded the way the
// client would have expanded it. Works on bytes: keywords are ASCII, and the
// rest of the file passes through untouched (whatever its encoding).

export interface KeywordInfo {
  /** Last-changed revision. */
  rev?: number;
  /** Full URL of the file (URI-encoded). */
  url?: string;
  /** Repository root URL. */
  reposRoot?: string;
  author?: string;
  date?: Date;
}

/** Keyword name (exactly as it may appear in a file) → format. */
export type KeywordSet = Map<string, string>;

const BUILTIN: { names: string[]; short: string; format: string }[] = [
  { names: ["LastChangedRevision", "Revision", "Rev"], short: "rev", format: "%r" },
  { names: ["LastChangedDate", "Date"], short: "date", format: "%D" },
  { names: ["LastChangedBy", "Author"], short: "author", format: "%a" },
  { names: ["HeadURL", "URL"], short: "url", format: "%u" },
  { names: ["Id"], short: "id", format: "%b %r %d %a" },
  { names: ["Header"], short: "header", format: "%u %r %d %a" },
];

const MAX_LEN = 255; // SVN_KEYWORD_MAX_LEN

/**
 * Parses an svn:keywords property value. Like svn, the long and medium names
 * match exactly, the short name case-insensitively, and enabling any alias
 * enables them all. "Name=format" defines a custom keyword (svn 1.8+).
 */
export function parseKeywords(prop: string | undefined): KeywordSet {
  const set: KeywordSet = new Map();
  if (!prop) return set;
  for (const token of prop.split(/[ \t\v\n\b\r\f]+/)) {
    if (!token) continue;
    const eq = token.indexOf("=");
    if (eq > 0) {
      set.set(token.slice(0, eq), token.slice(eq + 1));
      continue;
    }
    const kw = BUILTIN.find(
      (k) => k.names.slice(0, -1).includes(token) || token.toLowerCase() === k.short
    );
    if (kw) for (const n of kw.names) set.set(n, kw.format);
  }
  return set;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2024-01-02 03:04:05Z" (UTC), as in $Id$. */
function shortDate(d: Date): string {
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
  );
}

/** "2024-01-02 03:04:05 +0100 (Tue, 02 Jan 2024)" (local time), as in $Date$. */
function longDate(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off < 0 ? "-" : "+";
  const tz = `${sign}${pad(Math.floor(Math.abs(off) / 60))}${pad(Math.abs(off) % 60)}`;
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${tz} ` +
    `(${DAYS[d.getDay()]}, ${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()})`
  );
}

function uriDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** keyword_printf() from subst.c. */
export function formatKeyword(format: string, info: KeywordInfo): string {
  const rev = info.rev !== undefined ? String(info.rev) : "";
  const url = info.url ?? "";
  const base = uriDecode(url.slice(url.lastIndexOf("/") + 1));
  const rel =
    info.reposRoot && url.startsWith(info.reposRoot) ? uriDecode(url.slice(info.reposRoot.length).replace(/^\//, "")) : "";
  const d = info.date ? shortDate(info.date) : "";
  const a = info.author ?? "";
  let out = "";
  for (let i = 0; i < format.length; i++) {
    const c = format[i];
    if (c !== "%" || i + 1 >= format.length) {
      out += c;
      continue;
    }
    const code = format[++i];
    switch (code) {
      case "a": out += a; break;
      case "b": out += base; break;
      case "d": out += d; break;
      case "D": out += info.date ? longDate(info.date) : ""; break;
      case "P": out += rel; break;
      case "r": out += rev; break;
      case "R": out += info.reposRoot ?? ""; break;
      case "u": out += url; break;
      case "H": out += `${rel} ${rev} ${d} ${a}`; break;
      case "I": out += `${base} ${rev} ${d} ${a}`; break;
      case "_": out += " "; break;
      case "%": out += "%"; break;
      default: out += "%" + code;
    }
  }
  return out;
}

/**
 * Rewrites every keyword in `data`. `value(name)` returns the new text between
 * "$Name: " and " $", or undefined to contract to "$Name$". Fixed-width
 * keywords ("$Name:: … $") keep their width, as in svn.
 */
function rewrite(data: Uint8Array, set: KeywordSet, value: (name: string) => string | undefined): Uint8Array {
  if (set.size === 0) return data;
  const s = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("latin1");
  let out = "";
  let last = 0;
  let i = s.indexOf("$");
  while (i >= 0) {
    const j = s.indexOf("$", i + 1);
    if (j < 0) break;
    if (j - i + 1 > MAX_LEN) {
      i = j;
      continue;
    }
    const inner = s.slice(i + 1, j);
    const colon = inner.indexOf(":");
    const name = colon < 0 ? inner : inner.slice(0, colon);
    let replacement: string | undefined;
    if (set.has(name)) {
      const v = value(name);
      const rest = colon < 0 ? undefined : inner.slice(colon);
      if (rest === undefined) {
        // "$Name$"
        if (v !== undefined) replacement = `$${name}: ${v} $`;
        else replacement = `$${name}$`;
      } else if (rest.startsWith(":: ") && rest.length >= 4 && (rest.endsWith(" ") || rest.endsWith("#"))) {
        // "$Name:: <fixed width> $"
        const width = rest.length - 4; // between ":: " and the final " " or "#"
        let text = v ?? "";
        let tail = " ";
        if (text.length > width) {
          text = text.slice(0, width);
          tail = "#";
        }
        replacement = `$${name}:: ${text.padEnd(width, " ")}${tail}$`;
      } else if (rest.startsWith(": ") && rest.endsWith(" ")) {
        // "$Name: <old value> $"
        replacement = v !== undefined ? `$${name}: ${v} $` : `$${name}$`;
      }
    }
    if (replacement !== undefined) {
      out += s.slice(last, i) + replacement;
      last = j + 1;
      i = s.indexOf("$", j + 1);
    } else {
      i = j; // the closing "$" may open the next keyword
    }
  }
  if (last === 0) return data;
  out += s.slice(last);
  return new Uint8Array(Buffer.from(out, "latin1"));
}

/** Expands keywords, as the client does when writing the working file. */
export function expandKeywords(data: Uint8Array, set: KeywordSet, info: KeywordInfo): Uint8Array {
  // Values are UTF-8 (author names, URLs); the buffer is handled as latin1 bytes.
  return rewrite(data, set, (name) => {
    const v = formatKeyword(set.get(name) ?? "", info);
    return Buffer.from(v, "utf8").toString("latin1");
  });
}

/** Contracts keywords, as the client does before comparing a working file with BASE. */
export function contractKeywords(data: Uint8Array, set: KeywordSet): Uint8Array {
  return rewrite(data, set, () => undefined);
}
