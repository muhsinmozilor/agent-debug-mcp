# Tool reference

_Generated from the `descriptors.ts` modules — do not edit by hand._

Every tool below also accepts an optional `tab` (string, `t<id>` from `tabs_list`) injected by the relay; it is
required only when more than one tab is attached. Tools marked **mutation** are gated per origin.
Results arrive as JSON text plus `structuredContent` = `{ tab, doc, result }`; errors as `{ error: ToolError }`.

## Prompts

The relay also serves MCP **prompts** — the debugging loop (reproduce → locate → inspect → fix → verify) as an exact
tool sequence. Pick them from your client's prompt list (Claude Code: `/mcp__<server>__<prompt>`). All arguments are optional strings.

### `debug_rerender` — Why does this component re-render?
Find out why a React component renders more often than it should, locate the cause in source, fix it and verify with the profiler. Uses react_find_by_dom / react_search_components, react_inspect_element, react_profile_*, react_watch_renders, react_get_source; the built-in page_* browser tools for the trigger.

- `target` — CSS selector of the rendered element (e.g. [data-testid="save"]) or a component name regex (e.g. ^TodoList$).
- `trigger` — What makes it re-render (e.g. "typing in the search box", "clicking Save"). Optional.

### `debug_stale_data` — Why is this data stale / missing / wrong?
Diagnose a TanStack Query problem — stale UI after a mutation, data never loading, wrong cache entry — confirm the hypothesis against the live cache, fix and verify. Uses tanstack_query_list_queries / get_query / list_mutations / get_mutation, invalidate / refetch / set_data, then react_find_by_dom → react_get_source.

- `queryKey` — Query key prefix as JSON, e.g. ["todos"] or ["user", 42]. Optional — describe the feature in `symptom` instead.
- `symptom` — What the user sees, e.g. "the list does not update after adding an item". Optional.

### `debug_route` — Why does this route / navigation misbehave?
Diagnose a TanStack Router problem — wrong match, loader error, stuck pending, redirect loop, search-param validation — reproduce it deterministically, fix and verify. Uses tanstack_router_get_state / list_routes / get_match / navigate; page_navigate; react_search_components → react_get_source.

- `path` — The URL or route path involved, e.g. /users/42?tab=posts. Optional.
- `expected` — What should happen, e.g. "renders the user page with posts tab". Optional.

## Relay tools

### `tabs_list`
List attached tabs with url, title, capabilities (`react`, `tanstack_query`, `tanstack_router`), whether mutations are allowed and whether the extension is connected. Call this first. _No parameters._

### `tabs_open` — mutation
Open a URL in a new tab (localhost / 127.0.0.1 / *.local or allowlisted origins) and wait until Agent Debug MCP attached.

| Param | Type | Description |
|---|---|---|
| `url` * | string | Absolute URL to open. |
| `waitForCapability` | `react` \| `tanstack_query` \| `tanstack_router` | Wait until this capability is reported (up to waitMs). |
| `waitMs` | integer | How long to wait for the tab to attach (default `10000`). |

### Browser automation (embedded Playwright MCP)
Screenshots, clicks, typing, navigation, console and network are built in: an embedded
[Playwright MCP](https://github.com/microsoft/playwright-mcp) drives the *same* attached tabs over the relay's own CDP
endpoint, re-exported as `page_*` (renamed from `browser_*` so they never clash with a separately installed
Playwright MCP; parameters are documented upstream). Playwright's `browser_snapshot` is skipped: the relay's own
`page_snapshot` below returns the outline, and its CSS selectors work directly as the `target` of `page_click` /
`page_type`. `--no-playwright` disables these tools; an external CDP client displaces them while connected.

| Tool | Does |
|---|---|
| `page_close` | Close the page |
| `page_resize` | Resize the browser window |
| `page_console_messages` — read-only | Returns all console messages |
| `page_handle_dialog` | Handle a dialog |
| `page_evaluate` | Evaluate JavaScript expression on page or element |
| `page_file_upload` | Upload one or multiple files |
| `page_drop` | Drop files or MIME-typed data onto an element, as if dragged from outside the page. |
| `page_find` — read-only | Search the accessibility snapshot of the current page for text or a regular expression. |
| `page_fill_form` | Fill multiple form fields |
| `page_press_key` | Press a key on the keyboard |
| `page_type` | Type text into editable element |
| `page_navigate` | Navigate to a URL |
| `page_navigate_back` | Go back to the previous page in the history |
| `page_network_requests` — read-only | Returns a numbered list of network requests since loading the page. |
| `page_network_request` — read-only | Returns full details (headers and body) of a single network request, or a single part if `part` is set. |
| `page_run_code_unsafe` | Run a Playwright code snippet. |
| `page_take_screenshot` — read-only | Take a screenshot of the current page. |
| `page_click` | Perform click on a web page |
| `page_drag` | Perform drag and drop between two elements |
| `page_hover` | Hover over element on page |
| `page_select_option` | Select an option in a dropdown |
| `page_tabs` | List, create, close, or select a browser tab. |
| `page_wait_for` — read-only | Wait for text to appear or disappear or a specified time to pass |

## Page / tabs (capability `page`)

### `page_snapshot` — read-only
Compact accessibility-style outline of the page: one line per meaningful element with role, name, state, a CSS selector and the owning React component (`→ Name#elementId`). One call gives both an automation target (selector) and the component to inspect (elementId). Prefer this over react_get_tree to orient on what the user sees.

| Param | Type | Description |
|---|---|---|
| `selector` | string | Root element to outline (default body). |
| `maxNodes` | integer |  (default `200`) |
| `interactiveOnly` | boolean | Only focusable controls. (default `false`) |
| `format` | `text` \| `json` | `text` = indented outline (fewest tokens). (default `"text"`) |

### `page_get_errors` — read-only
Runtime problems recorded since the document loaded: uncaught exceptions, unhandled rejections, console.error (React ones tagged `react` with the component stack), failed TanStack queries/mutations and router match errors. Use as the verification step after a change or action: pass the previous call's `latestSeq` as `since` to get only what happened in between.

| Param | Type | Description |
|---|---|---|
| `since` | integer | Only entries with seq greater than this (latestSeq from the previous call). |
| `kinds` | array<string> | Default: everything except console.warn. |
| `includeWarnings` | boolean | Include console.warn when `kinds` is not given. (default `false`) |
| `limit` | integer |  (default `50`) |

### `page_highlight`
Draw a temporary highlight overlay around a component (`elementId`) or DOM elements (`selector`) to show the user what you mean. Purely visual.

| Param | Type | Description |
|---|---|---|
| `elementId` | integer | Component id from react_get_tree / react_search_components / react_find_by_dom. |
| `selector` | string | CSS selector (alternative to elementId). |
| `durationMs` | integer |  (default `3000`) |
| `label` | string | Caption shown with the highlight. |

### `page_element_at_point` — read-only
Return the DOM element at viewport coordinates (x, y) and the React component that rendered it, with ancestors.

| Param | Type | Description |
|---|---|---|
| `x` * | number |  |
| `y` * | number |  |

### `page_pick_element`
Pick mode: elements highlight on hover; the next click is captured (not delivered to the app) and returned as DOM element + React component. Blocks until the user clicks, presses Escape, or `timeoutMs` elapses.

| Param | Type | Description |
|---|---|---|
| `timeoutMs` | integer |  (default `60000`) |

_Relay timeout: 305 s._

## React (capability `react`)

### `react_explain` — read-only
One-call summary of the component behind a CSS selector or elementId: props, hooks, contexts, owners, rendered DOM nodes and symbolicated source location. Equivalent to react_find_by_dom + react_inspect_element + react_get_dom_nodes + react_get_source. Start here for "why does this element look/behave like that".

| Param | Type | Description |
|---|---|---|
| `selector` | string | CSS selector of a rendered element (e.g. from page_snapshot). |
| `nth` | integer | Which selector match to use. (default `0`) |
| `elementId` | integer | Component id from react_get_tree / react_search_components / react_find_by_dom. |
| `expand` | array<array> | Paths (relative to {props,state,hooks,context}) to expand in full. |

_Relay timeout: 30 s._

### `react_get_renderers` — read-only
List React renderers on the tab: version, build type (development/production), root count, how the DevTools hook was obtained, and supported capabilities (override, profiling). Call this first if other react_* tools fail.

_No parameters._

### `react_get_tree` — read-only
Mounted React component tree as a paginated pre-order list: id (stable while mounted; used by react_inspect_element and friends), name, kind, key, depth, parentId, childCount. Host elements and wrappers are hidden by default. Deeply nested apps need a higher `maxDepth` (default 6) or a `rootId` start.

| Param | Type | Description |
|---|---|---|
| `rootId` | integer | Subtree root element id (default: all React roots). |
| `maxDepth` | integer |  (default `6`) |
| `maxNodes` | integer |  (default `200`) |
| `cursor` | string |  |
| `filter` | object |  |

### `react_inspect_element` — read-only
Inspect one mounted component: props, class state, hooks (name, value, editable?), contexts, owner chain, raw source location (react_get_source symbolicates) and rendered DOM nodes. Values beyond the budget collapse to `{ "$": "object", "path": [...] }` stubs — pass those paths in `expand` to drill in. Non-JSON values are tagged (`{"$":"date"}`, `{"$":"fn"}`…).

| Param | Type | Description |
|---|---|---|
| `elementId` * | integer | Component id from react_get_tree / react_search_components / react_find_by_dom. |
| `expand` | array<array> | Paths (relative to {props,state,hooks,context}) to expand. |
| `budget` | object | Serialisation budget overrides: depth (default 2), maxKeys (50), maxString (200), maxBytes (32768). |

### `react_search_components` — read-only
Find mounted components by display-name regex and/or a substring of their props preview. Returns ids, names, depth and ancestor chain.

| Param | Type | Description |
|---|---|---|
| `nameRegex` | string | Case-insensitive regex on the display name. |
| `propsContains` | string | Substring that must appear in the props preview. |
| `limit` | integer |  (default `25`) |

### `react_find_by_dom` — read-only
Resolve a CSS selector to the React component(s) that rendered it: nearest composite component id/name plus ancestors. Up to 10 matches unless `nth` picks one.

| Param | Type | Description |
|---|---|---|
| `selector` * | string | CSS selector, e.g. `[data-testid="save"]` or `main button`. |
| `nth` | integer | Zero-based index among matches. |

### `react_get_dom_nodes` — read-only
List the host DOM nodes a component renders (tag, unique CSS selector, bounding rect, text preview).

| Param | Type | Description |
|---|---|---|
| `elementId` * | integer | Component id from react_get_tree / react_search_components / react_find_by_dom. |

### `react_get_source` — read-only
Where a component is defined and where its JSX was created: file, line, column, function name — symbolicated through source maps when the dev server serves them. Also returns the raw bundle frame and the owner stack.

| Param | Type | Description |
|---|---|---|
| `elementId` * | integer | Component id from react_get_tree / react_search_components / react_find_by_dom. |

_Relay timeout: 30 s._

### `react_override_value` — mutation
Set a value inside a mounted component and re-render it, like editing in React DevTools. `kind`: "props", "hooks" (path starts with the hook index from react_inspect_element; only useState/useReducer are editable) or "state" (class components). `value` accepts JSON or tagged values ({"$":"date","iso":…}, {"$":"undefined"}…). Requires a dev React build and the per-origin mutation toggle.

| Param | Type | Description |
|---|---|---|
| `elementId` * | integer | Component id from react_get_tree / react_search_components / react_find_by_dom. |
| `kind` * | `props` \| `hooks` \| `state` |  |
| `path` * | array<string,integer> | Path within the store, e.g. ["items", 0, "label"] or [0] for hook #0. |
| `value` * | any | New value (JSON or tagged). |

### `react_force_rerender` — mutation
Schedule an update on a component subtree without changing props or state (e.g. to observe with react_watch_renders).

| Param | Type | Description |
|---|---|---|
| `elementId` * | integer | Component id from react_get_tree / react_search_components / react_find_by_dom. |

### `react_profile_start`
Start recording React commits: which components rendered, self render time (dev builds), and WHY — changed prop keys, changed hook indices, class state, context, first mount, or "parent" (only because a parent did). Interact, then react_profile_stop for a summary and react_profile_get_commits for details.

| Param | Type | Description |
|---|---|---|
| `recordChangeDescriptions` | boolean |  (default `true`) |

### `react_profile_stop`
Stop profiling and summarise: commit count, total duration, render-cause histogram, hottest and most-rendered components with their most-changed props. Data stays available for react_profile_get_commits unless keepData=false.

| Param | Type | Description |
|---|---|---|
| `keepData` | boolean |  (default `true`) |

### `react_profile_get_commits` — read-only
Page through the commits of the last profile: timestamp, duration, per-component render records (id, name, phase, causes, changedProps, changedHooks, selfDurationMs).

| Param | Type | Description |
|---|---|---|
| `cursor` | string |  |
| `limit` | integer |  (default `20`) |
| `minDurationMs` | number |  |
| `component` | string | Component-name regex filter. |

### `react_watch_renders` — read-only
Block for `durationMs` (default 10 s) recording commits while you or the user interact, then return a digest: render-cause histogram, hottest components and a compact timeline like `Counter(props)`, `List(parent)`. Catches unnecessary re-renders. Cancel any time.

| Param | Type | Description |
|---|---|---|
| `durationMs` | integer |  (default `10000`) |
| `filter` | object |  |
| `maxEvents` | integer | Stop early after this many renders. (default `500`) |

_Relay timeout: 310 s._

## TanStack Query (capability `tanstack_query`)

### `tanstack_query_list_queries` — read-only
List queries in the TanStack Query cache with a compact summary each: queryKey, queryHash, status, fetchStatus, isStale, isInvalidated, observer count, dataUpdatedAt, error and a short data preview. Use tanstack_query_get_query for full data.

| Param | Type | Description |
|---|---|---|
| `queryKeyPrefix` | array | Array prefix match, e.g. ["users"]. |
| `status` | `pending` \| `error` \| `success` \| `loading` |  |
| `fetchStatus` | `fetching` \| `paused` \| `idle` |  |
| `stale` | boolean | true = only stale queries; false = only fresh. |
| `active` | boolean | true = only queries with observers. |
| `limit` | integer |  (default `50`) |
| `cursor` | string |  |

### `tanstack_query_get_query` — read-only
Full detail of one query by `queryHash` (preferred, from list_queries) or exact `queryKey`: state, options (staleTime, gcTime, enabled…), observers, staleness. Data collapses beyond the budget — `expand` paths (relative to {state, options, data}) drill in.

| Param | Type | Description |
|---|---|---|
| `queryHash` | string |  |
| `queryKey` | array | Query key array, e.g. ["users", {"page": 1}]. |
| `expand` | array<array> |  |
| `budget` | object | Serialisation budget overrides: depth (default 2), maxKeys (50), maxString (200), maxBytes (32768). |

### `tanstack_query_list_mutations` — read-only
List mutations in the MutationCache: mutationId, mutationKey, status, submittedAt, failureCount, isPaused and a variables preview.

| Param | Type | Description |
|---|---|---|
| `status` | `idle` \| `pending` \| `success` \| `error` \| `loading` |  |
| `limit` | integer |  (default `50`) |
| `cursor` | string |  |

### `tanstack_query_get_mutation` — read-only
Full detail of one mutation by `mutationId`: state (variables, data, error, context, status…) and options (mutationKey, retry, meta). Use `expand` for collapsed values.

| Param | Type | Description |
|---|---|---|
| `mutationId` * | integer |  |
| `expand` | array<array> |  |
| `budget` | object | Serialisation budget overrides: depth (default 2), maxKeys (50), maxString (200), maxBytes (32768). |

### `tanstack_query_invalidate` — mutation
Mark matching queries stale (`queryClient.invalidateQueries`) and refetch the active ones (`refetchType`, default "active"). Returns the affected query hashes.

| Param | Type | Description |
|---|---|---|
| `queryKey` | array | Query key (prefix match unless exact=true). Omit to target all queries. |
| `exact` | boolean |  (default `false`) |
| `type` | `all` \| `active` \| `inactive` |  (default `"all"`) |
| `stale` | boolean |  |
| `refetchType` | `active` \| `inactive` \| `all` \| `none` |  (default `"active"`) |

### `tanstack_query_refetch` — mutation
Refetch matching queries (`queryClient.refetchQueries`) and wait up to `waitMs` for them to settle. Returns per-query status after the refetch.

| Param | Type | Description |
|---|---|---|
| `queryKey` | array | Query key (prefix match unless exact=true). Omit to target all queries. |
| `exact` | boolean |  (default `false`) |
| `type` | `all` \| `active` \| `inactive` |  (default `"all"`) |
| `stale` | boolean |  |
| `waitMs` | integer |  (default `15000`) |

_Relay timeout: 70 s._

### `tanstack_query_set_data` — mutation
Replace the cached data of one query (`queryClient.setQueryData`) — e.g. to simulate a server response. `data` accepts JSON or tagged values ({"$":"date"}, {"$":"map"}…). Observers re-render immediately.

| Param | Type | Description |
|---|---|---|
| `queryKey` * | array | Query key array, e.g. ["users", {"page": 1}]. |
| `data` * | any | New data (JSON or tagged). |
| `updatedAt` | integer | Override dataUpdatedAt (ms since epoch). |

### `tanstack_query_remove` — mutation
mode "remove": drop matching queries from the cache (`removeQueries`). mode "reset": reset them to initial state and refetch active ones (`resetQueries`).

| Param | Type | Description |
|---|---|---|
| `queryKey` | array | Query key (prefix match unless exact=true). Omit to target all queries. |
| `exact` | boolean |  (default `false`) |
| `type` | `all` \| `active` \| `inactive` |  (default `"all"`) |
| `stale` | boolean |  |
| `mode` | `remove` \| `reset` |  (default `"remove"`) |

## TanStack Router (capability `tanstack_router`)

### `tanstack_router_get_state` — read-only
Current TanStack Router state: status, isLoading, location, resolvedLocation and the active matches (routeId, params, search, status, error…). Use tanstack_router_get_match for loaderData/context of one match. `expand` paths are relative to {location, matches}.

| Param | Type | Description |
|---|---|---|
| `expand` | array<array> |  |
| `budget` | object | Serialisation budget overrides: depth (default 2), maxKeys (50), maxString (200), maxBytes (32768). |

### `tanstack_router_list_routes` — read-only
Flat list of the route tree: routeId, path, fullPath, parentId, isRoot, and which options are defined (loader, beforeLoad, validateSearch, component, lazy).

| Param | Type | Description |
|---|---|---|
| `cursor` | string |  |
| `limit` | integer |  (default `200`) |

### `tanstack_router_get_match` — read-only
Detail of one active match by `matchId` or `routeId`: params, search, loaderData, loaderDeps, context, status, error, cause, updatedAt. `expand` paths are relative to {loaderData, context, params, search}.

| Param | Type | Description |
|---|---|---|
| `matchId` | string |  |
| `routeId` | string |  |
| `expand` | array<array> |  |
| `budget` | object | Serialisation budget overrides: depth (default 2), maxKeys (50), maxString (200), maxBytes (32768). |

### `tanstack_router_navigate` — mutation
Call `router.navigate({ to, params, search, hash, replace })` and wait (up to `waitMs`) for the router to settle (status idle). Returns the resulting location and matches.

| Param | Type | Description |
|---|---|---|
| `to` * | string | Route path or href, e.g. "/users" or "/users/$userId". |
| `params` | object |  |
| `search` | object |  |
| `hash` | string |  |
| `replace` | boolean |  (default `false`) |
| `waitMs` | integer |  (default `10000`) |

_Relay timeout: 70 s._

### `tanstack_router_invalidate` — mutation
Call `router.invalidate()` — re-runs beforeLoad/loader for the current matches — and wait for it to settle.

| Param | Type | Description |
|---|---|---|
| `waitMs` | integer |  (default `10000`) |

_Relay timeout: 70 s._

---
58 tools (23 of them embedded browser tools). `*` = required.
