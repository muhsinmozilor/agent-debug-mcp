# @devtools-mcp/tools-tanstack-router

TanStack Router tools. The router is discovered on `window.__TANSTACK_ROUTER__` (preferred) or `window.router`
(the name the official debugging docs suggest). Reads `router.state` (`status`, `isLoading`, `matches`,
`location`, `resolvedLocation`) and `router.routesById`; `navigate`/`invalidate` wait for the router to settle.

Read: `tanstack_router_get_state`, `list_routes`, `get_match`. Write (mutation-gated): `navigate`, `invalidate`.
