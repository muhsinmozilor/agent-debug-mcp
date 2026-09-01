/**
 * Daemon lifecycle used by the stdio entrypoint: ensureRelayDaemon spawns a detached relay (here: the
 * fake-daemon fixture) once, reuses it across sessions, replaces an outdated daemon it owns, leaves foreign
 * relays alone, and stopRelayDaemon tears it down via the pid file.
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureRelayDaemon, fetchRelayHealth, readDaemonInfo, stopRelayDaemon } from '../src/daemon.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-daemon.mjs');

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

describe('relay daemon lifecycle', () => {
  let home: string;
  let port: number;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'agent-debug-daemon-'));
    process.env.AGENT_DEBUG_MCP_HOME = home;
    port = await freePort();
  });

  afterEach(async () => {
    await stopRelayDaemon(port).catch(() => undefined);
    delete process.env.AGENT_DEBUG_MCP_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  const ensure = (version: string) =>
    ensureRelayDaemon({ port, version, spawnCmd: [process.execPath, fixture], env: { FAKE_VERSION: version } });

  it('spawns a detached daemon once and every later session reuses it', async () => {
    const first = await ensure('1.0.0-test');
    expect(first.started).toBe(true);
    expect(first.url).toBe(`http://127.0.0.1:${port}/mcp`);
    expect(first.health).toMatchObject({ name: 'agent-debug-mcp', version: '1.0.0-test' });

    const info = readDaemonInfo(port);
    expect(info?.port).toBe(port);
    expect(info?.version).toBe('1.0.0-test');
    expect(() => process.kill(info!.pid, 0)).not.toThrow(); // alive

    const second = await ensure('1.0.0-test');
    expect(second.started).toBe(false);
    expect(second.health.instanceId).toBe(first.health.instanceId); // same process, not a respawn
  }, 20_000);

  it('stop kills the daemon via the pid file and is idempotent', async () => {
    const { health } = await ensure('1.0.0-test');
    expect(health).not.toBeNull();

    const stopped = await stopRelayDaemon(port);
    expect(stopped.status).toBe('stopped');
    expect(readDaemonInfo(port)).toBeNull();
    await expect.poll(() => fetchRelayHealth('127.0.0.1', port, 500)).toBeNull();

    const again = await stopRelayDaemon(port);
    expect(again.status).toBe('not-running');
  }, 20_000);

  it('replaces a daemon it owns when the CLI version differs', async () => {
    const old = await ensure('1.0.0-test');
    const upgraded = await ensure('2.0.0-test');
    expect(upgraded.started).toBe(true);
    expect(upgraded.health.version).toBe('2.0.0-test');
    expect(upgraded.health.instanceId).not.toBe(old.health.instanceId);
    expect(readDaemonInfo(port)?.version).toBe('2.0.0-test');
  }, 20_000);

  it('proxies to a foreign relay as-is (no pid file, never killed) and stop reports it', async () => {
    const foreign: Server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ name: 'agent-debug-mcp', version: '9.9.9', instanceId: 'foreign' }));
    });
    await new Promise<void>((r) => foreign.listen(port, '127.0.0.1', r));
    try {
      const ensured = await ensure('1.0.0-test');
      expect(ensured.started).toBe(false);
      expect(ensured.health).toMatchObject({ version: '9.9.9', instanceId: 'foreign' }); // untouched
      expect(readDaemonInfo(port)).toBeNull();

      const stopped = await stopRelayDaemon(port);
      expect(stopped.status).toBe('foreign');
      expect(await fetchRelayHealth('127.0.0.1', port)).not.toBeNull(); // still alive
    } finally {
      await new Promise<void>((r) => foreign.close(() => r()));
    }
  }, 20_000);
});
