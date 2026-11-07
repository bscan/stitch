// Author "bubbles" for history rows: a colored circle with the author's first
// initial. The color is picked from a fixed palette by a hash of the author's
// name, so the same person always gets the same color (in git and svn alike).
// Rendered as an inline SVG data URI: nothing is written to disk.

/** Colors with at least 4.9:1 contrast against white text (WCAG AA), on light and dark themes. */
export const PALETTE = [
  "#c62f24", // red
  "#b4500c", // orange
  "#8f6a00", // amber
  "#3f7f1c", // green
  "#14786a", // teal
  "#1a6fa3", // blue
  "#3d55c4", // indigo
  "#6c3fc0", // violet
  "#963a88", // magenta
  "#b02a5b", // rose
  "#56636e", // slate
  "#7a5530", // brown
];

/** FNV-1a: a small, stable string hash. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function authorColor(author: string): string {
  return PALETTE[hash(author.trim().toLowerCase()) % PALETTE.length];
}

/** The first letter or digit of the name, upper-cased ("?" when there is none). */
export function authorInitial(author: string): string {
  const m = /[\p{L}\p{N}]/u.exec(author);
  return m ? m[0].toLocaleUpperCase() : "?";
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function avatarSvg(author: string): string {
  const unknown = !author || author === "(no author)";
  const color = unknown ? PALETTE[PALETTE.length - 2] : authorColor(author);
  const initial = unknown ? "?" : authorInitial(author);
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
    // The tree's icon slot is 16×16 px, so the circle fills it and the letter is as large as fits.
    `<circle cx="8" cy="8" r="8" fill="${color}"/>` +
    '<text x="8" y="8" dy="0.35em" text-anchor="middle" fill="#fff" ' +
    'font-family="-apple-system, BlinkMacSystemFont, \'Segoe UI\', Ubuntu, sans-serif" ' +
    `font-size="11" font-weight="700">${xmlEscape(initial)}</text>` +
    "</svg>"
  );
}

const cache = new Map<string, string>();

/** `data:` URI of the author's bubble (cached per author). */
export function avatarDataUri(author: string): string {
  let uri = cache.get(author);
  if (!uri) {
    uri = "data:image/svg+xml;base64," + Buffer.from(avatarSvg(author), "utf8").toString("base64");
    cache.set(author, uri);
  }
  return uri;
}
