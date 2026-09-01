import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { ExtensionLink } from '../src/extension-link.js';
import { createMcpServer, RELAY_TOOL_METAS } from '../src/mcp.js';
import { PROMPTS } from '../src/prompts.js';
import { makeOfflineBridge } from './pw-helper.js';

describe('prompts', () => {
  it('are advertised with their arguments and render the recipe with the values filled in', async () => {
    const link = Object.assign(new EventEmitter(), { connected: false, tabs: { summaries: () => [], get: () => undefined, list: () => [] } }) as unknown as ExtensionLink;
    const bridge = await makeOfflineBridge();
    const server = createMcpServer({ link, version: '0.0.0', playwright: bridge });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(c);

    const listed = await client.listPrompts();
    expect(listed.prompts.map((p) => p.name).sort()).toEqual(['debug_rerender', 'debug_route', 'debug_stale_data']);
    const rerender = listed.prompts.find((p) => p.name === 'debug_rerender')!;
    expect(rerender.arguments?.map((a) => a.name)).toEqual(['target', 'trigger']);
    expect(rerender.arguments?.every((a) => a.required === false || a.required === undefined)).toBe(true);

    const got = await client.getPrompt({ name: 'debug_rerender', arguments: { target: '[data-testid="save"]', trigger: 'typing in the search box' } });
    const text = (got.messages[0]!.content as { text: string }).text;
    expect(text).toContain('react_explain { selector: "[data-testid="save"]" }');
    expect(text).toContain('page_get_errors { since:');
    expect(text).toContain('when typing in the search box');
    expect(text).toContain('react_profile_get_commits');

    const noArgs = await client.getPrompt({ name: 'debug_stale_data', arguments: {} });
    expect((noArgs.messages[0]!.content as { text: string }).text).toContain('tanstack_query_list_queries');

    // Every tool a recipe names must exist on the server, embedded page_* browser tools included (tanstack_query/router are capabilities).
    const tools = new Set([...RELAY_TOOL_METAS.map((m) => m.name), 'tabs_list', 'tabs_open', ...bridge.tools.map((t) => t.name)]);
    const capabilities = new Set(['tanstack_query', 'tanstack_router']);
    for (const p of PROMPTS) {
      const mentioned = p.build({}).match(/\b(react|tanstack|page|tabs)_[a-z_]+\b/g) ?? [];
      for (const name of mentioned) if (!capabilities.has(name)) expect(tools.has(name), `${p.name} mentions unknown tool ${name}`).toBe(true);
    }
    await client.close();
    await server.close();
    await bridge.close();
  });
});
