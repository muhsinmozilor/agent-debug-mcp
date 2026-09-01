import { expect, parseResult, test } from './fixtures.js';

test.describe('slice 2 — inspect + page tools', () => {
  test('inspect a component, expand a path, map DOM ↔ component, highlight and resolve source', async ({ context, mcp, waitForTabs }) => {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByTestId('app')).toBeVisible();
    await waitForTabs(1);

    const names = (await mcp.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      expect.arrayContaining([
        'page_element_at_point',
        'page_highlight',
        'page_pick_element',
        'react_find_by_dom',
        'react_get_dom_nodes',
        'react_get_renderers',
        'react_get_source',
        'react_get_tree',
        'react_inspect_element',
        'react_search_components',
        'tabs_list',
        'tabs_open',
      ]),
    );

    // search
    const search = parseResult(await mcp.callTool({ name: 'react_search_components', arguments: { nameRegex: '^App$' } }));
    expect(search.isError).toBe(false);
    const app = (search.data.result as { matches: { id: number; name: string }[] }).matches[0]!;
    expect(app.name).toBe('App');

    // inspect with Map / Date / function props on the memo list, plus hooks on App
    const ins = parseResult(await mcp.callTool({ name: 'react_inspect_element', arguments: { elementId: app.id } }));
    expect(ins.isError).toBe(false);
    const inspected = ins.data.result as { hooks: { name: string; value: unknown }[]; context: unknown[]; hostNodes: { tag: string }[] };
    expect(inspected.hooks.map((h) => h.name)).toEqual(['State', 'Reducer', 'Ref', 'Memo']);
    expect(inspected.hooks[0]!.value).toBe(0);
    expect(inspected.hostNodes[0]!.tag).toBe('main');
    const memo = inspected.hooks[3]!.value as { items: unknown[]; map: unknown; when: unknown };
    expect(memo.map).toMatchObject({ $: 'map', size: 1 });
    expect(memo.when).toEqual({ $: 'date', iso: '1970-01-01T00:00:00.000Z' });
    expect(memo.items).toHaveLength(30);
    expect(memo.items[0]).toMatchObject({ $: 'object', path: ['items', 0], preview: expect.stringContaining('item-0') }); // items collapsed at depth 2

    // expand into the collapsed array
    const ex = parseResult(await mcp.callTool({ name: 'react_inspect_element', arguments: { elementId: app.id, expand: [['hooks', 3, 'items', 29]] } }));
    expect((ex.data.result as { expanded: { value: unknown }[] }).expanded[0]!.value).toEqual({ id: 29, label: 'item-29' });

    // DOM → component
    const found = parseResult(await mcp.callTool({ name: 'react_find_by_dom', arguments: { selector: '[data-testid="increment"]' } }));
    const match = (found.data.result as { matches: { component: { name: string; id: number }; ancestors: { name: string }[] }[] }).matches[0]!;
    expect(match.component.name).toBe('Counter');
    expect(match.ancestors[0]!.name).toBe('App');

    // component → DOM
    const nodes = parseResult(await mcp.callTool({ name: 'react_get_dom_nodes', arguments: { elementId: match.component.id } }));
    expect((nodes.data.result as { nodes: { selector: string }[] }).nodes[0]!.selector).toBe('[data-testid="increment"]');

    // highlight — overlay host is present in the page
    const hl = parseResult(await mcp.callTool({ name: 'page_highlight', arguments: { elementId: match.component.id, durationMs: 5000, label: 'Counter' } }));
    expect((hl.data.result as { highlighted: number }).highlighted).toBe(1);
    await expect(page.locator('[data-dtmcp-overlay]')).toHaveCount(1);
    await page.screenshot({ path: 'test-results/highlight.png' });

    // element at point → the counter button
    const box = await page.getByTestId('increment').boundingBox();
    const at = parseResult(await mcp.callTool({ name: 'page_element_at_point', arguments: { x: box!.x + 2, y: box!.y + 2 } }));
    expect((at.data.result as { component: { name: string } }).component.name).toBe('Counter');

    // source: symbolicated via Vite's source maps when available; at minimum the owner stack has frames
    const src = parseResult(await mcp.callTool({ name: 'react_get_source', arguments: { elementId: match.component.id } }));
    expect(src.isError).toBe(false);
    const s = src.data.result as { source: { fileName: string; lineNumber?: number } | null; ownerStack: unknown[] };
    expect(s.source?.fileName ?? '').toMatch(/App\.tsx/);
  });

  test('page_pick_element resolves when the user clicks and cancels on Escape', async ({ context, mcp, waitForTabs }) => {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByTestId('app')).toBeVisible();
    await waitForTabs(1);

    const pending = mcp.callTool({ name: 'page_pick_element', arguments: { timeoutMs: 20_000 } });
    await page.waitForTimeout(300);
    await page.getByTestId('toggle-theme').click();
    const picked = parseResult(await pending);
    expect(picked.isError).toBe(false);
    expect((picked.data.result as { component: { name: string } }).component.name).toBe('App');
    // the click was swallowed: theme did not toggle
    await expect(page.getByTestId('app')).toHaveAttribute('data-theme', 'light');

    const pending2 = mcp.callTool({ name: 'page_pick_element', arguments: { timeoutMs: 20_000 } });
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    const cancelled = parseResult(await pending2);
    expect(cancelled.isError).toBe(true);
    expect((cancelled.data.error as { code: string }).code).toBe('CANCELLED');
  });

  test('tabs_open opens an allowlisted URL and refuses others', async ({ context, mcp, relay }) => {
    void context; // launches the browser + extension
    const opened = parseResult(await mcp.callTool({ name: 'tabs_open', arguments: { url: 'http://localhost:5199/', waitForCapability: 'react', waitMs: 15_000 } }));
    expect(opened.isError, JSON.stringify(opened.data)).toBe(false);
    expect(opened.data.tab).toMatch(/^t\d+$/);
    expect(opened.data.capabilities).toContain('react');
    expect(relay.link.tabs.get(opened.data.tab as `t${number}`)).toBeTruthy();

    const refused = parseResult(await mcp.callTool({ name: 'tabs_open', arguments: { url: 'https://example.com/' } }));
    expect(refused.isError).toBe(true);
    expect((refused.data.error as { code: string }).code).toBe('INVALID_INPUT');
  });
});
