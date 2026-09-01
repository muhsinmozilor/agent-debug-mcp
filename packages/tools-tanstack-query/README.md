# @devtools-mcp/tools-tanstack-query

TanStack Query tools. The client is discovered through the community convention
`window.__TANSTACK_QUERY_CLIENT__` (TanStack sets no global itself); `watchQueryClient` polls 250 ms for 30 s
and flips the `tanstack_query` capability. Duck-typed access (`QueryClientLike`) works with the page's own
query-core version.

Read: `tanstack_query_list_queries`, `get_query`, `list_mutations`, `get_mutation`.
Write (mutation-gated): `invalidate`, `refetch`, `set_data`, `remove`.
