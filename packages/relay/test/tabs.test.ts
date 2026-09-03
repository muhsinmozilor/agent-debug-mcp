import { describe, expect, it } from 'vitest';
import { TabRegistry } from '../src/tabs.js';
import { InvokeTracker } from '../src/invoke.js';
import { AgentDebugError, makeFrame } from '@devtools-mcp/protocol';

const info = (tab: string, over: Partial<Parameters<TabRegistry['upsert']>[0]> = {}) => ({
  tab,
  doc: `doc-${tab}`,
  url: `http://localhost/${tab}`,
  title: tab,
  active: false,
  windowId: 1,
  capabilities: [] as ('react' | 'page')[],
  mutationsAllowed: true,
  state: 'attached' as const,
  registryGen: 0,
  ...over,
});

describe('TabRegistry.resolve', () => {
  it('returns the sole tab when none specified', () => {
    const r = new TabRegistry();
    r.upsert(info('t1'));
    expect(r.resolve(undefined).tab).toBe('t1');
  });
  it('throws TAB_NOT_FOUND with hint when none attached or unknown handle', () => {
    const r = new TabRegistry();
    expect(() => r.resolve(undefined)).toThrow(AgentDebugError);
    r.upsert(info('t1'));
    try {
      r.resolve('t9');
    } catch (e) {
      expect((e as AgentDebugError).code).toBe('TAB_NOT_FOUND');
      expect((e as AgentDebugError).data).toMatchObject({ tabs: [{ tab: 't1' }] });
    }
  });
  it('throws AMBIGUOUS_TAB with candidates when several attached', () => {
    const r = new TabRegistry();
    r.upsert(info('t1'));
    r.upsert(info('t2'));
    try {
      r.resolve(undefined);
      throw new Error('should throw');
    } catch (e) {
      expect((e as AgentDebugError).code).toBe('AMBIGUOUS_TAB');
    }
  });
  it('ignores frozen tabs for implicit resolution and rejects them explicitly', () => {
    const r = new TabRegistry();
    r.upsert(info('t1'));
    r.upsert(info('t2'));
    r.setState('t2', 'frozen');
    expect(r.resolve(undefined).tab).toBe('t1');
    expect(() => r.resolve('t2')).toThrow(/back\/forward cache/);
  });
  it('keeps tools across same-doc upserts and clears on navigation', () => {
    const r = new TabRegistry();
    r.upsert(info('t1'));
    r.replaceRegistry('t1', 'doc-t1', 1, ['react'], [
      { name: 'react_get_tree', description: '', inputSchema: {}, annotations: {}, capability: 'react', mutation: false, schemaHash: 'x' },
    ]);
    r.upsert(info('t1', { title: 'renamed' }));
    expect(r.get('t1')!.tools.size).toBe(1);
    r.navigate('t1', 'doc2', 'http://localhost/x', 'x');
    expect(r.get('t1')!.tools.size).toBe(0);
    expect(r.get('t1')!.capabilities).toEqual([]);
  });
  it('stale marking + snapshot reconciliation', () => {
    const r = new TabRegistry();
    r.upsert(info('t1'));
    r.upsert(info('t2'));
    r.markAllStale(1000);
    expect(r.list()).toHaveLength(0);
    r.applySnapshot([info('t1')]);
    expect(r.list().map((t) => t.tab)).toEqual(['t1']);
    expect(r.pruneStale(5000, 10_000)).toEqual([]);
  });
});

describe('InvokeTracker', () => {
  it('resolves results and rejects errors by callId', async () => {
    const t = new InvokeTracker();
    const p = new Promise((resolve, reject) => {
      t.track({ callId: 'a', tab: 't1', tool: 'x', startedAt: 0, deadlineAt: Date.now() + 1000, resolve, reject }, () => undefined);
    });
    expect(t.handle(makeFrame({ t: 'invoke.result', callId: 'a', doc: 'd', result: { ok: 1 } }))).toBe(true);
    await expect(p).resolves.toEqual({ result: { ok: 1 }, doc: 'd', truncated: false });
    const q = new Promise((resolve, reject) => {
      t.track({ callId: 'b', tab: 't1', tool: 'x', startedAt: 0, deadlineAt: Date.now() + 1000, resolve, reject }, () => undefined);
    });
    t.handle(makeFrame({ t: 'invoke.error', callId: 'b', error: { code: 'PAGE_ERROR', message: 'boom', retryable: false } }));
    await expect(q).rejects.toMatchObject({ code: 'PAGE_ERROR' });
  });
  it('times out and notifies', async () => {
    const t = new InvokeTracker();
    let timedOut = '';
    const p = new Promise((resolve, reject) => {
      t.track({ callId: 'c', tab: 't1', tool: 'slow', startedAt: Date.now(), deadlineAt: Date.now() + 20, resolve, reject }, (c) => (timedOut = c.callId));
    });
    await expect(p).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(timedOut).toBe('c');
    expect(t.size()).toBe(0);
  });
});
