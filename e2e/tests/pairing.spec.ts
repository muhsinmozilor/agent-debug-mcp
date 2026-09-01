import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext } from '@playwright/test';
import { DEFAULTS } from '../../packages/protocol/src/index.js';
import { startRelay, type RunningRelay } from '../../packages/relay/src/index.js';
import { expect, test } from './fixtures.js';

/**
 * Pairing without the /pair page: the service worker discovers the relay itself (GET <base>/pair.json).
 * These tests launch their own Chromium + relays instead of using the fixtures, because the fixture context is
 * pre-paired via /pair and the fixture relay must stay alive for its teardown.
 */
const EXT_PATH = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../packages/extension/.output/chrome-mv3');

const freshHome = (): void => {
  process.env.AGENT_DEBUG_MCP_HOME = mkdtempSync(join(tmpdir(), 'dtmcp-pairing-'));
};
const launch = (): Promise<BrowserContext> =>
  chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'dtmcp-profile-')), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
async function waitConnected(relay: RunningRelay, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (relay.link.connected) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
async function pairVia(context: BrowserContext, url: string, relay: RunningRelay): Promise<void> {
  const page = await context.newPage();
  await page.goto(url);
  expect(await waitConnected(relay, 15_000), `extension did not pair via ${url}`).toBe(true);
  await page.close();
}
// `chrome` exists inside the extension service worker where sw.evaluate() runs; e2e compiles with types:["node"] only.
declare const chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
async function readSettings(context: BrowserContext): Promise<{ relayUrl: string | null; token: string | null; pendingPair: unknown }> {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return sw.evaluate(async () => {
    const raw = (await chrome.storage.local.get('settings')) as { settings?: { relayUrl: string | null; token: string | null; pendingPair: unknown } };
    return { relayUrl: raw.settings?.relayUrl ?? null, token: raw.settings?.token ?? null, pendingPair: raw.settings?.pendingPair ?? null };
  });
}
const portFree = async (port: number): Promise<boolean> =>
  fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })
    .then(() => false)
    .catch(() => true);

test.describe('pairing', () => {
  test('a fresh extension discovers a relay on the default port with no /pair visit', async () => {
    test.skip(!(await portFree(DEFAULTS.relayPort)), `port ${DEFAULTS.relayPort} is busy (a relay is already running)`);
    freshHome();
    const relay = await startRelay({ port: DEFAULTS.relayPort, stdio: false, logLevel: 'warn' });
    const context = await launch();
    try {
      expect(await waitConnected(relay, 15_000), 'extension did not discover the relay on 127.0.0.1:9333').toBe(true);
      expect(await readSettings(context)).toMatchObject({ relayUrl: `ws://127.0.0.1:${DEFAULTS.relayPort}/ws`, token: relay.config.token, pendingPair: null });
      expect(relay.config.extensionIds).toHaveLength(1);
    } finally {
      await context.close();
      await relay.close();
    }
  });

  test('a regenerated relay token is picked up automatically (UNAUTHORIZED → re-discover)', async () => {
    freshHome();
    const relayA = await startRelay({ port: 0, stdio: false, logLevel: 'warn' });
    const port = relayA.port;
    const context = await launch();
    let relayB: RunningRelay | null = null;
    try {
      await pairVia(context, `http://127.0.0.1:${port}/pair`, relayA);
      await relayA.close();
      freshHome(); // new relay.json ⇒ new token, no pinned ids
      relayB = await startRelay({ port, stdio: false, logLevel: 'warn' });
      expect(relayB.config.token).not.toBe(relayA.config.token);
      expect(await waitConnected(relayB, 20_000), 'extension did not re-pair after the token changed').toBe(true);
      expect(await readSettings(context)).toMatchObject({ relayUrl: `ws://127.0.0.1:${port}/ws`, token: relayB.config.token, pendingPair: null });
    } finally {
      await context.close();
      await relayB?.close();
    }
  });

  test('the same relay reached via localhost does not ask the user to accept a new pairing', async () => {
    freshHome();
    const relay = await startRelay({ port: 0, stdio: false, logLevel: 'warn' });
    const context = await launch();
    try {
      await pairVia(context, `http://127.0.0.1:${relay.port}/pair`, relay);
      const page = await context.newPage();
      await page.goto(`http://localhost:${relay.port}/pair`);
      await page.waitForTimeout(1500);
      await page.close();
      expect(relay.link.connected).toBe(true);
      expect((await readSettings(context)).pendingPair).toBeNull();
    } finally {
      await context.close();
      await relay.close();
    }
  });
});
