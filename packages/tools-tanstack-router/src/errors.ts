/** Feed router match errors (loader / search / params) into the page ErrorLog. Idempotent per router. */
import { describeThrown, type ErrorLog } from '@devtools-mcp/protocol';
import type { MatchLike, RouterLike } from './router.js';

const attached = new WeakSet<object>();

export function captureRouterErrors(log: ErrorLog, router: RouterLike): () => void {
  if (attached.has(router) || typeof router.subscribe !== 'function') return () => undefined;
  attached.add(router);
  const seen = new Set<string>();
  const scan = (): void => {
    const matches = [...(router.state.matches ?? []), ...(router.state.pendingMatches ?? [])];
    for (const m of matches) {
      const problems: [string, unknown][] = [];
      if (m.status === 'error' && m.error !== undefined) problems.push(['loader', m.error]);
      if (m.searchError) problems.push(['search', m.searchError]);
      if (m.paramsError) problems.push(['params', m.paramsError]);
      for (const [what, err] of problems) {
        const key = `${m.id}:${what}:${m.updatedAt ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (seen.size > 500) seen.clear();
        const thrown = describeThrown(err);
        const entry: Parameters<ErrorLog['push']>[0] = {
          kind: 'router',
          message: `Route ${m.routeId} ${what} error at ${m.pathname}: ${thrown.message}`,
          source: `router:${m.routeId}`,
          data: { routeId: m.routeId, pathname: m.pathname, matchId: m.id },
        };
        if (thrown.stack) entry.stack = thrown.stack;
        log.push(entry);
      }
    }
  };
  const unsubs = ['onResolved', 'onLoad', 'onRendered'].map((ev) => {
    try {
      return router.subscribe!(ev, scan);
    } catch {
      return () => undefined;
    }
  });
  scan();
  return () => {
    for (const u of unsubs) u();
    attached.delete(router);
  };
}
