import { expect, test } from './fixtures.js';

test.describe('slice 6 — chrome-devtools-mcp exposure', () => {
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
});
