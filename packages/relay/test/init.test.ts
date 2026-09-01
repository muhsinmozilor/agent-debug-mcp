import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkMcpConfig } from '../src/doctor.js';
import { devtoolsServerEntry, mergeMcpConfig, playwrightServerEntry, runInit } from '../src/init.js';

describe('init', () => {
  let home: string;
  let cwd: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dtmcp-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'dtmcp-proj-'));
    process.env.AGENT_DEBUG_MCP_HOME = home;
  });

  it('builds entries and merges without touching other servers', () => {
    expect(devtoolsServerEntry({ port: 9333, host: '127.0.0.1', transport: 'stdio' })).toEqual({ command: 'npx', args: ['-y', 'agent-debug-mcp'] });
    expect(devtoolsServerEntry({ port: 9400, host: '127.0.0.1', transport: 'stdio' })).toEqual({ command: 'npx', args: ['-y', 'agent-debug-mcp', '--port', '9400'] });
    expect(devtoolsServerEntry({ port: 9333, host: '127.0.0.1', transport: 'http' })).toEqual({ type: 'http', url: 'http://127.0.0.1:9333/mcp' });
    // Without a playwright entry the merge leaves an existing `playwright` server untouched (users may run their own).
    const kept = mergeMcpConfig(
      { mcpServers: { github: { command: 'gh-mcp' }, playwright: { command: 'their-own' }, 'agent-debug': { old: true } }, other: 1 },
      { devtools: devtoolsServerEntry({ port: 9333, host: '127.0.0.1', transport: 'stdio' }) },
    );
    expect(kept.other).toBe(1);
    expect(kept.mcpServers!.github).toEqual({ command: 'gh-mcp' });
    expect(kept.mcpServers!.playwright).toEqual({ command: 'their-own' });
    expect(kept.mcpServers!['agent-debug']).toEqual({ command: 'npx', args: ['-y', 'agent-debug-mcp'] });
    // With one (init --external-playwright) it is written.
    const merged = mergeMcpConfig(
      { mcpServers: {} },
      { devtools: devtoolsServerEntry({ port: 9333, host: '127.0.0.1', transport: 'stdio' }), playwright: playwrightServerEntry('http://127.0.0.1:9333/cdp/tok') },
    );
    expect(merged.mcpServers!.playwright).toEqual({ command: 'npx', args: ['-y', '@playwright/mcp@latest', '--cdp-endpoint', 'http://127.0.0.1:9333/cdp/tok'] });
  });

  it('writes a single agent-debug entry by default (browser tools are built in) and satisfies doctor', () => {
    const first = runInit({ cwd });
    expect(first.created).toBe(true);
    expect(first.cdpUrl).toBeNull();
    const onDisk = JSON.parse(readFileSync(first.path, 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(onDisk.mcpServers)).toEqual(['agent-debug']);
    const cfg = JSON.parse(readFileSync(join(home, 'relay.json'), 'utf8')) as { cdpToken: string };
    expect(checkMcpConfig(first.path, { port: 9333, cdpUrl: `http://127.0.0.1:9333/cdp/${cfg.cdpToken}` })).toMatchObject({ status: 'ok', detail: expect.stringContaining('built in') });

    // Existing servers (including a user-run playwright) survive; running again is idempotent.
    writeFileSync(first.path, JSON.stringify({ mcpServers: { github: { command: 'x' }, playwright: { command: 'their-own' } } }));
    const second = runInit({ cwd, out: '.mcp.json', port: 9400 });
    expect(second.created).toBe(false);
    expect(second.cdpUrl).toBeNull();
    const merged = JSON.parse(readFileSync(second.path, 'utf8')) as { mcpServers: Record<string, { command?: string }> };
    expect(Object.keys(merged.mcpServers).sort()).toEqual(['agent-debug', 'github', 'playwright']);
    expect(merged.mcpServers.playwright).toEqual({ command: 'their-own' });
    // A port mismatch between the entry and the checked relay is flagged.
    expect(checkMcpConfig(second.path, { port: 9333, cdpUrl: 'http://127.0.0.1:9333/cdp/x' })).toMatchObject({ status: 'warn', detail: expect.stringContaining('port 9400') });

    // Cursor layout creates the directory.
    const cursor = runInit({ cwd, out: '.cursor/mcp.json' });
    expect(cursor.cdpUrl).toBeNull();
    expect(checkMcpConfig(cursor.path, { port: 9333, cdpUrl: 'http://127.0.0.1:9333/cdp/x' })).toMatchObject({ status: 'ok' });
  });

  it('--external-playwright reproduces the two-server config; doctor flags it as redundant', () => {
    const init = runInit({ cwd, externalPlaywright: true });
    const cfg = JSON.parse(readFileSync(join(home, 'relay.json'), 'utf8')) as { cdpToken: string };
    expect(init.cdpUrl).toBe(`http://127.0.0.1:9333/cdp/${cfg.cdpToken}`);
    const onDisk = JSON.parse(readFileSync(init.path, 'utf8')) as { mcpServers: Record<string, { args?: string[] }> };
    expect(onDisk.mcpServers.playwright!.args).toContain(init.cdpUrl);
    // The external entry is redundant now (it evicts the built-in page_* tools) → warn, matching endpoint or not.
    expect(checkMcpConfig(init.path, { port: 9333, cdpUrl: init.cdpUrl! })).toMatchObject({ status: 'warn', detail: expect.stringContaining('separate Playwright MCP entry') });
    expect(checkMcpConfig(init.path, { port: 9333, cdpUrl: 'http://127.0.0.1:9333/cdp/other' })).toMatchObject({ status: 'warn', detail: expect.stringContaining('does not match') });
  });

  it('refuses to clobber a file that is not a JSON object', () => {
    writeFileSync(join(cwd, '.mcp.json'), '[1,2]');
    expect(() => runInit({ cwd })).toThrow(/not a JSON object/);
    expect(checkMcpConfig(join(cwd, 'missing.json'), { port: 9333, cdpUrl: 'x' })).toMatchObject({ status: 'warn' });
  });
});
