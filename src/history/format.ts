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

/** An hour: below this, a fetch counts as recent whatever the autofetch settings. */
export const STALE_FETCH_MIN_MS = 60 * 60 * 1000;

/**
 * How long since a fetch before the view title mentions it: an hour, or twice
 * VS Code's autofetch period when autofetch is on with a longer period (so the
 * note doesn't flash up between autofetches).
 */
export function staleFetchMs(autofetch: unknown, autofetchPeriodSec: unknown): number {
  const on = autofetch === true || autofetch === "all";
  const period = typeof autofetchPeriodSec === "number" && autofetchPeriodSec > 0 ? autofetchPeriodSec * 1000 : 0;
  return Math.max(STALE_FETCH_MIN_MS, on ? 2 * period : 0);
}

/**
 * The view-title note about fetch age: "never fetched", "fetched 3 d ago", or
 * undefined when the last fetch is recent (as it always is while autofetch runs).
 */
export function fetchNote(lastFetch: Date | undefined, staleMs: number, now: Date = new Date()): string | undefined {
  if (!lastFetch) return "never fetched";
  return now.getTime() - lastFetch.getTime() < staleMs ? undefined : `fetched ${relativeTime(lastFetch, now)}`;
}

/** Decorations worth showing on a row: drop "HEAD -> ", keep branch and tag names. */
export function shortRefs(refs: string[]): string[] {
  return refs.map((r) => r.replace(/^HEAD -> /, "")).filter((r) => r && r !== "HEAD");
}
