import { budgetSchema, pathSchema, type Capability, type ToolAnnotations, type ToolMeta } from '@devtools-mcp/protocol';

const RO: ToolAnnotations = { readOnlyHint: true, untrustedContentHint: true, openWorldHint: false };
const MUT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, untrustedContentHint: true, openWorldHint: false };
const CAP: Capability = 'tanstack_router';

export const routerGetStateMeta: ToolMeta = {
  name: 'tanstack_router_get_state',
  title: 'Router state',
  description:
    'Current TanStack Router state: status, isLoading, location, resolvedLocation and the active matches (routeId, params, ' +
    'search, status, error…). Use tanstack_router_get_match for loaderData/context of one match. `expand` paths are relative to {location, matches}.',
  inputSchema: { type: 'object', properties: { expand: { type: 'array', items: pathSchema }, budget: budgetSchema }, additionalProperties: false },
  annotations: RO,
  capability: CAP,
  mutation: false,
};

export const routerListRoutesMeta: ToolMeta = {
  name: 'tanstack_router_list_routes',
  title: 'List routes',
  description: 'Flat list of the route tree: routeId, path, fullPath, parentId, isRoot, and which options are defined (loader, beforeLoad, validateSearch, component, lazy).',
  inputSchema: { type: 'object', properties: { cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 } }, additionalProperties: false },
  annotations: RO,
  capability: CAP,
  mutation: false,
};

export const routerGetMatchMeta: ToolMeta = {
  name: 'tanstack_router_get_match',
  title: 'Get a route match',
  description: 'Detail of one active match by `matchId` or `routeId`: params, search, loaderData, loaderDeps, context, status, error, cause, updatedAt. `expand` paths are relative to {loaderData, context, params, search}.',
  inputSchema: {
    type: 'object',
    properties: { matchId: { type: 'string' }, routeId: { type: 'string' }, expand: { type: 'array', items: pathSchema }, budget: budgetSchema },
    additionalProperties: false,
  },
  annotations: RO,
  capability: CAP,
  mutation: false,
};

export const routerNavigateMeta: ToolMeta = {
  name: 'tanstack_router_navigate',
  title: 'Navigate',
  description: 'Call `router.navigate({ to, params, search, hash, replace })` and wait (up to `waitMs`) for the router to settle (status idle). Returns the resulting location and matches.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Route path or href, e.g. "/users" or "/users/$userId".' },
      params: { type: 'object', additionalProperties: true },
      search: { type: 'object', additionalProperties: true },
      hash: { type: 'string' },
      replace: { type: 'boolean', default: false },
      waitMs: { type: 'integer', minimum: 0, maximum: 60000, default: 10000 },
    },
    required: ['to'],
    additionalProperties: false,
  },
  annotations: MUT,
  capability: CAP,
  mutation: true,
  timeoutMs: 70_000,
};

export const routerInvalidateMeta: ToolMeta = {
  name: 'tanstack_router_invalidate',
  title: 'Invalidate router',
  description: 'Call `router.invalidate()` — re-runs beforeLoad/loader for the current matches — and wait for it to settle.',
  inputSchema: { type: 'object', properties: { waitMs: { type: 'integer', minimum: 0, maximum: 60000, default: 10000 } }, additionalProperties: false },
  annotations: MUT,
  capability: CAP,
  mutation: true,
  timeoutMs: 70_000,
};

export const tanstackRouterToolMetas: ToolMeta[] = [routerGetStateMeta, routerListRoutesMeta, routerGetMatchMeta, routerNavigateMeta, routerInvalidateMeta];
