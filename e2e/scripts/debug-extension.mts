import { chromium } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRelay } from '../../packages/relay/src/index.js';

process.env.AGENT_DEBUG_MCP_HOME = mkdtempSync(join(tmpdir(), 'dtmcp-dbg-'));
const relay = await startRelay({ port: 0, stdio: false, logLevel: 'debug', heartbeatMs: 2000 });
const EXT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../packages/extension/.output/chrome-mv3');
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'dtmcp-prof-')), {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const logSw = (w: import('@playwright/test').Worker) => {
  console.log('[SW] started', w.url());
  w.on('console', (m) => console.log('[SW console]', m.type(), m.text()));
  w.on('pageerror' as never, (e: unknown) => console.log('[SW error]', e));
};
ctx.serviceWorkers().forEach(logSw);
ctx.on('serviceworker', logSw);
await new Promise((r) => setTimeout(r, 1500));
console.log('service workers:', ctx.serviceWorkers().map((w) => w.url()));
const page = await ctx.newPage();
page.on('console', (m) => console.log('[page console]', m.type(), m.text()));
page.on('pageerror', (e) => console.log('[page error]', e.message));
await page.goto(`http://127.0.0.1:${relay.port}/pair`);
await new Promise((r) => setTimeout(r, 4000));
console.log('connected?', relay.link.connected);
// Inspect extension state through the SW
const sw = ctx.serviceWorkers()[0];
if (sw) {
  const state = await sw
    .evaluate(async () => {
      const c = (globalThis as unknown as { chrome: { storage: { local: { get: (k: null) => Promise<unknown> } }; runtime: { getManifest: () => { version: string } } } }).chrome;
      return { storage: await c.storage.local.get(null), manifest: c.runtime.getManifest().version };
    })
    .catch((e: unknown) => `evaluate failed: ${String(e)}`);
  console.log('SW state:', JSON.stringify(state));
}
const regs = await page.evaluate(() => ({
  main: (window as unknown as { __DTMCP_MAIN__?: boolean }).__DTMCP_MAIN__ ?? null,
  metas: Array.from(document.querySelectorAll('meta')).map((m) => m.getAttribute('name')),
}));
console.log('page:', JSON.stringify(regs));
await ctx.close();
await relay.close();
process.exit(0);
