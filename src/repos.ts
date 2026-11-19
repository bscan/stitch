// Finds the repositories (git repositories and SVN working copies) of a
// workspace, for the "Other working copies" part of the filter menu and for
// Show History on a folder that holds several. Read-only: stat and readdir.
import { promises as fs } from "fs";
import * as path from "path";
import { Marker, markerAt, Resolver } from "./resolver";

/**
 * The repository markers found for some folders, in order, without duplicates:
 * for each folder, the repository it is or lies in, then its immediate child
 * folders that are repositories themselves (not recursive, dot-folders skipped).
 * Several markers can belong to one repository (svn ≤ 1.6 has .svn in every
 * folder); callers that open them dedupe by root.
 */
export async function findRepositories(folders: string[], resolver: Resolver): Promise<Marker[]> {
  const out: Marker[] = [];
  const seen = new Set<string>();
  const add = (m: Marker | undefined) => {
    if (!m || seen.has(m.dir)) return;
    seen.add(m.dir);
    out.push(m);
  };
  for (const folder of folders) {
    add(await resolver.forDir(folder).catch(() => undefined));
    for (const m of await childRepositories(folder)) add(m);
  }
  return out;
}

/** Immediate child folders of `dir` that are repositories (have a .git or .svn of their own). */
export async function childRepositories(dir: string): Promise<Marker[]> {
  let names: string[];
  try {
    names = (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name);
  } catch {
    return [];
  }
  names.sort((a, b) => a.localeCompare(b));
  const found = await Promise.all(names.map((n) => markerAt(path.join(dir, n)).catch(() => undefined)));
  return found.filter((m): m is Marker => m !== undefined);
}
