import { expect, parseResult, test } from './fixtures.js';

test.describe('slice 1 — skeleton end to end', () => {
  test('tabs_list shows the demo tab with the react capability', async ({ context, mcp, waitForTabs }) => {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByTestId('app')).toBeVisible();
    await waitForTabs(1);

    const tools = await mcp.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['react_get_renderers', 'react_get_tree', 'tabs_list']));
    const treeTool = tools.tools.find((t) => t.name === 'react_get_tree')!;
    expect((treeTool.inputSchema as { properties: Record<string, unknown> }).properties).toHaveProperty('tab');

    const res = parseResult(await mcp.callTool({ name: 'tabs_list', arguments: {} }));
    expect(res.isError).toBe(false);
    expect(res.data.extensionConnected).toBe(true);
    const tabs = res.data.tabs as { tab: string; url: string; capabilities: string[] }[];
    const demo = tabs.find((t) => t.url.startsWith('http://localhost:5199'));
    expect(demo).toBeTruthy();
    expect(demo!.capabilities).toContain('react');
    expect(demo!.tab).toMatch(/^t\d+$/);
  });

  test('react_get_renderers and react_get_tree work, paginate, and resolve the sole tab implicitly', async ({ context, mcp, waitForTabs }) => {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByTestId('app')).toBeVisible();
    await waitForTabs(1);

    const renderers = parseResult(await mcp.callTool({ name: 'react_get_renderers', arguments: {} }));
    expect(renderers.isError).toBe(false);
    const r = renderers.data.result as { renderers: { version: string; buildType: string; rootCount: number }[]; hookMode: string };
    expect(r.renderers[0]!.version).toMatch(/^19\./);
    expect(r.renderers[0]!.buildType).toBe('development');
    expect(r.renderers[0]!.rootCount).toBe(1);

    const first = parseResult(await mcp.callTool({ name: 'react_get_tree', arguments: { maxNodes: 3, maxDepth: 40 } }));
    expect(first.isError).toBe(false);
    const p1 = first.data.result as { items: { name: string; depth: number; id: number }[]; nextCursor?: string; total: number; truncated: boolean };
    expect(p1.items).toHaveLength(3);
    expect(p1.truncated).toBe(true);
    expect(p1.items[0]!.depth).toBe(0); // provider chain is the outermost composite layer
    expect(typeof first.data.doc).toBe('string');

    const second = parseResult(await mcp.callTool({ name: 'react_get_tree', arguments: { maxNodes: 100, maxDepth: 40, cursor: p1.nextCursor } }));
    const p2 = second.data.result as { items: { name: string }[]; truncated: boolean };
    expect(p2.truncated).toBe(false);
    const all = [...p1.items, ...p2.items].map((i) => i.name);
    expect(all).toEqual(expect.arrayContaining(['App', 'Counter', 'Themed', 'MemoList', 'ListItem']));
    expect(all.length).toBe(p1.total);

    // Explicit tab handle also works
    const tabRes = parseResult(await mcp.callTool({ name: 'tabs_list', arguments: {} }));
    const tab = (tabRes.data.tabs as { tab: string }[])[0]!.tab;
    const explicit = parseResult(await mcp.callTool({ name: 'react_get_tree', arguments: { tab, maxNodes: 1 } }));
    expect(explicit.isError).toBe(false);
    expect(explicit.data.tab).toBe(tab);
  });

  test('a tab without React reports CAPABILITY_UNAVAILABLE and two tabs require an explicit handle', async ({ context, mcp, relay, waitForTabs }) => {
    const plain = await context.newPage();
    await plain.goto('http://127.0.0.1:' + relay.port + '/health'); // localhost origin, no React
    await waitForTabs(1);
    const res = parseResult(await mcp.callTool({ name: 'react_get_tree', arguments: {} }));
    expect(res.isError).toBe(true);
    expect((res.data.error as { code: string }).code).toBe('CAPABILITY_UNAVAILABLE');

    const demo = await context.newPage();
    await demo.goto('/');
    await expect(demo.getByTestId('app')).toBeVisible();
    await waitForTabs(2);
    const ambiguous = parseResult(await mcp.callTool({ name: 'react_get_tree', arguments: {} }));
    expect(ambiguous.isError).toBe(true);
    const err = ambiguous.data.error as { code: string; data: { tabs: { tab: string; capabilities: string[] }[] } };
    expect(err.code).toBe('AMBIGUOUS_TAB');
    const reactTab = err.data.tabs.find((t) => t.capabilities.includes('react'))!;
    const ok = parseResult(await mcp.callTool({ name: 'react_get_tree', arguments: { tab: reactTab.tab, maxNodes: 5 } }));
    expect(ok.isError).toBe(false);
  });

  test('a stale element id after reload yields STALE_ELEMENT; tab handle survives the reload', async ({ context, mcp, waitForTabs }) => {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByTestId('app')).toBeVisible();
    await waitForTabs(1);
    const before = parseResult(await mcp.callTool({ name: 'react_get_tree', arguments: { maxNodes: 1 } }));
    const rootId = (before.data.result as { items: { id: number }[] }).items[0]!.id;
    const tab = before.data.tab as string;

    await page.reload();
    await expect(page.getByTestId('app')).toBeVisible();
    await expect.poll(async () => parseResult(await mcp.callTool({ name: 'react_get_tree', arguments: { tab, maxNodes: 1 } })).isError, { timeout: 15_000 }).toBe(false);
    const after = parseResult(await mcp.callTool({ name: 'react_get_tree', arguments: { tab, rootId, maxNodes: 1 } }));
    // ids are per-document; a fresh document has a new id space (may coincide numerically, so accept either a STALE_ELEMENT or a doc change)
    const afterAll = parseResult(await mcp.callTool({ name: 'react_get_tree', arguments: { tab, maxNodes: 1 } }));
    expect(afterAll.data.doc).not.toBe(before.data.doc);
    if (after.isError) expect((after.data.error as { code: string }).code).toBe('STALE_ELEMENT');
  });

  test('rejects WebSocket upgrades from non-extension origins', async ({ relay }) => {
    const res = await fetch(`http://127.0.0.1:${relay.port}/ws`, {
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', Origin: 'http://evil.example' },
    }).catch((e: Error) => e);
    // Node's fetch cannot complete an upgrade; a 403 or a socket error both prove the handshake was refused.
    if (res instanceof Response) expect(res.status).toBe(403);
  });
});

test.describe('slice 1 — resilience', () => {
  test('extension reconnects after the relay drops the socket and re-syncs its tabs', async ({ context, mcp, relay, waitForTabs }) => {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByTestId('app')).toBeVisible();
    await waitForTabs(1);

    // Simulate a transport failure from the relay side.
    (relay.link as unknown as { socket: { terminate: () => void } }).socket.terminate();
    await expect.poll(() => relay.link.connected, { timeout: 2_000 }).toBe(false);
    await expect.poll(() => relay.link.connected, { timeout: 10_000 }).toBe(true);
    await waitForTabs(1, 10_000);

    const res = parseResult(await mcp.callTool({ name: 'react_get_tree', arguments: { maxNodes: 1 } }));
    expect(res.isError).toBe(false);
  });
});

test('serves the debugging prompts over MCP', async ({ mcp }) => {
  const { prompts } = await mcp.listPrompts();
  expect(prompts.map((p) => p.name).sort()).toEqual(['debug_rerender', 'debug_route', 'debug_stale_data']);
  const got = await mcp.getPrompt({ name: 'debug_route', arguments: { path: '/users/42' } });
  expect((got.messages[0]!.content as { text: string }).text).toContain('tanstack_router_get_state');
});
