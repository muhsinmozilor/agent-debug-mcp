import { chromium } from '@playwright/test';
import { expect, parseResult, test } from './fixtures.js';

/**
 * The relay's CDP endpoint lets Playwright (and `@playwright/mcp --cdp-endpoint`) drive the very tabs Agent Debug MCP
 * is attached to, over the extension's chrome.debugger sessions — no --remote-debugging-port, no second extension.
 * `chromium` here is a *second* Playwright client, independent from the one that launched the test browser.
 */
test.describe('CDP bridge — Playwright drives the attached tabs', () => {
  test('connectOverCDP sees the attached tab; screenshots and clicks flow through; Agent Debug MCP sees the result', async ({ context, relay, mcp, waitForTabs }) => {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByTestId('app')).toBeVisible();
    await waitForTabs(1);
    expect(relay.cdpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/cdp\/[0-9a-f]{48}$/);

    const browser = await chromium.connectOverCDP(relay.cdpUrl!);
    try {
      expect(browser.contexts()).toHaveLength(1);
      const pages = browser.contexts()[0]!.pages();
      const remote = pages.find((p) => p.url() === page.url());
      expect(remote, `pages: ${pages.map((p) => p.url()).join(', ')}`).toBeDefined();
      await expect.poll(() => fetch(`http://127.0.0.1:${relay.port}/health`).then((r) => r.json() as Promise<{ cdp: { clientConnected: boolean } }>)).toMatchObject({ cdp: { enabled: true, clientConnected: true } });

      // Screenshot — what tabs_screenshot used to do, now Playwright's job.
      const png = await remote!.screenshot();
      expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(png.readUInt32BE(16)).toBeGreaterThan(100);

      // Automation through Playwright…
      await remote!.getByTestId('increment').click();
      await remote!.getByTestId('increment').click();
      await expect(remote!.getByTestId('increment')).toHaveText('count is 2');
      await expect(page.getByTestId('increment')).toHaveText('count is 2'); // same tab, seen by the launching client

      // …and inspection / mutation through Agent Debug MCP on the same tab, visible to Playwright.
      const found = parseResult(await mcp.callTool({ name: 'react_find_by_dom', arguments: { selector: '[data-testid="increment"]' } }));
      expect(found.isError, JSON.stringify(found.data)).toBe(false);
      const app = parseResult(await mcp.callTool({ name: 'react_search_components', arguments: { nameRegex: '^App$' } }));
      const appId = (app.data.result as { matches: { id: number }[] }).matches[0]!.id;
      const set = parseResult(await mcp.callTool({ name: 'react_override_value', arguments: { elementId: appId, kind: 'hooks', path: [0], value: 7 } }));
      expect(set.isError, JSON.stringify(set.data)).toBe(false);
      await expect(remote!.getByTestId('increment')).toHaveText('count is 7');

      // Navigation through Playwright keeps the Agent Debug MCP attachment (new doc, same tab).
      await remote!.getByTestId('nav-users').click();
      await expect(remote!.getByTestId('users')).toBeVisible();
      const state = parseResult(await mcp.callTool({ name: 'tanstack_router_get_state', arguments: {} }));
      expect(JSON.stringify(state.data.result)).toContain('/users');
    } finally {
      await browser.close();
    }
    await expect.poll(() => fetch(`http://127.0.0.1:${relay.port}/health`).then((r) => r.json() as Promise<{ cdp: { clientConnected: boolean } }>)).toMatchObject({ cdp: { clientConnected: false } });
  });

  test('pages Playwright opens become Agent Debug MCP tabs, and closing them detaches', async ({ context, relay, mcp, waitForTabs }) => {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByTestId('app')).toBeVisible();
    await waitForTabs(1);

    const browser = await chromium.connectOverCDP(relay.cdpUrl!);
    try {
      const ctx = browser.contexts()[0]!;
      const opened = await ctx.newPage(); // Target.createTarget → chrome.tabs.create (about:blank)
      await opened.goto('http://localhost:5199/users'); // no baseURL on the CDP-connected browser
      await expect(opened.getByTestId('users')).toBeVisible();
      await waitForTabs(2);
      const list = parseResult(await mcp.callTool({ name: 'tabs_list', arguments: {} }));
      expect((list.data.tabs as { url: string }[]).map((t) => t.url)).toEqual(expect.arrayContaining([expect.stringContaining('/users')]));

      await opened.close(); // Target.closeTarget → chrome.tabs.remove
      await expect.poll(() => relay.link.tabs.list().length).toBe(1);
      expect(ctx.pages()).toHaveLength(1);
    } finally {
      await browser.close();
    }
  });

  test('a second CDP client replaces the first; a bad token is refused', async ({ context, relay, waitForTabs }) => {
    const page = await context.newPage();
    await page.goto('/');
    await waitForTabs(1);
    const first = await chromium.connectOverCDP(relay.cdpUrl!);
    const firstGone = new Promise<void>((r) => first.once('disconnected', () => r()));
    const second = await chromium.connectOverCDP(relay.cdpUrl!);
    await firstGone;
    expect(second.contexts()[0]!.pages().length).toBeGreaterThanOrEqual(1);
    await second.close();
    await expect(chromium.connectOverCDP(relay.cdpUrl!.replace(/[0-9a-f]{48}$/, 'f'.repeat(48)), { timeout: 5000 })).rejects.toThrow(/401|does not look like a DevTools server/);
  });
});
