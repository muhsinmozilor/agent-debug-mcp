/**
 * Agent Debug MCP Vite plugin — `import { devtoolsMcp } from 'agent-debug-mcp/vite'`. Built as its own entry with
 * `vite` external; it must not import anything from the relay so Vite's config bundle stays tiny.
 *
 * TanStack exposes nothing globally, so Agent Debug MCP normally needs the app to run
 * `window.__TANSTACK_QUERY_CLIENT__ = queryClient` / `window.__TANSTACK_ROUTER__ = router` in dev. This plugin does
 * it for you: in `vite dev` it aliases `@tanstack/react-query` and `@tanstack/react-router` to thin wrappers whose
 * `QueryClient` / `createRouter` register the instance on `window` (the same convention the community devtools use).
 * Production builds are untouched (`apply: 'serve'`).
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

export interface DevtoolsMcpOptions {
  /** Expose `QueryClient` instances from `@tanstack/react-query` (default true). */
  query?: boolean;
  /** Expose routers created with `createRouter` from `@tanstack/react-router` (default true). */
  router?: boolean;
}

export const QUERY_MODULE = '@tanstack/react-query';
export const ROUTER_MODULE = '@tanstack/react-router';
const VIRTUAL_QUERY = '\0devtools-mcp/tanstack-query';
const VIRTUAL_ROUTER = '\0devtools-mcp/tanstack-router';

const QUERY_WRAPPER = `export * from ${JSON.stringify(QUERY_MODULE)};
import { QueryClient as __DtmcpBaseQueryClient } from ${JSON.stringify(QUERY_MODULE)};
/** Agent Debug MCP: registers the client for the extension (dev only). */
export class QueryClient extends __DtmcpBaseQueryClient {
  constructor(...args) {
    super(...args);
    if (typeof window !== 'undefined') window.__TANSTACK_QUERY_CLIENT__ = this;
  }
}
`;

const ROUTER_WRAPPER = `export * from ${JSON.stringify(ROUTER_MODULE)};
import { createRouter as __dtmcpCreateRouter } from ${JSON.stringify(ROUTER_MODULE)};
/** Agent Debug MCP: registers the router for the extension (dev only). */
export function createRouter(...args) {
  const router = __dtmcpCreateRouter(...args);
  if (typeof window !== 'undefined') window.__TANSTACK_ROUTER__ = router;
  return router;
}
`;

/** Is `pkg` resolvable from `root`? Walks node_modules up the tree like Node does (without NODE_PATH surprises). */
function installed(root: string, pkg: string): boolean {
  let dir = root;
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, 'node_modules', pkg, 'package.json'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

export function devtoolsMcp(options: DevtoolsMcpOptions = {}): Plugin {
  const wantQuery = options.query !== false;
  const wantRouter = options.router !== false;
  let query = wantQuery;
  let router = wantRouter;
  return {
    name: 'Agent Debug MCP',
    apply: 'serve',
    enforce: 'pre',
    config(config, env) {
      if (env.command !== 'serve') return;
      const root = config.root ?? process.cwd();
      query = wantQuery && installed(root, QUERY_MODULE);
      router = wantRouter && installed(root, ROUTER_MODULE);
      const include = [query ? QUERY_MODULE : null, router ? ROUTER_MODULE : null].filter((x): x is string => !!x);
      // The wrappers import the real packages at runtime; pre-bundle them up front so the first page load does not
      // trigger a "new dependencies optimized" reload.
      return include.length ? { optimizeDeps: { include } } : undefined;
    },
    resolveId(source, importer) {
      if (query && source === QUERY_MODULE && importer !== VIRTUAL_QUERY) return VIRTUAL_QUERY;
      if (router && source === ROUTER_MODULE && importer !== VIRTUAL_ROUTER) return VIRTUAL_ROUTER;
      return null;
    },
    load(id) {
      if (id === VIRTUAL_QUERY) return QUERY_WRAPPER;
      if (id === VIRTUAL_ROUTER) return ROUTER_WRAPPER;
      return null;
    },
  };
}

export default devtoolsMcp;
