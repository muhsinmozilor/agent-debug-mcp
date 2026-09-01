# Tool map — who does what

One MCP server, one set of Chrome tabs. The browser-automation tools (`page_click`, `page_navigate`,
`page_take_screenshot`, …) are an **embedded Playwright MCP** renamed `browser_*` → `page_*` (so a separately
installed Playwright MCP never clashes); everything else is native Agent Debug MCP. Full parameter tables:
[`TOOLS.md`](TOOLS.md) (generated).

```
agent ──► agent-debug-mcp ──► extension ──► React fibers / TanStack / DOM                    (inspect & mutate state)
              └─► embedded @playwright/mcp ──► own /cdp/<token> ──► chrome.debugger ──► same tabs  (see, click, type, navigate)
```

`agent-debug-mcp init` writes the single server entry into `.mcp.json`; `agent-debug-mcp doctor <url>` checks the chain.

## Agent Debug MCP

Every page-side tool accepts an optional `tab` (from `tabs_list`), required only when several tabs are attached.
**Mutation** tools are gated per origin in the extension popup. Results are untrusted page data.

### Tabs (relay-side)

| Tool | Functionality |
|---|---|
| `tabs_list` | Attached tabs with url, title, capabilities (`react`, `tanstack_query`, `tanstack_router`), mutation gate, extension status. Call first. Tabs the user put into standby (popup "debug only this tab") are not listed. |
| `tabs_open` — mutation | Open a dev-origin URL (localhost / 127.0.0.1 / *.local) in a new tab and wait until Agent Debug MCP attaches (optionally until a capability appears). |

### Page (any attached tab)

| Tool | Functionality |
|---|---|
| `page_snapshot` | Accessibility-style outline: one line per meaningful element with role, name, state, **CSS selector and the React component that rendered it** (`→ Counter#345`). The join between Playwright and React. `interactiveOnly`, `selector` root, `format: json`. |
| `page_get_errors` | Everything that broke since `since=<latestSeq>`: uncaught exceptions, unhandled rejections, console errors, React error-boundary catches (with component stack), failed TanStack queries/mutations, router match errors. The verify step. |
| `page_highlight` | Draw a temporary overlay around a component or selector so the user sees what you mean. |
| `page_element_at_point` | Element and owning component at viewport x/y. |
| `page_pick_element` | Wait for the user to click an element; returns it and its component. |

### React — read

| Tool | Functionality |
|---|---|
| `react_explain` | One call for the component behind a selector / elementId: props, hooks, contexts, owners, ancestors, DOM nodes, symbolicated source. Start here. |
| `react_get_renderers` | React version, build type, roots, how the DevTools hook was obtained. |
| `react_get_tree` | Paginated component tree (ids, names, kinds, depth); host/wrapper nodes hidden by default. |
| `react_inspect_element` | Props / state / hooks / contexts of one component, collapsed stubs with `expand` by path. |
| `react_search_components` | Find components by name regex and/or props substring. |
| `react_find_by_dom` | CSS selector → nearest component + ancestor chain. |
| `react_get_dom_nodes` | Component → host DOM nodes (tag, unique selector, rect, text). |
| `react_get_source` | File / line / column of the component and its owner stack (source-mapped). |

### React — mutate (gated)

| Tool | Functionality |
|---|---|
| `react_override_value` | Set a prop, hook state or class state value (tagged JSON accepted). |
| `react_force_rerender` | Schedule an update on a component. |

### React — profiling

| Tool | Functionality |
|---|---|
| `react_profile_start` / `react_profile_stop` | Record commits (optionally with change descriptions: which props / hooks / context changed). |
| `react_profile_get_commits` | Paginated commits with per-component "why did it render". |
| `react_watch_renders` | Live digest of renders for a duration (cancellable). |

### TanStack Query (needs `window.__TANSTACK_QUERY_CLIENT__` — the Vite plugin sets it)

| Tool | Functionality |
|---|---|
| `tanstack_query_list_queries` | Queries with status, fetchStatus, stale, observers, dataUpdatedAt; filter by key prefix / status. |
| `tanstack_query_get_query` | One query: options (staleTime, gcTime, enabled…), error, data (expandable). |
| `tanstack_query_list_mutations` / `tanstack_query_get_mutation` | Mutations and their variables / data / error. |
| `tanstack_query_invalidate` — mutation | Invalidate (and refetch active) matching queries. |
| `tanstack_query_refetch` — mutation | Refetch matching queries. |
| `tanstack_query_set_data` — mutation | Write cache data for a key (tagged JSON for Dates/Maps…). |
| `tanstack_query_remove` — mutation | Remove queries from the cache. |

### TanStack Router (needs `window.__TANSTACK_ROUTER__`)

| Tool | Functionality |
|---|---|
| `tanstack_router_get_state` | Location, status, matches (params, search, loader status, errors). |
| `tanstack_router_list_routes` | The route tree with paths and ids. |
| `tanstack_router_get_match` | One match: loaderData, error, search, params, cause. |
| `tanstack_router_navigate` — mutation | Navigate (to, params, search, hash) and wait for idle. |
| `tanstack_router_invalidate` — mutation | Re-run loaders. |

### Prompts (not tools)

| Prompt | Encodes |
|---|---|
| `debug_rerender` | locate → explain → profile a trigger → classify → source → fix → re-profile + `page_get_errors` |
| `debug_stale_data` | errors → list/get queries → diagnose → confirm live (invalidate / set_data) → source → fix → verify |
| `debug_route` | errors → router state → routes → match → reproduce → fix → verify |

## Browser tools (embedded Playwright MCP, renamed `browser_*` → `page_*`)

Executed by the embedded `@playwright/mcp` against the relay's own CDP endpoint; the relay carries CDP to the
attached tab. Exact list depends on the bundled `@playwright/mcp` version (generated table in
[`TOOLS.md`](TOOLS.md)). Playwright's `browser_snapshot` is **not** re-exported — the relay's own `page_snapshot`
is the outline, and its CSS selectors work as the `target` of the action tools; `ref=eN` handles appear in every
action result's page state.

| Group | Tools | Functionality |
|---|---|---|
| Navigate / tabs | `page_navigate`, `page_navigate_back`, `page_tabs`, `page_close`, `page_resize` | Go to URLs, switch / open / close Playwright pages (new tabs become Agent Debug MCP tabs on dev origins; `page_tabs` indexes are unrelated to `tabs_list` handles). |
| Observe | `page_take_screenshot`, `page_console_messages`, `page_network_requests`, `page_find` | **Screenshots**, console, network, find elements. |
| Act | `page_click`, `page_type`, `page_fill_form`, `page_press_key`, `page_hover`, `page_drag`, `page_select_option`, `page_file_upload`, `page_handle_dialog`, `page_wait_for` | Interact with elements by `ref` or a unique CSS selector as `target`. |
| Script | `page_evaluate`, `page_run_code_unsafe` | Run JS on the page / Playwright code. |

## Which tool family for what

| Need | Use |
|---|---|
| Screenshot, click, type, navigate, wait, network, dialogs | browser tools (`page_click`, `page_navigate`, …) |
| What is on screen **and** which component renders it | `page_snapshot` — selectors double as `page_click` targets |
| Why does this element look / behave like that | `react_explain` |
| Why does it re-render | `react_profile_*` / `react_watch_renders`, trigger via `page_click` / `page_type` |
| Is the data fresh, what does the cache hold | `tanstack_query_*` |
| Did my change break anything | `page_get_errors` + `page_console_messages` |
| Prove a hypothesis without editing code | `react_override_value`, `tanstack_query_set_data`, `tanstack_router_navigate` |

**Join:** selectors. `page_snapshot` / `react_get_dom_nodes` return CSS selectors usable as `page_click` /
`page_type` targets or in `page_evaluate`; anything the browser tools located maps back with
`react_explain { selector }` / `react_find_by_dom`.
