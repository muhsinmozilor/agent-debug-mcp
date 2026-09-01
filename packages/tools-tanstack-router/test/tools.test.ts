import { createMemoryHistory } from '@tanstack/history';
import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTanstackRouterTools, findRouter } from '../src/index.js';

declare global {
  interface Window {
    __TANSTACK_ROUTER__?: unknown;
  }
}

const ac = new AbortController();
const tools = createTanstackRouterTools({ docId: 'd' });
const call = async (name: string, input: unknown) => tools.find((t) => t.name === name)!.execute(input, { signal: ac.signal });

let router: ReturnType<typeof createRouter>;
let loads = 0;
beforeEach(async () => {
  const rootRoute = createRootRoute();
  const index = createRoute({ getParentRoute: () => rootRoute, path: '/' });
  const users = createRoute({
    getParentRoute: () => rootRoute,
    path: '/users',
    validateSearch: (s: Record<string, unknown>) => ({ page: Number(s.page ?? 1) }),
  });
  const user = createRoute({
    getParentRoute: () => users,
    path: '$userId',
    loader: async ({ params }) => {
      loads++;
      return { id: params.userId, name: `user-${params.userId}`, meta: { deep: { x: 1 } } };
    },
  });
  router = createRouter({ routeTree: rootRoute.addChildren([index, users.addChildren([user])]), history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  window.__TANSTACK_ROUTER__ = router;
});
afterEach(() => {
  delete window.__TANSTACK_ROUTER__;
  loads = 0;
});

describe('discovery', () => {
  it('finds the router under either global', () => {
    expect(findRouter()).toBe(router);
    delete window.__TANSTACK_ROUTER__;
    (window as unknown as { router?: unknown }).router = router;
    expect(findRouter()).toBe(router);
    delete (window as unknown as { router?: unknown }).router;
    expect(findRouter()).toBeNull();
  });
  it('errors with the opt-in hint when absent', async () => {
    delete window.__TANSTACK_ROUTER__;
    await expect(call('tanstack_router_get_state', {})).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
  });
});

describe('router tools', () => {
  it('get_state and list_routes', async () => {
    const s = (await call('tanstack_router_get_state', {})) as { status: string; location: { pathname: string }; matches: { routeId: string }[] };
    expect(s.status).toBe('idle');
    expect(s.location.pathname).toBe('/');
    expect(s.matches.map((m) => m.routeId)).toEqual(['__root__', '/']);
    const routes = (await call('tanstack_router_list_routes', {})) as { items: { routeId: string; parentId: string | null; has: { loader: boolean; validateSearch: boolean } }[]; total: number };
    expect(routes.total).toBe(4);
    const user = routes.items.find((r) => r.routeId === '/users/$userId')!;
    expect(user.parentId).toBe('/users');
    expect(user.has.loader).toBe(true);
    expect(routes.items.find((r) => r.routeId === '/users')!.has.validateSearch).toBe(true);
  });

  it('navigate waits for loaders and get_match exposes loaderData with expand', async () => {
    const nav = (await call('tanstack_router_navigate', { to: '/users/$userId', params: { userId: '42' }, search: { page: 3 }, waitMs: 5000 })) as {
      settled: boolean;
      location: { pathname: string; search: unknown };
      matches: { routeId: string; status: string; hasLoaderData: boolean }[];
    };
    expect(nav.settled).toBe(true);
    expect(nav.location.pathname).toBe('/users/42');
    expect(nav.location.search).toEqual({ page: 3 });
    const leaf = nav.matches.find((m) => m.routeId === '/users/$userId')!;
    expect(leaf.status).toBe('success');
    expect(leaf.hasLoaderData).toBe(true);
    expect(loads).toBe(1);

    const match = (await call('tanstack_router_get_match', { routeId: '/users/$userId', expand: [['loaderData', 'meta', 'deep']] })) as {
      params: unknown;
      loaderData: { id: string; name: string; meta: unknown };
      expanded: { value: unknown }[];
    };
    expect(match.params).toEqual({ userId: '42' });
    expect(match.loaderData.name).toBe('user-42');
    expect(match.expanded[0]!.value).toEqual({ x: 1 });

    const inv = (await call('tanstack_router_invalidate', { waitMs: 5000 })) as { settled: boolean };
    expect(inv.settled).toBe(true);
    expect(loads).toBe(2);
    await expect(call('tanstack_router_get_match', { routeId: '/nope' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('captureRouterErrors', () => {
  it('records loader errors once per match', async () => {
    const { ErrorLog } = await import('@devtools-mcp/protocol');
    const { captureRouterErrors } = await import('../src/errors.js');
    const rootRoute = createRootRoute();
    const boom = createRoute({ getParentRoute: () => rootRoute, path: '/boom', loader: async () => { throw new Error('loader died'); } });
    const r = createRouter({ routeTree: rootRoute.addChildren([boom]), history: createMemoryHistory({ initialEntries: ['/'] }), defaultPendingMinMs: 0 });
    await r.load();
    const log = new ErrorLog();
    captureRouterErrors(log, r as never);
    await r.navigate({ to: '/boom' });
    await new Promise((res) => setTimeout(res, 100));
    const entry = log.all().find((e) => e.kind === 'router');
    expect(entry, JSON.stringify(r.state.matches.map((m) => [m.routeId, m.status]))).toBeDefined();
    expect(entry!.message).toContain('loader died');
    expect(entry!.data).toMatchObject({ routeId: '/boom', pathname: '/boom' });
    expect(log.all().filter((e) => e.kind === 'router')).toHaveLength(1);
  });
});
