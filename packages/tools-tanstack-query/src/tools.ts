import {
  DevtoolsError,
  decodeCursor,
  defineTool,
  encode,
  encodeCursor,
  expandPaths,
  preview,
  type Enc,
  type EncodeBudget,
  type Page,
  type Path,
  type ToolDefinition,
} from '@devtools-mcp/protocol';
import { requireQueryClient, type MutationLike, type QueryFilters, type QueryLike } from './client.js';
import { getMutationMeta, getQueryMeta, invalidateMeta, listMutationsMeta, listQueriesMeta, refetchMeta, removeMeta, setDataMeta } from './descriptors.js';
import { decode } from '@devtools-mcp/protocol';

export interface ToolContext {
  docId: string;
}

export interface QuerySummary {
  queryKey: Enc;
  queryHash: string;
  status: string;
  fetchStatus: string | null;
  isStale: boolean | null;
  isActive: boolean | null;
  isInvalidated: boolean;
  observers: number;
  dataUpdatedAt: number;
  errorUpdatedAt: number | null;
  fetchFailureCount: number | null;
  error: Enc | null;
  dataPreview: string;
  staleTime: Enc | null;
  gcTime: Enc | null;
}

function keyStartsWith(key: readonly unknown[], prefix: unknown[]): boolean {
  if (prefix.length > key.length) return false;
  for (let i = 0; i < prefix.length; i++) if (stable(key[i]) !== stable(prefix[i])) return false;
  return true;
}
function stable(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val: unknown) =>
      val && typeof val === 'object' && !Array.isArray(val)
        ? Object.keys(val as object)
            .sort()
            .reduce<Record<string, unknown>>((acc, k) => ((acc[k] = (val as Record<string, unknown>)[k]), acc), {})
        : val,
    );
  } catch {
    return String(v);
  }
}

function summarise(q: QueryLike): QuerySummary {
  const s = q.state;
  return {
    queryKey: encode(q.queryKey, { depth: 3, maxKeys: 20, maxString: 100 }).value,
    queryHash: q.queryHash,
    status: s.status,
    fetchStatus: s.fetchStatus ?? null,
    isStale: safe(() => q.isStale?.() ?? null),
    isActive: safe(() => q.isActive?.() ?? (q.observers?.length ?? 0) > 0),
    isInvalidated: !!s.isInvalidated,
    observers: safe(() => q.getObserversCount?.() ?? q.observers?.length ?? 0) ?? 0,
    dataUpdatedAt: s.dataUpdatedAt,
    errorUpdatedAt: typeof s.errorUpdatedAt === 'number' ? (s.errorUpdatedAt as number) : null,
    fetchFailureCount: typeof s.fetchFailureCount === 'number' ? (s.fetchFailureCount as number) : null,
    error: s.error == null ? null : encode(s.error, { depth: 1, maxString: 300 }).value,
    dataPreview: preview(s.data, 120),
    staleTime: q.options.staleTime === undefined ? null : encode(q.options.staleTime, { depth: 1 }).value,
    gcTime: q.options.gcTime === undefined ? null : encode(q.options.gcTime, { depth: 1 }).value,
  };
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

function paginate<T, U>(all: T[], opts: { limit?: number; cursor?: string; docId: string; kind: 'queries' | 'mutations' }, map: (t: T) => U): Page<U> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  let start = 0;
  if (opts.cursor) {
    const c = decodeCursor(opts.cursor);
    if (!c || c.kind !== opts.kind) throw new DevtoolsError('STALE_CURSOR', 'Invalid cursor');
    if (c.doc !== opts.docId) throw new DevtoolsError('STALE_CURSOR', 'Cursor belongs to a previous document');
    start = Number(c.pos);
  }
  const slice = all.slice(start, start + limit);
  const page: Page<U> = { items: slice.map(map), total: all.length, truncated: start + limit < all.length };
  if (page.truncated) page.nextCursor = encodeCursor({ doc: opts.docId, kind: opts.kind, gen: 0, pos: start + limit });
  return page;
}

export function createTanstackQueryTools(ctx: ToolContext): ToolDefinition<unknown, unknown>[] {
  const listQueries = defineTool<
    { queryKeyPrefix?: unknown[]; status?: string; fetchStatus?: string; stale?: boolean; active?: boolean; limit?: number; cursor?: string },
    Page<QuerySummary>
  >({
    ...listQueriesMeta,
    execute: (input) => {
      const client = requireQueryClient();
      let all = client.getQueryCache().getAll();
      if (input.queryKeyPrefix) all = all.filter((q) => keyStartsWith(q.queryKey, input.queryKeyPrefix as unknown[]));
      if (input.status) all = all.filter((q) => q.state.status === input.status);
      if (input.fetchStatus) all = all.filter((q) => q.state.fetchStatus === input.fetchStatus);
      if (input.stale !== undefined) all = all.filter((q) => safe(() => q.isStale?.()) === input.stale);
      if (input.active !== undefined) all = all.filter((q) => (safe(() => q.isActive?.() ?? q.observers.length > 0) ?? false) === input.active);
      all = [...all].sort((a, b) => (a.queryHash < b.queryHash ? -1 : a.queryHash > b.queryHash ? 1 : 0));
      return paginate(all, { ...input, docId: ctx.docId, kind: 'queries' }, summarise);
    },
  });

  const getQuery = defineTool<{ queryHash?: string; queryKey?: unknown[]; expand?: Path[]; budget?: Partial<EncodeBudget> }, unknown>({
    ...getQueryMeta,
    execute: ({ queryHash, queryKey, expand, budget }) => {
      const client = requireQueryClient();
      const cache = client.getQueryCache();
      let q: QueryLike | undefined;
      if (queryHash) q = cache.get(queryHash) ?? cache.getAll().find((x) => x.queryHash === queryHash);
      else if (queryKey) {
        const want = stable(queryKey);
        q = cache.getAll().find((x) => stable(x.queryKey) === want);
      } else throw new DevtoolsError('INVALID_INPUT', 'Provide queryHash or queryKey');
      if (!q) {
        throw new DevtoolsError('INVALID_INPUT', `No query found for ${queryHash ?? stable(queryKey)}`, {
          hint: 'Call tanstack_query_list_queries to see current hashes.',
        });
      }
      const b: Partial<EncodeBudget> = { depth: 2, ...(budget ?? {}) };
      const { data, ...stateRest } = q.state;
      const root = { state: stateRest, options: q.options, data };
      const out: Record<string, unknown> = {
        ...summarise(q),
        state: encode(stateRest, b).value,
        options: encode(q.options, { ...b, depth: Math.max(1, (b.depth ?? 2) - 1) }).value,
        data: encode(data, b).value,
        meta: q.meta === undefined ? null : encode(q.meta, b).value,
      };
      if (expand?.length) {
        const ex = expandPaths(root, expand, b);
        out.expanded = ex.expanded;
        out.missing = ex.missing;
      }
      return out;
    },
  });

  const listMutations = defineTool<{ status?: string; limit?: number; cursor?: string }, Page<unknown>>({
    ...listMutationsMeta,
    execute: (input) => {
      const client = requireQueryClient();
      let all = client.getMutationCache().getAll();
      if (input.status) all = all.filter((m) => m.state.status === input.status);
      all = [...all].sort((a, b) => a.mutationId - b.mutationId);
      return paginate(all, { ...input, docId: ctx.docId, kind: 'mutations' }, (m: MutationLike) => ({
        mutationId: m.mutationId,
        mutationKey: m.options.mutationKey === undefined ? null : encode(m.options.mutationKey, { depth: 3 }).value,
        status: m.state.status,
        submittedAt: m.state.submittedAt ?? null,
        failureCount: m.state.failureCount ?? null,
        isPaused: !!m.state.isPaused,
        variablesPreview: preview(m.state.variables, 120),
        error: m.state.error == null ? null : encode(m.state.error, { depth: 1, maxString: 300 }).value,
      }));
    },
  });

  const getMutation = defineTool<{ mutationId: number; expand?: Path[]; budget?: Partial<EncodeBudget> }, unknown>({
    ...getMutationMeta,
    execute: ({ mutationId, expand, budget }) => {
      const client = requireQueryClient();
      const m = client.getMutationCache().getAll().find((x) => x.mutationId === mutationId);
      if (!m) throw new DevtoolsError('INVALID_INPUT', `No mutation with id ${mutationId}`, { hint: 'Call tanstack_query_list_mutations.' });
      const b: Partial<EncodeBudget> = { depth: 2, ...(budget ?? {}) };
      const root = { state: m.state, options: m.options };
      const out: Record<string, unknown> = {
        mutationId: m.mutationId,
        state: encode(m.state, b).value,
        options: encode(m.options, { ...b, depth: Math.max(1, (b.depth ?? 2) - 1) }).value,
      };
      if (expand?.length) {
        const ex = expandPaths(root, expand, b);
        out.expanded = ex.expanded;
        out.missing = ex.missing;
      }
      return out;
    },
  });

  type FilterInput = { queryKey?: unknown[]; exact?: boolean; type?: 'all' | 'active' | 'inactive'; stale?: boolean };
  const toFilters = (i: FilterInput): QueryFilters => {
    const f: QueryFilters = {};
    if (i.queryKey) f.queryKey = i.queryKey;
    if (i.exact !== undefined) f.exact = i.exact;
    if (i.type) f.type = i.type;
    if (i.stale !== undefined) f.stale = i.stale;
    return f;
  };
  const affected = (qs: QueryLike[]) => qs.map((q) => ({ queryHash: q.queryHash, status: q.state.status, fetchStatus: q.state.fetchStatus ?? null }));

  const invalidate = defineTool<FilterInput & { refetchType?: 'active' | 'inactive' | 'all' | 'none' }, unknown>({
    ...invalidateMeta,
    execute: async (input) => {
      const client = requireQueryClient();
      const filters = toFilters(input);
      const targets = client.getQueryCache().findAll(filters);
      await client.invalidateQueries({ ...filters, refetchType: input.refetchType ?? 'active' });
      return { invalidated: targets.length, queries: affected(targets) };
    },
  });

  const refetch = defineTool<FilterInput & { waitMs?: number }, unknown>({
    ...refetchMeta,
    execute: async (input, { signal }) => {
      const client = requireQueryClient();
      const filters = toFilters(input);
      const targets = client.getQueryCache().findAll(filters);
      const waitMs = input.waitMs ?? 15_000;
      let timedOut = false;
      await Promise.race([
        client.refetchQueries(filters),
        new Promise<void>((r) => setTimeout(() => ((timedOut = true), r()), waitMs)),
        new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true })),
      ]);
      if (signal.aborted) throw new DevtoolsError('CANCELLED', 'Cancelled while refetching');
      return { refetched: targets.length, timedOut, queries: affected(targets) };
    },
  });

  const setData = defineTool<{ queryKey: unknown[]; data: Enc; updatedAt?: number }, unknown>({
    ...setDataMeta,
    execute: ({ queryKey, data, updatedAt }) => {
      const client = requireQueryClient();
      let decoded: unknown;
      try {
        decoded = decode(data);
      } catch (e) {
        throw new DevtoolsError('INVALID_INPUT', `Cannot decode data: ${(e as Error).message}`);
      }
      client.setQueryData(queryKey, decoded, updatedAt !== undefined ? { updatedAt } : undefined);
      const q = client.getQueryCache().findAll({ queryKey, exact: true })[0];
      return { ok: true, query: q ? summarise(q) : null };
    },
  });

  const remove = defineTool<FilterInput & { mode?: 'remove' | 'reset' }, unknown>({
    ...removeMeta,
    execute: async (input) => {
      const client = requireQueryClient();
      const filters = toFilters(input);
      const targets = client.getQueryCache().findAll(filters);
      const hashes = targets.map((q) => q.queryHash);
      if ((input.mode ?? 'remove') === 'reset') await client.resetQueries(filters);
      else client.removeQueries(filters);
      return { mode: input.mode ?? 'remove', affected: hashes.length, queryHashes: hashes };
    },
  });

  return [listQueries, getQuery, listMutations, getMutation, invalidate, refetch, setData, remove] as unknown as ToolDefinition<unknown, unknown>[];
}
