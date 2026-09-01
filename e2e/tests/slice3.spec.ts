import { expect, parseResult, test } from './fixtures.js';

test.describe('slice 3 — TanStack Query read', () => {
  test('capability appears, queries list/paginate, big data is summarised and expandable', async ({ context, mcp, waitForTabs, relay }) => {
    const page = await context.newPage();
    await page.goto('/users?page=1');
    await expect(page.getByTestId('users')).toBeVisible();
    await waitForTabs(1);
    await expect.poll(() => relay.link.tabs.list()[0]?.capabilities ?? [], { timeout: 10_000 }).toContain('tanstack_query');

    const tabs = parseResult(await mcp.callTool({ name: 'tabs_list', arguments: {} }));
    expect((tabs.data.tabs as { capabilities: string[] }[])[0]!.capabilities).toEqual(expect.arrayContaining(['react', 'tanstack_query']));

    // Seed many queries (60) and one 3 MB payload straight into the app's client.
    await page.evaluate(() => {
      const qc = (window as unknown as { __TANSTACK_QUERY_CLIENT__: { setQueryData: (k: unknown, d: unknown) => void } }).__TANSTACK_QUERY_CLIENT__;
      for (let i = 0; i < 60; i++) qc.setQueryData(['seed', i], { i, tags: ['a', 'b'] });
      qc.setQueryData(['huge'], { blob: 'x'.repeat(3 * 1024 * 1024), rows: Array.from({ length: 1000 }, (_, i) => ({ i, name: `row-${i}` })) });
    });

    const p1 = parseResult(await mcp.callTool({ name: 'tanstack_query_list_queries', arguments: { queryKeyPrefix: ['seed'], limit: 50 } }));
    expect(p1.isError).toBe(false);
    const page1 = p1.data.result as { items: { queryKey: unknown[]; status: string }[]; total: number; nextCursor?: string; truncated: boolean };
    expect(page1.total).toBe(60);
    expect(page1.items).toHaveLength(50);
    expect(page1.truncated).toBe(true);
    const p2 = parseResult(await mcp.callTool({ name: 'tanstack_query_list_queries', arguments: { queryKeyPrefix: ['seed'], limit: 50, cursor: page1.nextCursor } }));
    expect((p2.data.result as { items: unknown[]; truncated: boolean }).items).toHaveLength(10);

    const users = parseResult(await mcp.callTool({ name: 'tanstack_query_list_queries', arguments: { queryKeyPrefix: ['users'] } }));
    const u = (users.data.result as { items: { queryKey: unknown; status: string; observers: number; dataPreview: string }[] }).items[0]!;
    expect(u.queryKey).toEqual(['users', { page: 1 }]);
    expect(u.status).toBe('success');
    expect(u.observers).toBeGreaterThan(0);

    const huge = parseResult(await mcp.callTool({ name: 'tanstack_query_get_query', arguments: { queryKey: ['huge'] } }));
    expect(huge.isError).toBe(false);
    const h = huge.data.result as { data: { blob: { $: string; length: number }; rows: unknown } };
    expect(h.data.blob).toMatchObject({ $: 'string', length: 3 * 1024 * 1024 });
    // full JSON text of the response must stay far below the 2 MB cap
    expect(JSON.stringify(huge.data).length).toBeLessThan(200_000);

    const ex = parseResult(await mcp.callTool({ name: 'tanstack_query_get_query', arguments: { queryKey: ['huge'], expand: [['data', 'rows', 999]] } }));
    expect((ex.data.result as { expanded: { value: unknown }[] }).expanded[0]!.value).toEqual({ i: 999, name: 'row-999' });
  });

  test('a tab whose app has not exposed the client reports CAPABILITY_UNAVAILABLE with the opt-in hint', async ({ context, mcp, waitForTabs, relay }) => {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${relay.port}/health`);
    await waitForTabs(1);
    const res = parseResult(await mcp.callTool({ name: 'tanstack_query_list_queries', arguments: {} }));
    expect(res.isError).toBe(true);
    const err = res.data.error as { code: string; hint: string };
    expect(err.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(err.hint).toContain('__TANSTACK_QUERY_CLIENT__');
  });
});
