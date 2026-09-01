import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { UNTRUSTED_NOTE } from '../src/mcp.js';
import { connectPlaywrightServer, renameToolName, rewriteToolRefs } from '../src/playwright.js';
import { EXISTING_NAMES, makeOfflineBridge } from './pw-helper.js';

describe('rename layer', () => {
  it('renames browser_* to page_* and rewrites references in text', () => {
    expect(renameToolName('browser_click')).toBe('page_click');
    expect(renameToolName('browser_take_screenshot')).toBe('page_take_screenshot');
    expect(renameToolName('other_tool')).toBe('other_tool');
    expect(rewriteToolRefs('Use browser_snapshot then browser_click.')).toBe('Use page_snapshot then page_click.');
    expect(rewriteToolRefs('no refs here')).toBe('no refs here');
  });
});

/** A fake "Playwright MCP" server: enough surface to test listing, renaming, forwarding and abort. */
function fakeServer(): McpServer {
  const server = new McpServer({ name: 'fake-playwright', version: '0' }, { capabilities: { tools: {} } });
  server.registerTool(
    'browser_echo',
    { description: 'Echo args. See browser_echo docs.', inputSchema: z.object({ value: z.string() }), annotations: { readOnlyHint: true } },
    async ({ value }) => ({
      content: [
        { type: 'text', text: `echo:${value}` },
        { type: 'image', data: 'aGk=', mimeType: 'image/png' },
      ],
    }),
  );
  server.registerTool('browser_fail', { description: 'Always fails.', inputSchema: z.object({}) }, async () => ({
    isError: true,
    content: [{ type: 'text', text: '### Error\nboom' }],
  }));
  server.registerTool('browser_snapshot', { description: 'Colliding snapshot.', inputSchema: z.object({}) }, async () => ({ content: [] }));
  server.registerTool(
    'browser_hang',
    { description: 'Never resolves.', inputSchema: z.object({}) },
    (_args, extra) => new Promise((_res, rej) => extra.signal.addEventListener('abort', () => rej(new Error('aborted')))),
  );
  return server;
}

describe('connectPlaywrightServer (fake server)', () => {
  it('lists renamed tools, skips collisions, forwards calls and labels results untrusted', async () => {
    const bridge = await connectPlaywrightServer(fakeServer(), { existingNames: new Set(['page_snapshot']), version: '0' });
    expect(bridge.tools.map((t) => t.name).sort()).toEqual(['page_echo', 'page_fail', 'page_hang']);
    const echo = bridge.tools.find((t) => t.name === 'page_echo')!;
    expect(echo.sourceName).toBe('browser_echo');
    expect(echo.description).toBe('Echo args. See page_echo docs.');
    expect(echo.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });

    const res = await bridge.call('browser_echo', { value: 'hi' });
    expect(res.isError).toBeFalsy();
    const content = res.content as { type: string; text?: string; data?: string }[];
    expect(content[0]).toEqual({ type: 'text', text: UNTRUSTED_NOTE });
    expect(content[1]).toEqual({ type: 'text', text: 'echo:hi' });
    expect(content[2]).toMatchObject({ type: 'image', data: 'aGk=' }); // image blocks pass through untouched

    const fail = await bridge.call('browser_fail', {});
    expect(fail.isError).toBe(true);
    expect((fail.content as { text?: string }[])[0]!.text).toContain('### Error'); // verbatim, no untrusted prefix
    await bridge.close();
  });

  it('aborting the signal rejects the forwarded call', async () => {
    const bridge = await connectPlaywrightServer(fakeServer(), { existingNames: new Set(), version: '0' });
    const ac = new AbortController();
    const p = bridge.call('browser_hang', {}, { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toThrow();
    await bridge.close();
  });
});

describe('embedded @playwright/mcp (real module, offline)', () => {
  it('exposes the renamed core tool set without touching a browser', async () => {
    const bridge = await makeOfflineBridge();
    const names = new Set(bridge.tools.map((t) => t.name));
    for (const n of ['page_navigate', 'page_click', 'page_type', 'page_take_screenshot', 'page_tabs', 'page_console_messages', 'page_network_requests', 'page_evaluate']) {
      expect(names.has(n), `missing ${n}`).toBe(true);
    }
    expect(names.has('page_snapshot')).toBe(false); // collides with the relay's own page_snapshot → skipped
    for (const n of EXISTING_NAMES) expect(names.has(n), `collision with relay tool: ${n}`).toBe(false);
    for (const t of bridge.tools) {
      expect(t.name.startsWith('page_'), `${t.name} not renamed`).toBe(true);
      expect(t.description).not.toMatch(/\bbrowser_[a-z]/);
    }
    expect(bridge.tools.find((t) => t.name === 'page_tabs')!.description).toContain('tabs_list');
    await bridge.close();
  }, 30_000);
});
