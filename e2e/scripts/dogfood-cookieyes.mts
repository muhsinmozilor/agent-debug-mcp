/**
 * Dogfood against the CookieYes React app served by the workspace stack at http://localhost:7080.
 * Usage: pnpm exec tsx scripts/dogfood-cookieyes.mts [url]
 */
import { chromium } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRelay } from '../../packages/relay/src/index.js';

const url = process.argv[2] ?? 'http://localhost:7080/';
process.env.AGENT_DEBUG_MCP_HOME = mkdtempSync(join(tmpdir(), 'dtmcp-dogfood-'));
const relay = await startRelay({ port: 0, stdio: false, logLevel: 'warn' });
const EXT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../packages/extension/.output/chrome-mv3');
const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'dtmcp-dogfood-prof-')), {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const pair = await ctx.newPage();
await pair.goto(`http://127.0.0.1:${relay.port}/pair`);
for (let i = 0; i < 100 && !relay.link.connected; i++) await new Promise((r) => setTimeout(r, 100));
console.log('extension connected:', relay.link.connected);
await pair.close();

const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[page error]', e.message.slice(0, 200)));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
console.log('title:', await page.title(), 'url:', page.url());

const mcp = new Client({ name: 'dogfood', version: '0' });
await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${relay.port}/mcp`)));
const text = (r: unknown) => ((r as { content: { text?: string }[] }).content[0]?.text ?? '').replace(/^[^\n]*\n/, '');
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await mcp.callTool({ name, arguments: args });
  const t = text(r);
  return JSON.parse(t.startsWith('{') ? t : (r as { content: { text: string }[] }).content[0]!.text);
};

console.log('\n== tabs_list');
console.log(JSON.stringify(await call('tabs_list', {}), null, 1).slice(0, 800));
console.log('\n== react_get_renderers');
console.log(JSON.stringify((await call('react_get_renderers', {})).result, null, 1).slice(0, 900));
console.log('\n== react_get_tree (maxDepth 60, maxNodes 40)');
const tree = await call('react_get_tree', { maxDepth: 60, maxNodes: 40 });
console.log('total:', tree.result?.total, 'truncated:', tree.result?.truncated, tree.error ?? '');
console.log((tree.result?.items ?? []).map((n: { depth: number; name: string; kind: string }) => `${' '.repeat(n.depth)}${n.name} <${n.kind}>`).join('\n'));
console.log('\n== react_search_components nameRegex=Login|Form|Button');
const search = await call('react_search_components', { nameRegex: 'Login|Form|Button', limit: 8 });
console.log(JSON.stringify((search.result?.matches ?? []).map((m: { id: number; name: string; depth: number }) => `${m.id}:${m.name}@${m.depth}`)), search.error ?? '');
const first = search.result?.matches?.[0];
if (first) {
  console.log(`\n== react_inspect_element ${first.name}`);
  const ins = await call('react_inspect_element', { elementId: first.id });
  const r = ins.result ?? ins;
  console.log(JSON.stringify({ name: r.name, kind: r.kind, propsKeys: Object.keys(r.props ?? {}), hooks: (r.hooks ?? []).map((h: { name: string }) => h.name), owners: (r.owners ?? []).map((o: { name: string }) => o.name), source: r.source, hostNodes: (r.hostNodes ?? []).slice(0, 2) }, null, 1).slice(0, 1200));
  console.log(`\n== react_get_source ${first.name}`);
  const src = await call('react_get_source', { elementId: first.id });
  console.log(JSON.stringify(src.result?.source ?? src.error, null, 1));
}
console.log('\n== tanstack_query_list_queries (expected: CAPABILITY_UNAVAILABLE until the app opts in)');
console.log(JSON.stringify(await call('tanstack_query_list_queries', {}), null, 1).slice(0, 600));
console.log('\n== react_watch_renders 2s while typing into the first input');
const watching = call('react_watch_renders', { durationMs: 2000 });
await page.waitForTimeout(200);
const input = page.locator('input').first();
if (await input.count()) await input.fill('dogfood@example.com').catch(() => undefined);
const digest = await watching;
console.log(JSON.stringify({ commits: digest.result?.commits, causes: digest.result?.causes, mostRendered: (digest.result?.mostRendered ?? []).slice(0, 6).map((c: { name: string; renders: number; causes: Record<string, number> }) => `${c.name} x${c.renders} ${JSON.stringify(c.causes)}`) }, null, 1));

await mcp.close();
await ctx.close();
await relay.close();
process.exit(0);
