import { budgetSchema, pathSchema, type Capability, type JsonSchema, type ToolAnnotations, type ToolMeta } from '@devtools-mcp/protocol';

const RO: ToolAnnotations = { readOnlyHint: true, untrustedContentHint: true, openWorldHint: false };
const CAP: Capability = 'tanstack_query';

const queryKeySchema: JsonSchema = { type: 'array', items: {}, description: 'Query key array, e.g. ["users", {"page": 1}].' };

export const listQueriesMeta: ToolMeta = {
  name: 'tanstack_query_list_queries',
  title: 'List TanStack queries',
  description:
    'List queries in the TanStack Query cache with a compact summary each: queryKey, queryHash, status (pending/error/success), ' +
    'fetchStatus (fetching/paused/idle), isStale, isInvalidated, observer count, dataUpdatedAt, error and a short data preview. ' +
    'Filter by `queryKeyPrefix` (array prefix match), `status`, or `stale`. Paginate with `cursor`. Use tanstack_query_get_query for full data.',
  inputSchema: {
    type: 'object',
    properties: {
      queryKeyPrefix: { type: 'array', items: {}, description: 'Only queries whose key starts with this prefix, e.g. ["users"].' },
      status: { type: 'string', enum: ['pending', 'error', 'success', 'loading'] },
      fetchStatus: { type: 'string', enum: ['fetching', 'paused', 'idle'] },
      stale: { type: 'boolean', description: 'true = only stale queries; false = only fresh.' },
      active: { type: 'boolean', description: 'true = only queries with observers.' },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
      cursor: { type: 'string' },
    },
    additionalProperties: false,
  },
  annotations: RO,
  capability: CAP,
  mutation: false,
};

export const getQueryMeta: ToolMeta = {
  name: 'tanstack_query_get_query',
  title: 'Get a TanStack query',
  description:
    'Full detail of one query by `queryHash` (preferred, from list_queries) or exact `queryKey`: state (data, error, ' +
    'dataUpdatedAt, fetch counts…), options (staleTime, gcTime, enabled, retry, meta…), observers, and whether it is stale/active. ' +
    'Cached data is returned collapsed beyond the budget — pass `expand` paths (relative to {state, options, data}) to drill in.',
  inputSchema: {
    type: 'object',
    properties: {
      queryHash: { type: 'string' },
      queryKey: queryKeySchema,
      expand: { type: 'array', items: pathSchema },
      budget: budgetSchema,
    },
    additionalProperties: false,
  },
  annotations: RO,
  capability: CAP,
  mutation: false,
};

export const listMutationsMeta: ToolMeta = {
  name: 'tanstack_query_list_mutations',
  title: 'List TanStack mutations',
  description: 'List mutations in the MutationCache: mutationId, mutationKey, status (idle/pending/success/error), submittedAt, failureCount, isPaused and a variables preview.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['idle', 'pending', 'success', 'error', 'loading'] },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
      cursor: { type: 'string' },
    },
    additionalProperties: false,
  },
  annotations: RO,
  capability: CAP,
  mutation: false,
};

export const getMutationMeta: ToolMeta = {
  name: 'tanstack_query_get_mutation',
  title: 'Get a TanStack mutation',
  description: 'Full detail of one mutation by `mutationId`: state (variables, data, error, context, status…) and options (mutationKey, retry, meta). Use `expand` for collapsed values.',
  inputSchema: {
    type: 'object',
    properties: {
      mutationId: { type: 'integer' },
      expand: { type: 'array', items: pathSchema },
      budget: budgetSchema,
    },
    required: ['mutationId'],
    additionalProperties: false,
  },
  annotations: RO,
  capability: CAP,
  mutation: false,
};

const MUT: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, untrustedContentHint: true, openWorldHint: false };
const filterProps: Record<string, JsonSchema> = {
  queryKey: { ...queryKeySchema, description: 'Query key (prefix match unless exact=true). Omit to target all queries.' },
  exact: { type: 'boolean', default: false },
  type: { type: 'string', enum: ['all', 'active', 'inactive'], default: 'all' },
  stale: { type: 'boolean' },
};

export const invalidateMeta: ToolMeta = {
  name: 'tanstack_query_invalidate',
  title: 'Invalidate queries',
  description: 'Mark matching queries stale (`queryClient.invalidateQueries`) and refetch the active ones (`refetchType`, default "active"). Returns the affected query hashes.',
  inputSchema: {
    type: 'object',
    properties: { ...filterProps, refetchType: { type: 'string', enum: ['active', 'inactive', 'all', 'none'], default: 'active' } },
    additionalProperties: false,
  },
  annotations: MUT,
  capability: CAP,
  mutation: true,
};

export const refetchMeta: ToolMeta = {
  name: 'tanstack_query_refetch',
  title: 'Refetch queries',
  description: 'Refetch matching queries (`queryClient.refetchQueries`) and wait up to `waitMs` for them to settle. Returns per-query status after the refetch.',
  inputSchema: {
    type: 'object',
    properties: { ...filterProps, waitMs: { type: 'integer', minimum: 0, maximum: 60000, default: 15000 } },
    additionalProperties: false,
  },
  annotations: MUT,
  capability: CAP,
  mutation: true,
  timeoutMs: 70_000,
};

export const setDataMeta: ToolMeta = {
  name: 'tanstack_query_set_data',
  title: 'Set query data',
  description: 'Replace the cached data of one query (`queryClient.setQueryData`) — e.g. to simulate a server response. `data` accepts JSON or tagged values ({"$":"date"}, {"$":"map"}…). Observers re-render immediately.',
  inputSchema: {
    type: 'object',
    properties: { queryKey: queryKeySchema, data: { description: 'New data (JSON or tagged).' }, updatedAt: { type: 'integer', description: 'Override dataUpdatedAt (ms since epoch).' } },
    required: ['queryKey', 'data'],
    additionalProperties: false,
  },
  annotations: MUT,
  capability: CAP,
  mutation: true,
};

export const removeMeta: ToolMeta = {
  name: 'tanstack_query_remove',
  title: 'Remove or reset queries',
  description: 'mode "remove": drop matching queries from the cache (`removeQueries`). mode "reset": reset them to initial state and refetch active ones (`resetQueries`).',
  inputSchema: {
    type: 'object',
    properties: { ...filterProps, mode: { type: 'string', enum: ['remove', 'reset'], default: 'remove' } },
    additionalProperties: false,
  },
  annotations: MUT,
  capability: CAP,
  mutation: true,
};

export const tanstackQueryToolMetas: ToolMeta[] = [listQueriesMeta, getQueryMeta, listMutationsMeta, getMutationMeta, invalidateMeta, refetchMeta, setDataMeta, removeMeta];
