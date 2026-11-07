// Logging without a vscode dependency: backends call log.*, and the extension
// routes it to the "Stitch" output channel (Output panel → Stitch).
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSink = (level: LogLevel, message: string) => void;

let sink: LogSink = () => undefined;

export function setLogSink(s: LogSink): void {
  sink = s;
}

export const log = {
  debug: (m: string) => sink("debug", m),
  info: (m: string) => sink("info", m),
  warn: (m: string) => sink("warn", m),
  error: (m: string) => sink("error", m),
};

/** "12 ms", "1.4 s" */
export function elapsed(start: number): string {
  const ms = Date.now() - start;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** "830 B", "4.2 KB", "1.3 MB" */
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
