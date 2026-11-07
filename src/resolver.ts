// Finds which version control system a file belongs to, by walking up from the
// file's folder. The nearest .git (folder, or file for worktrees/submodules) or
// .svn marker wins, so git-inside-svn and svn-inside-git both resolve to the
// innermost one. Read-only: only stat() is used.
import { promises as fs } from "fs";
import * as path from "path";

export type VcsKind = "git" | "svn";

export interface Marker {
  kind: VcsKind;
  /** Folder that contains the .git/.svn marker. */
  dir: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export class Resolver {
  private cache = new Map<string, Promise<Marker | undefined>>();

  /** Marker for a file's folder, or undefined if it isn't under version control. */
  forFile(file: string): Promise<Marker | undefined> {
    return this.forDir(path.dirname(file));
  }

  forDir(dir: string): Promise<Marker | undefined> {
    let p = this.cache.get(dir);
    if (!p) {
      p = this.walk(dir);
      this.cache.set(dir, p);
    }
    return p;
  }

  clear(): void {
    this.cache.clear();
  }

  private async walk(start: string): Promise<Marker | undefined> {
    let dir = start;
    for (;;) {
      // Check git first only to break a tie when both markers sit in the same folder.
      if (await exists(path.join(dir, ".git"))) return { kind: "git", dir };
      if (await exists(path.join(dir, ".svn"))) return { kind: "svn", dir };
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  }
}
