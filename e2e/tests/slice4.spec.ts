import { expect, parseResult, test } from './fixtures.js';

test.describe('slice 4 — mutation + router', () => {
  test('override a prop, set query data with a tagged Date, navigate the router', async ({ context, mcp, waitForTabs, relay }) => {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByTestId('app')).toBeVisible();
    await waitForTabs(1);
    await expect.poll(() => relay.link.tabs.list()[0]?.capabilities ?? [], { timeout: 10_000 }).toEqual(expect.arrayContaining(['react', 'tanstack_query', 'tanstack_router']));

    // react_override_value on Counter's `count` prop → DOM updates
    const found = parseResult(await mcp.callTool({ name: 'react_find_by_dom', arguments: { selector: '[data-testid="increment"]' } }));
    const counterId = (found.data.result as { matches: { component: { id: number } }[] }).matches[0]!.component.id;
    const ov = parseResult(await mcp.callTool({ name: 'react_override_value', arguments: { elementId: counterId, kind: 'props', path: ['count'], value: 41 } }));
    expect(ov.isError, JSON.stringify(ov.data)).toBe(false);
    await expect(page.getByTestId('increment')).toHaveText('count is 41');

    // hooks: App's useState(count) is hook #0 → set to 7, Counter re-renders from real state
    const app = parseResult(await mcp.callTool({ name: 'react_search_components', arguments: { nameRegex: '^App$' } }));
    const appId = (app.data.result as { matches: { id: number }[] }).matches[0]!.id;
    const hk = parseResult(await mcp.callTool({ name: 'react_override_value', arguments: { elementId: appId, kind: 'hooks', path: [0], value: 7 } }));
    expect(hk.isError, JSON.stringify(hk.data)).toBe(false);
    await expect(page.getByTestId('increment')).toHaveText('count is 7');
    const notEditable = parseResult(await mcp.callTool({ name: 'react_override_value', arguments: { elementId: appId, kind: 'hooks', path: [2], value: 1 } }));
    expect((notEditable.data.error as { code: string }).code).toBe('INVALID_INPUT');

    // force re-render is accepted
    const fr = parseResult(await mcp.callTool({ name: 'react_force_rerender', arguments: { elementId: appId } }));
    expect(fr.isError).toBe(false);

    // tanstack query: set_data with a tagged Date round-trips into the live cache
    await page.getByTestId('nav-users').click();
    await expect(page.getByTestId('users')).toBeVisible();
    await expect(page.getByTestId('user-100')).toBeVisible(); // wait for the fetch to settle, otherwise it overwrites our data
    const set = parseResult(
      await mcp.callTool({ name: 'tanstack_query_set_data', arguments: { queryKey: ['users', { page: 1 }], data: [{ id: 999, name: 'injected', at: { $: 'date', iso: '2026-02-03T00:00:00.000Z' } }] } }),
    );
    expect(set.isError, JSON.stringify(set.data)).toBe(false);
    await expect(page.getByTestId('user-999')).toBeVisible();
    const isDate = await page.evaluate(() => {
      const qc = (window as unknown as { __TANSTACK_QUERY_CLIENT__: { getQueryData: (k: unknown) => { at: unknown }[] } }).__TANSTACK_QUERY_CLIENT__;
      return qc.getQueryData(['users', { page: 1 }])[0]!.at instanceof Date;
    });
    expect(isDate).toBe(true);
    const inv = parseResult(await mcp.callTool({ name: 'tanstack_query_invalidate', arguments: { queryKey: ['users'] } }));
    expect((inv.data.result as { invalidated: number }).invalidated).toBeGreaterThanOrEqual(1);

    // router
    const state = parseResult(await mcp.callTool({ name: 'tanstack_router_get_state', arguments: {} }));
    expect((state.data.result as { location: { pathname: string } }).location.pathname).toBe('/users');
    const routes = parseResult(await mcp.callTool({ name: 'tanstack_router_list_routes', arguments: {} }));
    expect((routes.data.result as { items: { routeId: string }[] }).items.map((r) => r.routeId)).toEqual(expect.arrayContaining(['__root__', '/', '/users']));
    const nav = parseResult(await mcp.callTool({ name: 'tanstack_router_navigate', arguments: { to: '/users', search: { page: 2 }, waitMs: 5000 } }));
    expect(nav.isError, JSON.stringify(nav.data)).toBe(false);
    expect((nav.data.result as { settled: boolean; location: { search: { page: number } } }).location.search.page).toBe(2);
    await expect(page.getByTestId('users')).toContainText('page 2');
    await expect(page).toHaveURL(/page=2/);
    const match = parseResult(await mcp.callTool({ name: 'tanstack_router_get_match', arguments: { routeId: '/users' } }));
    expect((match.data.result as { search: { page: number } }).search.page).toBe(2);
    const rinv = parseResult(await mcp.callTool({ name: 'tanstack_router_invalidate', arguments: {} }));
    expect(rinv.isError).toBe(false);
  });

  test('mutation toggle off → MUTATIONS_DISABLED, enforced in the extension', async ({ context, mcp, waitForTabs }) => {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByTestId('app')).toBeVisible();
    await waitForTabs(1);
    const sw = context.serviceWorkers()[0]!;
    await sw.evaluate(async () => {
      const c = (globalThis as unknown as { chrome: { storage: { local: { get: (k: string) => Promise<{ settings?: Record<string, unknown> }>; set: (v: unknown) => Promise<void> } } } }).chrome;
      const { settings } = await c.storage.local.get('settings');
      await c.storage.local.set({ settings: { ...(settings ?? {}), mutationDeniedOrigins: ['http://localhost:5199'] } });
    });
    await page.waitForTimeout(300);
    const found = parseResult(await mcp.callTool({ name: 'react_find_by_dom', arguments: { selector: '[data-testid="increment"]' } }));
    const counterId = (found.data.result as { matches: { component: { id: number } }[] }).matches[0]!.component.id;
    const denied = parseResult(await mcp.callTool({ name: 'react_override_value', arguments: { elementId: counterId, kind: 'props', path: ['count'], value: 5 } }));
    expect(denied.isError).toBe(true);
    expect((denied.data.error as { code: string }).code).toBe('MUTATIONS_DISABLED');
    await expect(page.getByTestId('increment')).toHaveText('count is 0');
    // read tools still work
    const tree = parseResult(await mcp.callTool({ name: 'react_get_tree', arguments: { maxNodes: 1 } }));
    expect(tree.isError).toBe(false);
    // tabs_list reflects the gate
    const tabs = parseResult(await mcp.callTool({ name: 'tabs_list', arguments: {} }));
    expect((tabs.data.tabs as { mutationsAllowed: boolean }[])[0]!.mutationsAllowed).toBe(false);
  });
});
