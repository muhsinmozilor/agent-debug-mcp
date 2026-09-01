export type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let current: Level = 'info';
export function setLogLevel(l: Level): void {
  current = l;
}
/** Logs go to stderr so stdout stays clean for the stdio MCP transport. */
export function log(level: Level, msg: string, extra?: unknown): void {
  if (order[level] < order[current]) return;
  const line = `[agent-debug-mcp] ${new Date().toISOString()} ${level.toUpperCase()} ${msg}`;
  process.stderr.write(extra === undefined ? `${line}\n` : `${line} ${safe(extra)}\n`);
}
function safe(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}
