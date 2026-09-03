import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCall } from '../src/call.js';
import { startRelay, type RunningRelay } from '../src/index.js';

/** `agent-debug-mcp call` against a live relay over /mcp (no daemon spawn: ensureDaemon finds it healthy). */
describe('runCall', () => {
  let relay: RunningRelay;
  const opts = { version: 'test', host: '127.0.0.1' };

  beforeAll(async () => {
    process.env.AGENT_DEBUG_MCP_HOME = mkdtempSync(join(tmpdir(), 'dtmcp-call-'));
    relay = await startRelay({ port: 0, stdio: false, playwright: false, logLevel: 'error' });
  });
  afterAll(async () => {
    await relay.close();
  });

  it('--list returns the fixed tool set', async () => {
    const outcome = await runCall({ ...opts, list: true, port: relay.port });
    expect(outcome.kind).toBe('list');
    if (outcome.kind !== 'list') return;
    const names = outcome.tools.map((t) => t.name);
    expect(names).toContain('tabs_list');
    expect(names).toContain('react_get_tree');
    expect(names).toContain('tanstack_query_list_queries');
  });

  it('--describe returns the full schema with the injected tab param', async () => {
    const outcome = await runCall({ ...opts, describe: 'react_get_tree', port: relay.port });
    expect(outcome.kind).toBe('describe');
    if (outcome.kind !== 'describe') return;
    const props = (outcome.tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props)).toContain('tab');
    expect(Object.keys(props)).toContain('maxDepth');
  });

  it('rejects an unknown --describe target', async () => {
    await expect(runCall({ ...opts, describe: 'nope', port: relay.port })).rejects.toThrow(/unknown tool "nope"/);
  });

  it('calls tabs_list and returns its result', async () => {
    const outcome = await runCall({ ...opts, tool: 'tabs_list', port: relay.port });
    expect(outcome.kind).toBe('result');
    if (outcome.kind !== 'result') return;
    const first = outcome.result.content?.[0];
    expect(first?.type).toBe('text');
    const payload = JSON.parse((first as { text: string }).text) as { extensionConnected: boolean; tabs: unknown[] };
    expect(payload.extensionConnected).toBe(false);
    expect(payload.tabs).toEqual([]);
  });

  it('requires a tool when not listing', async () => {
    await expect(runCall({ ...opts, port: relay.port })).rejects.toThrow(/no tool given/);
  });
});
