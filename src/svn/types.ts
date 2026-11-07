// What the SVN backend needs from a working copy, whatever its on-disk format
// (wc16.ts for svn ≤ 1.6, wc17.ts for 1.7+).

export interface SvnNode {
  /** Path relative to the working-copy root, with "/" separators. */
  relPath: string;
  /** "normal": unchanged schedule; "added": no history; "copied": added with history (BASE is the source). */
  schedule: "normal" | "added" | "copied";
  reposRoot?: string;
  uuid?: string;
  /** Path in the repository, relative to the root, not URI-encoded (copy source for a copy). */
  reposPath?: string;
  /** BASE revision (copy source revision for a copy). */
  revision?: number;
  /** Whether there is a pristine text (false for a plain add: compare with nothing). */
  hasBase: boolean;
  /** SHA-1 of the pristine text (1.7+). */
  sha1?: string;
  /** MD5 of the pristine text (1.4–1.6). */
  md5?: string;
  /** Pristine properties of the working node (svn:keywords, svn:eol-style, …). */
  props: Map<string, string>;
  /** Size and mtime (µs) of the working file when svn last saw it unmodified. */
  translatedSize?: number;
  lastModTimeUs?: number;
  changedRev?: number;
  changedDate?: Date;
  changedAuthor?: string;
}

export interface SvnWorkingCopy {
  readonly root: string;
  readonly format: string;
  node(relPath: string): Promise<SvnNode | undefined>;
  pristine(node: SvnNode): Promise<Uint8Array>;
  /** Whether the metadata on disk changed since it was last read. */
  changed(): Promise<boolean>;
}

export class SvnError extends Error {
  constructor(message: string, readonly kind: "unsupported" | "notVersioned" | "other" = "other") {
    super(message);
  }
}
