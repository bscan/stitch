// Maps a working copy's repository URL to an http(s) URL that history can be
// fetched from. svn:// (svnserve) and svn+ssh:// working copies need a mapping
// from the "stitch.svn.urlMap" setting, e.g.
//   { "svn://svn": "http://svn/repos" }
// turns svn://svn/project into http://svn/repos/project. Prefixes match
// on whole path segments, longest first. The caller then checks the target's
// repository UUID against the working copy's, so a wrong mapping is caught.

export type UrlMapping =
  | { kind: "http"; url: string; mapped: boolean }
  | { kind: "needsMapping"; url: string }
  | { kind: "unsupported"; url: string; reason: string };

const strip = (u: string) => u.replace(/\/+$/, "");

export function mapRepoUrl(url: string, map: Record<string, string> | undefined): UrlMapping {
  const u = strip(url);
  const prefixes = Object.keys(map ?? {})
    .map((k) => ({ from: strip(k), to: strip((map ?? {})[k]) }))
    .filter((m) => m.from && m.to)
    .sort((a, b) => b.from.length - a.from.length);
  for (const m of prefixes) {
    const fromLc = m.from.toLowerCase();
    const uLc = u.toLowerCase();
    // Scheme and host are case-insensitive; compare the whole prefix that way (paths rarely differ only by case).
    if (uLc === fromLc || uLc.startsWith(fromLc + "/")) {
      if (!/^https?:\/\//i.test(m.to)) {
        return {
          kind: "unsupported",
          url: u,
          reason: `stitch.svn.urlMap maps ${m.from} to ${m.to}, which isn't an http(s) URL. History is read over http(s).`,
        };
      }
      return { kind: "http", url: m.to + u.slice(m.from.length), mapped: true };
    }
  }
  if (/^https?:\/\//i.test(u)) return { kind: "http", url: u, mapped: false };
  if (/^(svn|svn\+[\w-]+):\/\//i.test(u)) return { kind: "needsMapping", url: u };
  if (/^file:\/\//i.test(u)) {
    return { kind: "unsupported", url: u, reason: "History for file:// repositories isn't supported (Stitch reads history over http(s))." };
  }
  return { kind: "unsupported", url: u, reason: `Unsupported repository URL ${u}.` };
}
