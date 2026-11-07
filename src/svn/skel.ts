// Parser for Subversion "skel" data, the format wc.db uses for property lists
// (NODES.properties, ACTUAL_NODE.properties). Grammar (libsvn_subr/skel.c):
//   skel     = list | atom
//   list     = "(" { whitespace } { skel { whitespace } } ")"
//   atom     = implicit | explicit
//   implicit = name-start-char { any byte but whitespace and parentheses }
//   explicit = decimal-length whitespace-byte <length raw bytes>
// A property list is a list of alternating name and value atoms.

export type Skel = Uint8Array | Skel[];

const isSpace = (b: number) => b === 0x20 || (b >= 0x09 && b <= 0x0d);
const isDigit = (b: number) => b >= 0x30 && b <= 0x39;
const isNameStart = (b: number) => (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);

export function parseSkel(data: Uint8Array): Skel {
  let i = 0;
  const skipSpace = () => {
    while (i < data.length && isSpace(data[i])) i++;
  };
  const parse = (): Skel => {
    skipSpace();
    if (i >= data.length) throw new Error("skel: unexpected end");
    const b = data[i];
    if (b === 0x28 /* ( */) {
      i++;
      const list: Skel[] = [];
      for (;;) {
        skipSpace();
        if (i >= data.length) throw new Error("skel: unterminated list");
        if (data[i] === 0x29 /* ) */) {
          i++;
          return list;
        }
        list.push(parse());
      }
    }
    if (isDigit(b)) {
      let len = 0;
      while (i < data.length && isDigit(data[i])) len = len * 10 + (data[i++] - 0x30);
      if (i >= data.length || !isSpace(data[i])) throw new Error("skel: bad explicit atom");
      i++;
      if (i + len > data.length) throw new Error("skel: atom past end");
      const atom = data.subarray(i, i + len);
      i += len;
      return atom;
    }
    if (isNameStart(b)) {
      const start = i;
      while (i < data.length && !isSpace(data[i]) && data[i] !== 0x28 && data[i] !== 0x29) i++;
      return data.subarray(start, i);
    }
    throw new Error(`skel: unexpected byte ${b}`);
  };
  return parse();
}

const utf8 = new TextDecoder("utf-8");

/** Parses a skel property list into name → value (decoded as UTF-8). */
export function parseProps(data: Uint8Array | null | undefined): Map<string, string> {
  const props = new Map<string, string>();
  if (!data || data.length === 0) return props;
  const skel = parseSkel(data);
  if (!Array.isArray(skel)) throw new Error("skel: property list is not a list");
  for (let k = 0; k + 1 < skel.length; k += 2) {
    const name = skel[k];
    const value = skel[k + 1];
    if (Array.isArray(name) || Array.isArray(value)) continue;
    props.set(utf8.decode(name), utf8.decode(value));
  }
  return props;
}
