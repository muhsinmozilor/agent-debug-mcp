import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor, type Check } from '../../packages/relay/src/doctor.js';
import { runInit } from '../../packages/relay/src/init.js';
import { expect, test } from './fixtures.js';

/** `agent-debug-mcp init` + `doctor` against the real chain: relay, paired extension, demo app opened by the doctor itself. */
test.describe('init + doctor', () => {
  test('doctor opens the app, finds React + TanStack, and every check passes', async ({ relay, context }) => {
    void context; // the fixture pairs the extension
    const cwd = mkdtempSync(join(tmpdir(), 'dtmcp-init-'));
    const init = runInit({ cwd, port: relay.port });
    expect(init.cdpUrl).toBeNull(); // browser tools are built in — no separate playwright entry
    const extCwd = mkdtempSync(join(tmpdir(), 'dtmcp-init-ext-'));
    expect(runInit({ cwd: extCwd, port: relay.port, externalPlaywright: true }).cdpUrl).toBe(relay.cdpUrl);

    const notes: string[] = [];
    const report = await runDoctor({ cwd, port: relay.port, url: 'http://localhost:5199/', startRelay: false, waitMs: 20_000, onNote: (m) => notes.push(m) });
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c])) as Record<string, Check>;
    const dump = JSON.stringify(report.checks, null, 1);
    expect(byId.config, dump).toMatchObject({ status: 'ok' });
    expect(byId.relay, dump).toMatchObject({ status: 'ok' });
    expect(byId.extension, dump).toMatchObject({ status: 'ok' });
    expect(byId.cdp, dump).toMatchObject({ status: 'ok', detail: relay.cdpUrl });
    expect(byId.tab, dump).toMatchObject({ status: 'ok' });
    expect(byId.react, dump).toMatchObject({ status: 'ok' });
    expect(byId.tanstack_query, dump).toMatchObject({ status: 'ok' });
    expect(byId.tanstack_router, dump).toMatchObject({ status: 'ok' });
    expect(byId.mutations, dump).toMatchObject({ status: 'ok' });
    expect(byId.browser, dump).toMatchObject({ status: 'ok' });
    expect(report.ok, dump).toBe(true);
    expect(notes.some((n) => n.includes('opening http://localhost:5199/'))).toBe(true); // it used tabs_open
    expect(relay.link.tabs.list().some((t) => t.url.startsWith('http://localhost:5199'))).toBe(true);
  });

  test('doctor reports a missing extension and stale config instead of hanging', async ({ relay }) => {
    // A relay with no extension: point the doctor at a fresh relay on another port (config written for the paired one).
    const cwd = mkdtempSync(join(tmpdir(), 'dtmcp-init-'));
    runInit({ cwd, port: relay.port });
    const report = await runDoctor({ cwd, port: relay.port + 1, url: 'http://localhost:5199/', waitMs: 1500 });
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c])) as Record<string, Check>;
    expect(byId.config).toMatchObject({ status: 'warn', detail: expect.stringContaining('port') }); // entry pinned to the paired relay's port
    expect(byId.relay).toMatchObject({ status: 'ok', detail: expect.stringContaining('temporary') });
    expect(byId.extension).toMatchObject({ status: 'fail', fix: expect.stringContaining('/pair') });
    expect(byId.tab).toMatchObject({ status: 'skip' });
    expect(report.ok).toBe(false);
  });
});
