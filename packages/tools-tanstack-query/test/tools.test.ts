import { QueryClient } from '@tanstack/query-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTanstackQueryTools, findQueryClient, watchQueryClient } from '../src/index.js';

declare global {
  interface Window {
    __TANSTACK_QUERY_CLIENT__?: unknown;
  }
}

const ac = new AbortController();
const tools = createTanstackQueryTools({ docId: 'd' });
const call = async (name: string, input: unknown) => tools.find((t) => t.name === name)!.execute(input, { signal: ac.signal });

let client: QueryClient;
beforeEach(async () => {
  client = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000, gcTime: 60_000 } } });
  window.__TANSTACK_QUERY_CLIENT__ = client;
  await client.fetchQuery({ queryKey: ['users', { page: 1 }], queryFn: async () => [{ id: 1, name: 'a' }] });
  await client.fetchQuery({ queryKey: ['users', { page: 2 }], queryFn: async () => [{ id: 2, name: 'b' }] });
  await client.fetchQuery({ queryKey: ['settings'], queryFn: async () => ({ theme: 'dark', big: new Map([['k', { nested: { deep: 1 } }]]), when: new Date(0) }) });
  await client.fetchQuery({ queryKey: ['broken'], queryFn: async () => { throw new Error('nope'); }, retry: 0 }).catch(() => undefined);
});
afterEach(() => {
  client.clear();
  delete window.__TANSTACK_QUERY_CLIENT__;
});

describe('discovery', () => {
  it('finds the client and reports absence', () => {
    expect(findQueryClient()).toBe(client);
    delete window.__TANSTACK_QUERY_CLIENT__;
    expect(findQueryClient()).toBeNull();
  });
  it('watch notifies when the client appears', async () => {
    delete window.__TANSTACK_QUERY_CLIENT__;
    const seen: boolean[] = [];
    const stop = watchQueryClient((p) => seen.push(p), { intervalMs: 10, maxMs: 1000 });
    await new Promise((r) => setTimeout(r, 30));
    window.__TANSTACK_QUERY_CLIENT__ = client;
    await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(seen).toEqual([false, true]);
  });
  it('tools throw CAPABILITY_UNAVAILABLE without a client', async () => {
    delete window.__TANSTACK_QUERY_CLIENT__;
    await expect(call('tanstack_query_list_queries', {})).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
  });
});

describe('tanstack_query_list_queries', () => {
  it('lists summaries with filters and pagination', async () => {
    const all = (await call('tanstack_query_list_queries', {})) as { items: { queryKey: unknown; status: string; dataPreview: string; isStale: boolean; observers: number }[]; total: number };
    expect(all.total).toBe(4);
    const users = (await call('tanstack_query_list_queries', { queryKeyPrefix: ['users'] })) as { items: { queryKey: unknown }[] };
    expect(users.items).toHaveLength(2);
    expect(users.items[0]!.queryKey).toEqual(['users', { page: 1 }]);
    const errored = (await call('tanstack_query_list_queries', { status: 'error' })) as { items: { error: unknown; queryKey: unknown }[] };
    expect(errored.items).toHaveLength(1);
    expect(errored.items[0]!.error).toMatchObject({ $: 'error', message: 'nope' });
    const p1 = (await call('tanstack_query_list_queries', { limit: 3 })) as { items: unknown[]; nextCursor?: string; truncated: boolean };
    expect(p1.items).toHaveLength(3);
    expect(p1.truncated).toBe(true);
    const p2 = (await call('tanstack_query_list_queries', { limit: 3, cursor: p1.nextCursor })) as { items: unknown[]; truncated: boolean };
    expect(p2.items).toHaveLength(1);
    expect(p2.truncated).toBe(false);
    const fresh = (await call('tanstack_query_list_queries', { stale: false })) as { items: unknown[] };
    expect(fresh.items.length).toBeGreaterThanOrEqual(3);
  });
});

describe('tanstack_query_get_query', () => {
  it('returns state/options/data and expands nested data', async () => {
    const list = (await call('tanstack_query_list_queries', { queryKeyPrefix: ['settings'] })) as { items: { queryHash: string }[] };
    const hash = list.items[0]!.queryHash;
    const q = (await call('tanstack_query_get_query', { queryHash: hash, expand: [['data', 'big', 0, 1, 'nested']] })) as {
      status: string;
      data: { theme: string; big: unknown; when: unknown };
      options: { staleTime: number; queryFn: unknown };
      state: { dataUpdateCount: number; data?: unknown };
      expanded: { value: unknown }[];
    };
    expect(q.status).toBe('success');
    expect(q.data.theme).toBe('dark');
    expect(q.data.when).toEqual({ $: 'date', iso: '1970-01-01T00:00:00.000Z' });
    expect(q.data.big).toMatchObject({ $: 'map', size: 1 });
    expect(q.options.staleTime).toBe(10_000);
    expect(q.options.queryFn).toMatchObject({ $: 'fn' });
    expect(q.state.dataUpdateCount).toBe(1);
    expect(q.state.data).toBeUndefined(); // data is split out
    expect(q.expanded[0]!.value).toEqual({ deep: 1 });
    const byKey = (await call('tanstack_query_get_query', { queryKey: ['users', { page: 2 }] })) as { data: unknown };
    expect(byKey.data).toEqual([{ id: 2, name: 'b' }]);
    await expect(call('tanstack_query_get_query', { queryHash: 'nope' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('mutations', () => {
  it('lists and gets mutations', async () => {
    const m = client.getMutationCache().build(client, { mutationKey: ['rename'], mutationFn: async (v: { id: number }) => ({ ...v, name: 'x' }) });
    await m.execute({ id: 7 });
    const list = (await call('tanstack_query_list_mutations', {})) as { items: { mutationId: number; status: string; mutationKey: unknown; variablesPreview: string }[] };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ status: 'success', mutationKey: ['rename'] });
    expect(list.items[0]!.variablesPreview).toContain('id: 7');
    const got = (await call('tanstack_query_get_mutation', { mutationId: list.items[0]!.mutationId })) as { state: { data: unknown; variables: unknown } };
    expect(got.state.data).toEqual({ id: 7, name: 'x' });
    expect(got.state.variables).toEqual({ id: 7 });
    await expect(call('tanstack_query_get_mutation', { mutationId: 999 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('mutation tools', () => {
  it('invalidate / refetch / set_data / remove', async () => {
    let fetches = 0;
    await client.fetchQuery({ queryKey: ['counter'], queryFn: async () => ++fetches });
    const inv = (await call('tanstack_query_invalidate', { queryKey: ['counter'], exact: true, refetchType: 'none' })) as { invalidated: number };
    expect(inv.invalidated).toBe(1);
    expect(client.getQueryCache().find({ queryKey: ['counter'] })!.state.isInvalidated).toBe(true);
    const rf = (await call('tanstack_query_refetch', { queryKey: ['counter'], waitMs: 5000 })) as { refetched: number; timedOut: boolean };
    expect(rf).toMatchObject({ refetched: 1, timedOut: false });
    expect(fetches).toBe(2);
    const set = (await call('tanstack_query_set_data', { queryKey: ['settings'], data: { theme: 'light', when: { $: 'date', iso: '2026-05-05T00:00:00.000Z' } } })) as { ok: boolean };
    expect(set.ok).toBe(true);
    const d = client.getQueryData<{ theme: string; when: Date }>(['settings'])!;
    expect(d.theme).toBe('light');
    expect(d.when).toBeInstanceOf(Date);
    const rm = (await call('tanstack_query_remove', { queryKey: ['users'] })) as { affected: number };
    expect(rm.affected).toBe(2);
    expect(client.getQueryCache().findAll({ queryKey: ['users'] })).toHaveLength(0);
  });
});

describe('captureQueryErrors', () => {
  it('records failed queries and mutations once per client', async () => {
    const { ErrorLog } = await import('@devtools-mcp/protocol');
    const { captureQueryErrors } = await import('../src/errors.js');
    const log = new ErrorLog();
    const stop = captureQueryErrors(log, client as never);
    const again = captureQueryErrors(log, client as never); // idempotent
    await client.fetchQuery({ queryKey: ['explode', 1], queryFn: async () => { throw new Error('server 500'); }, retry: 0 }).catch(() => undefined);
    const { MutationObserver } = await import('@tanstack/query-core');
    const mo = new MutationObserver(client, { mutationKey: ['rename'], mutationFn: async () => { throw new Error('forbidden'); } });
    await mo.mutate(1 as never).catch(() => undefined);
    const kinds = log.all().map((e) => [e.kind, e.message]);
    expect(kinds).toContainEqual(['query', expect.stringMatching(/Query \["explode", 1\] failed: server 500/)]);
    expect(kinds).toContainEqual(['mutation', 'Mutation ["rename"] failed: forbidden']);
    expect(log.all().find((e) => e.kind === 'query')?.data).toMatchObject({ queryHash: expect.stringContaining('explode') });
    again();
    stop();
  });
});
