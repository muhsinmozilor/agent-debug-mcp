import { chromium } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures.js';

const EXT_PATH = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../packages/extension/.output/chrome-mv3');

test.describe('slice 6 — WebMCP + chrome-devtools-mcp exposure', () => {
  test('answers devtoolstooldiscovery with the page tools and executes them in-page', async ({ context, waitForTabs }) => {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByTestId('app')).toBeVisible();
    await waitForTabs(1);

    const result = await page.evaluate(async () => {
      type Group = { name: string; description: string; tools: { name: string; inputSchema: unknown; execute: (i: unknown) => Promise<unknown> }[] };
      const captured: { group: Group | null } = { group: null };
      const ev = new Event('devtoolstooldiscovery') as Event & { respondWith: (g: Group) => void };
      ev.respondWith = (g) => {
        captured.group = g;
      };
      window.dispatchEvent(ev);
      if (!captured.group) return { group: null };
      const g = captured.group;
      const tree = g.tools.find((t) => t.name === 'react_get_tree')!;
      const out = (await tree.execute({ maxNodes: 2, maxDepth: 40 })) as { items: { name: string }[]; total: number };
      const exposure = (window as unknown as { __DTMCP_EXPOSURE__?: unknown }).__DTMCP_EXPOSURE__;
      return { group: { name: g.name, tools: g.tools.map((t) => t.name), hasTab: 'tab' in ((tree.inputSchema as { properties: object }).properties ?? {}) }, out, exposure };
    });
    expect(result.group).not.toBeNull();
    expect(result.group!.name).toBe('Agent Debug MCP');
    expect(result.group!.tools).toEqual(expect.arrayContaining(['react_get_tree', 'react_inspect_element', 'tanstack_query_list_queries', 'tanstack_router_get_state']));
    expect(result.group!.hasTab).toBe(false); // page-scoped: no tab param
    expect(result.out!.items).toHaveLength(2);
    expect(result.out!.total).toBeGreaterThan(2);
    expect(result.exposure).toMatchObject({ thirdParty: true });
  });

  test('registers tools into document.modelContext when Chrome has WebMCP enabled', async ({ relay }) => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'dtmcp-webmcp-'));
    const ctx = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--enable-features=WebMCP'],
    });
    try {
      const probe = await ctx.newPage();
      await probe.goto('/');
      const supported = await probe.evaluate(() => typeof (document as unknown as { modelContext?: unknown }).modelContext === 'object');
      test.skip(!supported, 'This Chromium build does not expose document.modelContext even with --enable-features=WebMCP');
      await expect(probe.getByTestId('app')).toBeVisible();
      const listed = await probe.evaluate(async () => {
        const mc = (document as unknown as { modelContext: { getTools: () => Promise<{ name: string }[]>; executeTool: (t: unknown, i: unknown) => Promise<unknown> } }).modelContext;
        for (let i = 0; i < 40; i++) {
          const tools = await mc.getTools();
          if (tools.some((t) => t.name === 'react_get_tree')) {
            const tool = tools.find((t) => t.name === 'react_get_tree')!;
            let out: unknown;
            try {
              out = await mc.executeTool(tool, { maxNodes: 1, maxDepth: 40 });
            } catch (e) {
              out = { error: String(e) };
            }
            return { names: tools.map((t) => t.name), out };
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        return { names: (await mc.getTools()).map((t) => t.name), out: null };
      });
      expect(listed.names).toEqual(expect.arrayContaining(['react_get_tree', 'react_inspect_element']));
      expect(listed.out).toBeTruthy();
      void relay;
    } finally {
      await ctx.close();
    }
  });
});
