// Display helpers for history rows. Pure functions.

const UNITS: [number, string][] = [
  [60, "s"],
  [60, "min"],
  [24, "h"],
  [7, "d"],
  [4.35, "w"],
  [12, "mo"],
  [Number.POSITIVE_INFINITY, "y"],
];

/** "5 min ago", "3 d ago", "2 y ago". */
export function relativeTime(date: Date, now: Date = new Date()): string {
  let value = Math.max(0, (now.getTime() - date.getTime()) / 1000);
  for (const [size, unit] of UNITS) {
    if (value < size) {
      return unit === "s" ? "just now" : `${Math.floor(value)} ${unit} ago`;
    }
    value /= size;
  }
  return date.toISOString().slice(0, 10);
}

/** Decorations worth showing on a row: drop "HEAD -> ", keep branch and tag names. */
export function shortRefs(refs: string[]): string[] {
  return refs.map((r) => r.replace(/^HEAD -> /, "")).filter((r) => r && r !== "HEAD");
}
