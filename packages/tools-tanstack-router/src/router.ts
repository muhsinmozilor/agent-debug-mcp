import { DevtoolsError, watchGlobal } from '@devtools-mcp/protocol';

export interface MatchLike {
  id: string;
  routeId: string;
  fullPath?: string;
  index?: number;
  pathname: string;
  params: Record<string, unknown>;
  search: unknown;
  status: string;
  isFetching?: boolean | string;
  error?: unknown;
  paramsError?: unknown;
  searchError?: unknown;
  updatedAt?: number;
  loaderData?: unknown;
  loaderDeps?: unknown;
  context?: unknown;
  cause?: string;
  invalid?: boolean;
  preload?: boolean;
}
export interface LocationLike {
  href: string;
  pathname: string;
  search: unknown;
  searchStr?: string;
  hash: string;
  state?: unknown;
}
export interface RouterStateLike {
  status: string;
  isLoading: boolean;
  matches: MatchLike[];
  pendingMatches?: MatchLike[];
  location: LocationLike;
  resolvedLocation?: LocationLike;
}
export interface RouteLike {
  id: string;
  path?: string;
  fullPath?: string;
  isRoot?: boolean;
  parentRoute?: RouteLike;
  children?: RouteLike[] | Record<string, RouteLike>;
  lazyFn?: unknown;
  options?: Record<string, unknown>;
}
export interface RouterLike {
  state: RouterStateLike;
  routesById: Record<string, RouteLike>;
  routeTree?: RouteLike;
  navigate(opts: Record<string, unknown>): Promise<unknown> | unknown;
  invalidate(opts?: unknown): Promise<unknown> | unknown;
  subscribe?(event: string, cb: (e: unknown) => void): () => void;
  load?(): Promise<unknown>;
}

const GLOBALS = ['__TANSTACK_ROUTER__', 'router'] as const;

export function findRouter(target: typeof globalThis = globalThis): RouterLike | null {
  for (const g of GLOBALS) {
    const r = (target as unknown as Record<string, unknown>)[g];
    if (r && typeof r === 'object' && typeof (r as RouterLike).navigate === 'function' && (r as RouterLike).state && typeof (r as RouterLike).state === 'object' && 'matches' in (r as RouterLike).state) {
      return r as RouterLike;
    }
  }
  return null;
}

export function requireRouter(target: typeof globalThis = globalThis): RouterLike {
  const r = findRouter(target);
  if (!r) {
    throw new DevtoolsError('CAPABILITY_UNAVAILABLE', 'No TanStack Router found on window.__TANSTACK_ROUTER__ (or window.router)', {
      hint: 'In the app entry add: `if (import.meta.env.DEV) window.__TANSTACK_ROUTER__ = router`.',
      data: { capability: 'tanstack_router' },
    });
  }
  return r;
}

export function watchRouter(onChange: (present: boolean) => void, opts: { intervalMs?: number; maxMs?: number; target?: typeof globalThis } = {}): () => void {
  const target = opts.target ?? globalThis;
  return watchGlobal(() => findRouter(target) !== null, onChange, opts);
}

/** Resolve when the router is idle (or after timeoutMs). Returns whether it settled. */
export async function waitForIdle(router: RouterLike, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) return false;
    const s = router.state;
    if (s.status === 'idle' && !s.isLoading && !(s.pendingMatches && s.pendingMatches.length)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  const s = router.state;
  return s.status === 'idle' && !s.isLoading;
}
