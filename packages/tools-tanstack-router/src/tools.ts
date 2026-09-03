import {
  AgentDebugError,
  decodeCursor,
  defineTool,
  encode,
  encodeCursor,
  expandPaths,
  type Enc,
  type EncodeBudget,
  type Page,
  type Path,
  type ToolDefinition,
} from '@devtools-mcp/protocol';
import { routerGetMatchMeta, routerGetStateMeta, routerInvalidateMeta, routerListRoutesMeta, routerNavigateMeta } from './descriptors.js';
import { requireRouter, waitForIdle, type LocationLike, type MatchLike, type RouteLike } from './router.js';

export interface ToolContext {
  docId: string;
}

function summariseMatch(m: MatchLike, b: Partial<EncodeBudget>) {
  return {
    id: m.id,
    routeId: m.routeId,
    fullPath: m.fullPath ?? null,
    pathname: m.pathname,
    params: encode(m.params, { ...b, depth: 2 }).value,
    search: encode(m.search, { ...b, depth: 2 }).value,
    status: m.status,
    isFetching: m.isFetching ?? false,
    hasLoaderData: m.loaderData !== undefined,
    error: m.error == null ? null : encode(m.error, { depth: 1, maxString: 300 }).value,
    invalid: !!m.invalid,
    cause: m.cause ?? null,
    updatedAt: m.updatedAt ?? null,
  };
}

function location(l: LocationLike | undefined, b: Partial<EncodeBudget>) {
  if (!l) return null;
  return { href: l.href, pathname: l.pathname, search: encode(l.search, { ...b, depth: 2 }).value, searchStr: l.searchStr ?? null, hash: l.hash };
}

function snapshot(b: Partial<EncodeBudget>) {
  const router = requireRouter();
  const s = router.state;
  return {
    status: s.status,
    isLoading: s.isLoading,
    location: location(s.location, b),
    resolvedLocation: location(s.resolvedLocation, b),
    matches: s.matches.map((m) => summariseMatch(m, b)),
    pendingMatches: (s.pendingMatches ?? []).map((m) => summariseMatch(m, b)),
  };
}

function flattenRoutes(router: ReturnType<typeof requireRouter>): RouteLike[] {
  const byId = router.routesById ?? {};
  const list = Object.values(byId);
  if (list.length) return list;
  // fallback: walk routeTree
  const out: RouteLike[] = [];
  const walk = (r: RouteLike | undefined): void => {
    if (!r) return;
    out.push(r);
    const ch = r.children;
    if (Array.isArray(ch)) ch.forEach(walk);
    else if (ch && typeof ch === 'object') Object.values(ch).forEach(walk);
  };
  walk(router.routeTree);
  return out;
}

export function createTanstackRouterTools(ctx: ToolContext): ToolDefinition<unknown, unknown>[] {
  const getState = defineTool<{ expand?: Path[]; budget?: Partial<EncodeBudget> }, unknown>({
    ...routerGetStateMeta,
    execute: ({ expand, budget }) => {
      const b = budget ?? {};
      const out: Record<string, unknown> = snapshot(b);
      if (expand?.length) {
        const s = requireRouter().state;
        const ex = expandPaths({ location: s.location, matches: s.matches, resolvedLocation: s.resolvedLocation }, expand, b);
        out.expanded = ex.expanded;
        out.missing = ex.missing;
      }
      return out;
    },
  });

  const listRoutes = defineTool<{ cursor?: string; limit?: number }, Page<unknown>>({
    ...routerListRoutesMeta,
    execute: ({ cursor, limit }) => {
      const router = requireRouter();
      const all = flattenRoutes(router).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const max = Math.min(Math.max(limit ?? 200, 1), 1000);
      let start = 0;
      if (cursor) {
        const c = decodeCursor(cursor);
        if (!c || c.kind !== 'routes' || c.doc !== ctx.docId) throw new AgentDebugError('STALE_CURSOR', 'Invalid or stale cursor');
        start = Number(c.pos);
      }
      const slice = all.slice(start, start + max);
      const page: Page<unknown> = {
        items: slice.map((r) => ({
          routeId: r.id,
          path: r.path ?? null,
          fullPath: r.fullPath ?? null,
          parentId: r.parentRoute?.id ?? null,
          isRoot: !!r.isRoot,
          has: {
            loader: typeof r.options?.loader === 'function' || (typeof r.options?.loader === 'object' && r.options?.loader !== null),
            beforeLoad: typeof r.options?.beforeLoad === 'function',
            validateSearch: r.options?.validateSearch !== undefined,
            component: r.options?.component !== undefined,
            errorComponent: r.options?.errorComponent !== undefined,
            lazy: r.lazyFn !== undefined,
          },
          staleTime: (r.options?.staleTime as number | undefined) ?? null,
        })),
        total: all.length,
        truncated: start + max < all.length,
      };
      if (page.truncated) page.nextCursor = encodeCursor({ doc: ctx.docId, kind: 'routes', gen: 0, pos: start + max });
      return page;
    },
  });

  const getMatch = defineTool<{ matchId?: string; routeId?: string; expand?: Path[]; budget?: Partial<EncodeBudget> }, unknown>({
    ...routerGetMatchMeta,
    execute: ({ matchId, routeId, expand, budget }) => {
      const router = requireRouter();
      const all = [...router.state.matches, ...(router.state.pendingMatches ?? [])];
      const m = matchId ? all.find((x) => x.id === matchId) : routeId ? all.find((x) => x.routeId === routeId) : undefined;
      if (!matchId && !routeId) throw new AgentDebugError('INVALID_INPUT', 'Provide matchId or routeId');
      if (!m) throw new AgentDebugError('INVALID_INPUT', `No active match for ${matchId ?? routeId}`, { hint: 'Call tanstack_router_get_state to see active matches.' });
      const b: Partial<EncodeBudget> = { depth: 2, ...(budget ?? {}) };
      const out: Record<string, unknown> = {
        ...summariseMatch(m, b),
        loaderData: m.loaderData === undefined ? null : encode(m.loaderData, b).value,
        loaderDeps: m.loaderDeps === undefined ? null : encode(m.loaderDeps, b).value,
        context: m.context === undefined ? null : encode(m.context, { ...b, depth: 1 }).value,
        paramsError: m.paramsError == null ? null : encode(m.paramsError, { depth: 1 }).value,
        searchError: m.searchError == null ? null : encode(m.searchError, { depth: 1 }).value,
      };
      if (expand?.length) {
        const ex = expandPaths({ loaderData: m.loaderData, context: m.context, params: m.params, search: m.search }, expand, b);
        out.expanded = ex.expanded;
        out.missing = ex.missing;
      }
      return out;
    },
  });

  const navigate = defineTool<{ to: string; params?: Record<string, unknown>; search?: Record<string, unknown>; hash?: string; replace?: boolean; waitMs?: number }, unknown>({
    ...routerNavigateMeta,
    execute: async ({ to, params, search, hash, replace, waitMs }, { signal }) => {
      const router = requireRouter();
      const opts: Record<string, unknown> = { to };
      if (params) opts.params = params;
      if (search) opts.search = search;
      if (hash !== undefined) opts.hash = hash;
      if (replace) opts.replace = true;
      try {
        await router.navigate(opts);
      } catch (e) {
        throw new AgentDebugError('PAGE_ERROR', `navigate failed: ${(e as Error).message}`);
      }
      const settled = await waitForIdle(router, waitMs ?? 10_000, signal);
      return { settled, ...snapshot({}) };
    },
  });

  const invalidate = defineTool<{ waitMs?: number }, unknown>({
    ...routerInvalidateMeta,
    execute: async ({ waitMs }, { signal }) => {
      const router = requireRouter();
      await router.invalidate();
      const settled = await waitForIdle(router, waitMs ?? 10_000, signal);
      return { settled, ...snapshot({}) };
    },
  });

  return [getState, listRoutes, getMatch, navigate, invalidate] as unknown as ToolDefinition<unknown, unknown>[];
}
