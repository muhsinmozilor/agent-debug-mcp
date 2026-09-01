import { expect, parseResult, test } from './fixtures.js';

test.describe('page tools — errors, snapshot, explain', () => {
  test('page_snapshot outlines the demo with owning components; react_explain aggregates one component', async ({ context, mcp, waitForTabs }) => {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByTestId('app')).toBeVisible();
    await waitForTabs(1);

    const snap = parseResult(await mcp.callTool({ name: 'page_snapshot', arguments: {} }));
    expect(snap.isError, JSON.stringify(snap.data)).toBe(false);
    const tree = (snap.data.result as { tree: string }).tree;
    expect(tree).toContain('- heading "Agent Debug MCP demo" [level=1]');
    expect(tree).toMatch(/- button "count is 0" \{\[data-testid="increment"\]\} → Counter#\d+/);
    expect(tree).toContain('- link "Users" [href="/users?page=1"]');
    expect(tree).toMatch(/- main \{\[data-testid="app"\]\} → App#\d+/);

    const explain = parseResult(await mcp.callTool({ name: 'react_explain', arguments: { selector: '[data-testid="increment"]' } }));
    expect(explain.isError, JSON.stringify(explain.data)).toBe(false);
    const r = explain.data.result as { component: { name: string }; props: Record<string, unknown>; domNodes: { selector: string }[]; ancestors: { name: string }[]; source: unknown; ownerStack: unknown[] };
    expect(r.component.name).toBe('Counter');
    expect(r.props).toHaveProperty('count', 0);
    expect(r.domNodes[0]!.selector).toBe('[data-testid="increment"]');
    expect(r.ancestors.map((a) => a.name)).toContain('App');
    expect(r.source, 'source symbolicated through the Vite dev server').toBeTruthy();
  });

  test('page_get_errors collects console, uncaught, query and router errors; since= returns only new ones', async ({ context, mcp, waitForTabs, relay }) => {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByTestId('app')).toBeVisible();
    await waitForTabs(1);
    await expect.poll(() => relay.link.tabs.list()[0]?.capabilities ?? [], { timeout: 10_000 }).toEqual(expect.arrayContaining(['tanstack_query', 'tanstack_router']));

    const before = parseResult(await mcp.callTool({ name: 'page_get_errors', arguments: {} }));
    const since = (before.data.result as { latestSeq: number }).latestSeq;

    await page.evaluate(() => {
      console.error('demo failure', { code: 42 });
      setTimeout(() => {
        throw new Error('uncaught in timer');
      }, 0);
      void Promise.reject(new Error('rejected promise'));
      // A failing query through the exposed client (set by the Vite plugin).
      const qc = (window as unknown as { __TANSTACK_QUERY_CLIENT__: { fetchQuery: (o: unknown) => Promise<unknown> } }).__TANSTACK_QUERY_CLIENT__;
      void qc.fetchQuery({ queryKey: ['broken-e2e'], queryFn: async () => { throw new Error('backend down'); }, retry: 0 }).catch(() => undefined);
    });
    // Router: navigate to a route that does not exist → notFound error on the root match.
    await page.evaluate(() => (window as unknown as { __TANSTACK_ROUTER__: { navigate: (o: unknown) => Promise<unknown> } }).__TANSTACK_ROUTER__.navigate({ to: '/definitely-missing' }));

    await expect
      .poll(
        async () => {
          const res = parseResult(await mcp.callTool({ name: 'page_get_errors', arguments: { since } }));
          return (res.data.result as { errors: { kind: string }[] }).errors.map((e) => e.kind).sort();
        },
        { timeout: 10_000 },
      )
      .toEqual(expect.arrayContaining(['console.error', 'exception', 'unhandledrejection', 'query']));

    const res = parseResult(await mcp.callTool({ name: 'page_get_errors', arguments: { since } }));
    const errors = (res.data.result as { errors: { kind: string; message: string; data?: Record<string, unknown>; stack?: string }[]; latestSeq: number }).errors;
    expect(errors.find((e) => e.kind === 'console.error')).toMatchObject({ message: expect.stringContaining('demo failure') });
    expect(errors.find((e) => e.kind === 'exception')).toMatchObject({ message: 'uncaught in timer', stack: expect.stringContaining('uncaught in timer') }); // thrown from page.evaluate, so no dev-server filename
    expect(errors.find((e) => e.kind === 'unhandledrejection')!.message).toContain('rejected promise');
    expect(errors.find((e) => e.kind === 'query')).toMatchObject({ message: expect.stringContaining('backend down'), data: { queryHash: expect.stringContaining('broken-e2e') } });
    expect(errors.some((e) => e.kind === 'console.warn')).toBe(false);

    // Nothing new after the latest seq; warnings only on request.
    const latest = (res.data.result as { latestSeq: number }).latestSeq;
    const none = parseResult(await mcp.callTool({ name: 'page_get_errors', arguments: { since: latest } }));
    expect((none.data.result as { errors: unknown[] }).errors).toEqual([]);
  });
});
