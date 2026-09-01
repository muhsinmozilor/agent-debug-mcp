/**
 * QueryClient discovery. TanStack does not expose the client globally; apps opt in with
 * `window.__TANSTACK_QUERY_CLIENT__ = queryClient` (the convention used by the community devtools
 * extension). We poll briefly after load and re-check lazily on each tool call.
 */
import { DevtoolsError, watchGlobal } from '@devtools-mcp/protocol';

/** Structural (duck-typed) view of the parts of QueryClient we use, so the page's own instance works regardless of version. */
export interface QueryLike {
  queryKey: readonly unknown[];
  queryHash: string;
  state: Record<string, unknown> & { status: string; fetchStatus?: string; dataUpdatedAt: number; isInvalidated: boolean; error: unknown; data: unknown };
  options: Record<string, unknown>;
  observers: unknown[];
  isStale?: () => boolean;
  isActive?: () => boolean;
  isDisabled?: () => boolean;
  getObserversCount?: () => number;
  meta?: unknown;
}
export interface MutationLike {
  mutationId: number;
  state: Record<string, unknown> & { status: string; variables?: unknown; data?: unknown; error?: unknown; submittedAt?: number; failureCount?: number; isPaused?: boolean };
  options: Record<string, unknown> & { mutationKey?: unknown };
}
export interface QueryFilters {
  queryKey?: readonly unknown[];
  exact?: boolean;
  type?: 'all' | 'active' | 'inactive';
  stale?: boolean;
}
export interface QueryClientLike {
  getQueryCache(): { getAll(): QueryLike[]; get(hash: string): QueryLike | undefined; findAll(filters?: QueryFilters): QueryLike[]; subscribe(l: (e: unknown) => void): () => void };
  getMutationCache(): { getAll(): MutationLike[]; subscribe(l: (e: unknown) => void): () => void };
  getDefaultOptions?(): unknown;
  invalidateQueries(filters?: QueryFilters & { refetchType?: 'active' | 'inactive' | 'all' | 'none' }): Promise<void>;
  refetchQueries(filters?: QueryFilters): Promise<void>;
  setQueryData(queryKey: readonly unknown[], data: unknown, options?: { updatedAt?: number }): unknown;
  removeQueries(filters?: QueryFilters): void;
  resetQueries(filters?: QueryFilters): Promise<void>;
}

const GLOBAL = '__TANSTACK_QUERY_CLIENT__';

export function findQueryClient(target: typeof globalThis = globalThis): QueryClientLike | null {
  const c = (target as unknown as Record<string, unknown>)[GLOBAL];
  if (c && typeof c === 'object' && typeof (c as QueryClientLike).getQueryCache === 'function') return c as QueryClientLike;
  return null;
}

export function requireQueryClient(target: typeof globalThis = globalThis): QueryClientLike {
  const c = findQueryClient(target);
  if (!c) {
    throw new DevtoolsError('CAPABILITY_UNAVAILABLE', 'No TanStack QueryClient found on window.__TANSTACK_QUERY_CLIENT__', {
      hint: 'In the app entry add: `if (import.meta.env.DEV) window.__TANSTACK_QUERY_CLIENT__ = queryClient`.',
      data: { capability: 'tanstack_query' },
    });
  }
  return c;
}

/**
 * Poll for the client (250 ms, up to `maxMs`) and notify on presence changes. Returns a stop function.
 */
export function watchQueryClient(
  onChange: (present: boolean) => void,
  opts: { intervalMs?: number; maxMs?: number; target?: typeof globalThis } = {},
): () => void {
  const target = opts.target ?? globalThis;
  return watchGlobal(() => findQueryClient(target) !== null, onChange, opts);
}
