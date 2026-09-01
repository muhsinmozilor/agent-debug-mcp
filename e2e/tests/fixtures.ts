import { chromium, test as base, type BrowserContext } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startRelay, type RunningRelay } from '../../packages/relay/src/index.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_PATH = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../packages/extension/.output/chrome-mv3');

export interface Fixtures {
  /** Per-spec overrides for the persistent context (`test.use({ extContextOptions: {...} })`). */
  extContextOptions: { viewport?: { width: number; height: number } | null; args?: string[] };
  relay: RunningRelay;
  context: BrowserContext;
  mcp: Client;
  /** Wait until the extension has attached at least `n` tabs to the relay. */
  waitForTabs: (n?: number, timeoutMs?: number) => Promise<void>;
}

export const test = base.extend<Fixtures>({
  extContextOptions: [{}, { option: true }],
  // eslint-disable-next-line no-empty-pattern
  relay: async ({}, use) => {
    process.env.AGENT_DEBUG_MCP_HOME = mkdtempSync(join(tmpdir(), 'dtmcp-e2e-'));
    const relay = await startRelay({ port: 0, stdio: false, logLevel: 'warn', heartbeatMs: 2000 });
    await use(relay);
    await relay.close();
  },
  context: async ({ relay, extContextOptions }, use) => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'dtmcp-profile-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      ...(extContextOptions.viewport !== undefined ? { viewport: extContextOptions.viewport } : {}),
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, ...(extContextOptions.args ?? [])],
    });
    // Pair: visiting the relay's /pair page auto-pairs an unpaired extension.
    try {
      const pairPage = await context.newPage();
      await pairPage.goto(`http://127.0.0.1:${relay.port}/pair`);
      await expectConnected(relay, 15_000);
      await pairPage.close();
    } catch (e) {
      await context.close();
      throw e;
    }
    await use(context);
    await context.close();
  },
  mcp: async ({ relay }, use) => {
    const client = new Client({ name: 'e2e', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${relay.port}/mcp`)));
    await use(client);
    await client.close();
  },
  waitForTabs: async ({ relay }, use) => {
    await use(async (n = 1, timeoutMs = 15_000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (relay.link.tabs.list().filter((t) => t.tools.size > 0).length >= n) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`timed out waiting for ${n} attached tab(s); have ${JSON.stringify(relay.link.tabs.summaries())}`);
    });
  },
});

async function expectConnected(relay: RunningRelay, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (relay.link.connected) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('extension did not connect to the relay (pairing failed)');
}

export { expect } from '@playwright/test';

export function parseResult(raw: unknown): {
  isError: boolean;
  data: Record<string, unknown>;
} {
  const res = raw as { content?: unknown; isError?: boolean; structuredContent?: unknown };
  if (res.structuredContent) return { isError: !!res.isError, data: res.structuredContent as Record<string, unknown> };
  const text = ((res.content ?? []) as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text ?? '{}';
  const jsonStart = text.indexOf('{');
  return { isError: !!res.isError, data: JSON.parse(text.slice(jsonStart)) as Record<string, unknown> };
}
