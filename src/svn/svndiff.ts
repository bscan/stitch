// svndiff: the delta format of Subversion's file-revs-report (and the FSFS store).
// Versions 0 (plain) and 1 (zlib) are decoded; Stitch doesn't advertise either
// compressed format, so servers send version 0. Version 2 (LZ4) is rejected.
//
// A delta is "SVN" + a version byte, then windows. Each window describes one
// stretch of the target: a view of the source (offset, length), the target's
// length, and instructions that copy from that source view, from the target
// built so far, or from the window's new data.
import { inflateSync } from "zlib";

export class SvndiffError extends Error {}

/**
 * The longest text a delta may build, so a broken or hostile server can't make Stitch
 * allocate gigabytes (a window's target length comes from the server, and a few bytes
 * of instructions can claim any length). A text this long isn't worth a line search.
 */
export const MAX_TEXT = 256 * 1024 * 1024;

class Reader {
  constructor(
    private readonly buf: Buffer,
    public pos = 0
  ) {}
  get done(): boolean {
    return this.pos >= this.buf.length;
  }
  /** An unsigned integer: 7 bits per byte, most significant first, high bit set on all but the last. */
  int(): number {
    let n = 0;
    for (;;) {
      if (this.pos >= this.buf.length) throw new SvndiffError("svndiff: truncated number");
      const b = this.buf[this.pos++];
      n = n * 128 + (b & 0x7f);
      if (n > Number.MAX_SAFE_INTEGER / 128) throw new SvndiffError("svndiff: number too large");
      if (!(b & 0x80)) return n;
    }
  }
  bytes(n: number): Buffer {
    if (this.pos + n > this.buf.length) throw new SvndiffError("svndiff: truncated window");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

/** Version 1 sections: the original length, then the bytes, zlib-compressed unless that didn't make them smaller. */
function unpack(section: Buffer, version: number): Buffer {
  if (version === 0) return section;
  const r = new Reader(section);
  const len = r.int();
  const rest = section.subarray(r.pos);
  if (rest.length === len) return rest;
  const out = inflateSync(rest);
  if (out.length !== len) throw new SvndiffError("svndiff: bad compressed section");
  return out;
}

/** Applies an svndiff delta to `source` (the previous text; empty for the first) and returns the target. */
export function applySvndiff(source: Buffer, delta: Buffer): Buffer {
  // Not even a header (mod_dav_svn doesn't send that; it leaves the delta out): unchanged.
  // A header without windows, by contrast, is an empty text.
  if (delta.length === 0) return source;
  if (delta.length < 4 || delta.toString("latin1", 0, 3) !== "SVN") throw new SvndiffError("svndiff: bad header");
  const version = delta[3];
  if (version > 1) throw new SvndiffError(`svndiff: version ${version} isn't supported`);
  const r = new Reader(delta, 4);
  const parts: Buffer[] = [];
  let total = 0;
  while (!r.done) {
    const sOff = r.int();
    const sLen = r.int();
    const tLen = r.int();
    const insLen = r.int();
    const newLen = r.int();
    total += tLen;
    if (total > MAX_TEXT) throw new SvndiffError(`svndiff: text over ${MAX_TEXT} bytes`);
    if (sOff + sLen > source.length) throw new SvndiffError("svndiff: source view outside the source");
    const view = source.subarray(sOff, sOff + sLen);
    const ins = new Reader(unpack(r.bytes(insLen), version));
    const data = unpack(r.bytes(newLen), version);
    const t = Buffer.alloc(tLen);
    let tPos = 0;
    let dPos = 0;
    while (!ins.done) {
      const first = ins.bytes(1)[0];
      const op = first >> 6;
      let len = first & 0x3f;
      if (len === 0) len = ins.int();
      if (tPos + len > tLen) throw new SvndiffError("svndiff: window overflows its target");
      if (op === 0) {
        const off = ins.int();
        if (off + len > view.length) throw new SvndiffError("svndiff: copy outside the source view");
        view.copy(t, tPos, off, off + len);
      } else if (op === 1) {
        // From the target so far; may overlap what it writes (a repeating pattern), so byte by byte.
        const off = ins.int();
        if (off >= tPos) throw new SvndiffError("svndiff: copy from unwritten target");
        for (let i = 0; i < len; i++) t[tPos + i] = t[off + i];
      } else if (op === 2) {
        if (dPos + len > data.length) throw new SvndiffError("svndiff: new data overrun");
        data.copy(t, tPos, dPos, dPos + len);
        dPos += len;
      } else {
        throw new SvndiffError("svndiff: bad instruction");
      }
      tPos += len;
    }
    if (tPos !== tLen) throw new SvndiffError("svndiff: window shorter than its target");
    parts.push(t);
  }
  return Buffer.concat(parts);
}
