import { DEFAULTS } from '../packages/protocol/src/index.js';

/**
 * The freshly-launched test extension auto-discovers a relay on the default port (127.0.0.1:9333) and pairs with
 * it before the fixture's /pair visit can win — the per-test relay then lands in `pendingPair` (accepting a
 * *different* relay needs the user's OK in the popup) and every test dies with "pairing failed". Refuse to start
 * while a real relay is listening there instead of failing 26 times opaquely.
 */
export default async function globalSetup(): Promise<void> {
  const base = `http://127.0.0.1:${DEFAULTS.relayPort}`;
  let info: { name?: unknown } | null = null;
  try {
    const res = await fetch(`${base}/pair.json`, { signal: AbortSignal.timeout(750) });
    if (res.ok) info = (await res.json()) as { name?: unknown };
  } catch {
    /* nothing listening on the default port — good */
  }
  if (info?.name === 'agent-debug-mcp') {
    throw new Error(
      `An agent-debug-mcp relay is running on ${base} — the test extension would auto-pair with it instead of the per-test relay, failing every test. ` +
        `Stop it first (npx agent-debug-mcp stop — stdio MCP sessions run the relay as a shared detached daemon; otherwise find it with: lsof -nP -iTCP:${DEFAULTS.relayPort} -sTCP:LISTEN), then re-run pnpm test:e2e.`,
    );
  }
}
