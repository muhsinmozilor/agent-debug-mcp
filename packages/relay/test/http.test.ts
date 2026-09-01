import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startRelay, type RunningRelay } from '../src/index.js';

/** The relay's HTTP surface used by pairing: /pair.json (extension auto-discovery), /health, /pair. */
describe('http pairing endpoints', () => {
  let relay: RunningRelay;
  beforeEach(async () => {
    process.env.AGENT_DEBUG_MCP_HOME = mkdtempSync(join(tmpdir(), 'dtmcp-http-'));
    relay = await startRelay({ port: 0, stdio: false, logLevel: 'error' });
  });
  afterEach(async () => {
    await relay.close();
  });

  it('serves /pair.json with the relay token and a loopback ws URL, without CORS', async () => {
    const res = await fetch(`http://127.0.0.1:${relay.port}/pair.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      name: 'agent-debug-mcp',
      version: expect.any(String),
      instanceId: relay.instanceId,
      wsUrl: `ws://127.0.0.1:${relay.port}/ws`,
      token: relay.config.token,
    });
    expect(relay.config.token.length).toBeGreaterThanOrEqual(32);
  });

  it('derives wsUrl from the Host header (localhost stays localhost)', async () => {
    const res = await fetch(`http://localhost:${relay.port}/pair.json`);
    const body = (await res.json()) as { wsUrl: string };
    expect(body.wsUrl).toBe(`ws://localhost:${relay.port}/ws`);
  });

  it('refuses a non-loopback Host (DNS rebinding)', async () => {
    // fetch() drops a user-supplied Host header, so use node:http directly.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      request({ host: '127.0.0.1', port: relay.port, path: '/pair.json', headers: { host: 'evil.example:80' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      })
        .on('error', reject)
        .end();
    });
    expect(status).toBe(421);
  });

  it('/pair still carries the meta tags the content script reads and /health reports the pin state', async () => {
    const html = await (await fetch(`http://127.0.0.1:${relay.port}/pair`)).text();
    expect(html).toContain(`<meta name="dtmcp-pair" content="${relay.config.token}">`);
    expect(html).toContain(`<meta name="dtmcp-relay" content="ws://127.0.0.1:${relay.port}/ws">`);
    const health = (await (await fetch(`http://127.0.0.1:${relay.port}/health`)).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ name: 'agent-debug-mcp', extensionConnected: false, lastRejectedExtensionId: null });
  });
});
