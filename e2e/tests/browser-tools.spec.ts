import { chromium } from '@playwright/test';
import { expect, parseResult, test } from './fixtures.js';

/**
 * Embedded Playwright MCP: browser automation (page_*) served by the SAME agent-debug MCP server, driving the
 * attached tabs over the relay's own CDP endpoint. The embedded client connects lazily on the first page_* call
 * and recovers after an external CDP client takes the (single) client slot.
 */
test.describe('embedded browser tools (page_*)', () => {
  test('page_* tools are listed once, drive the tab, and screenshots pass through', async ({ context, relay, mcp, waitForTabs }) => {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByTestId('app')).toBeVisible();
    await waitForTabs(1);

    const tools = (await mcp.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['page_navigate', 'page_click', 'page_take_screenshot', 'page_tabs', 'react_get_tree']));
    expect(tools.filter((n) => n === 'page_snapshot')).toHaveLength(1); // the relay's own, Playwright's colliding one is skipped
    expect(tools.some((n) => n.startsWith('browser_'))).toBe(false); // everything is renamed

    const health = await fetch(`http://127.0.0.1:${relay.port}/health`).then((r) => r.json() as Promise<{ browserTools: { enabled: boolean; tools: number } }>);
    expect(health.browserTools.enabled).toBe(true);
    expect(health.browserTools.tools).toBeGreaterThan(10);

    // The first page_* call lazily connects the embedded client to the relay's own CDP endpoint.
    const nav = await mcp.callTool({ name: 'page_navigate', arguments: { url: 'http://localhost:5199/' } });
    const navText = ((nav.content ?? []) as { type: string; text?: string }[]).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    expect(nav.isError, navText).toBeFalsy();
    expect(navText).toContain('untrusted'); // results are labelled untrusted page data
    await expect.poll(() => fetch(`http://127.0.0.1:${relay.port}/health`).then((r) => r.json() as Promise<{ cdp: { clientConnected: boolean } }>)).toMatchObject({ cdp: { enabled: true, clientConnected: true } });

    // Click via a CSS selector target (page_snapshot selectors work as targets), verify via the launching client and react_*.
    for (let i = 0; i < 2; i++) {
      const click = await mcp.callTool({ name: 'page_click', arguments: { element: 'increment button', target: '[data-testid="increment"]' } });
      expect(click.isError, JSON.stringify(click.content).slice(0, 500)).toBeFalsy();
    }
    await expect(page.getByTestId('increment')).toHaveText('count is 2');
    const app = parseResult(await mcp.callTool({ name: 'react_search_components', arguments: { nameRegex: '^App$' } }));
    expect(app.isError, JSON.stringify(app.data)).toBe(false);

    // Screenshots arrive as image content blocks through the stateless HTTP proxy (imageResponses: allow).
    const shot = await mcp.callTool({ name: 'page_take_screenshot', arguments: {} });
    expect(shot.isError, JSON.stringify(shot.content).slice(0, 500)).toBeFalsy();
    const img = ((shot.content ?? []) as { type: string; data?: string }[]).find((c) => c.type === 'image');
    expect(img?.data?.length ?? 0).toBeGreaterThan(1000);
  });

  test('an external CDP client evicts the embedded one; the next page_* call reconnects', async ({ context, relay, mcp, waitForTabs }) => {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByTestId('app')).toBeVisible();
    await waitForTabs(1);

    const first = await mcp.callTool({ name: 'page_tabs', arguments: { action: 'list' } });
    expect(first.isError, JSON.stringify(first.content).slice(0, 500)).toBeFalsy();

    // An external client takes the single CDP slot (the embedded client is dropped with code 4000)…
    const external = await chromium.connectOverCDP(relay.cdpUrl!);
    expect(external.contexts()[0]!.pages().length).toBeGreaterThanOrEqual(1);
    await external.close();

    // …and the built-in tools recover: Playwright MCP recreates its backend (and CDP connection) on the next call.
    await expect
      .poll(
        async () => {
          const again = await mcp.callTool({ name: 'page_tabs', arguments: { action: 'list' } });
          return again.isError ? JSON.stringify(again.content).slice(0, 300) : 'ok';
        },
        { timeout: 20_000 },
      )
      .toBe('ok');
  });
});
