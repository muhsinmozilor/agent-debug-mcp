# agent-debug-mcp

Local MCP server that bridges the **Agent Debug MCP Chrome extension** to coding agents. It exposes the
React DevTools / TanStack Query / TanStack Router runtime state of your dev tabs as MCP tools over
**stdio** and **streamable HTTP** at the same time — with browser automation built in: an embedded
[Playwright MCP](https://github.com/microsoft/playwright-mcp) drives the same tabs, re-exported as `page_*` tools.

```bash
npx agent-debug-mcp            # 127.0.0.1:9333
```

## Chrome extension

The relay needs its companion extension in Chrome:
[**agent-debug-mcp-0.1.8-chrome.zip**](https://github.com/muhsinmozilor/agent-debug-mcp/raw/main/releases/agent-debug-mcp-0.1.8-chrome.zip)
— unzip it, then Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → the unzipped
folder. (Or build from [source](https://github.com/muhsinmozilor/agent-debug-mcp): `pnpm --filter @devtools-mcp/extension build`.)

With the extension loaded, Chrome pairs by itself (the extension polls `127.0.0.1:9333/pair.json`); for another
host/port enter it in the extension popup or open `http://<host>:<port>/pair` once. Then point your agent at it:

- **Claude Code** — `.mcp.json`: `{"mcpServers":{"agent-debug":{"command":"npx","args":["-y","agent-debug-mcp"]}}}`
  or `{"type":"http","url":"http://127.0.0.1:9333/mcp"}` when the relay is already running.
- **Cursor** — same JSON in `.cursor/mcp.json`. **Codex** — `[mcp_servers."agent-debug"] command="npx" args=["-y","agent-debug-mcp"]`.

A second stdio launch while a relay is already running on the port becomes a thin proxy to it, so several
agent sessions share one relay and one browser.

## Tools

| Tool | What it does |
|---|---|
| **Tabs** | |
| `tabs_list` | List attached tabs: url, title, capabilities (`react`, `tanstack_query`, `tanstack_router`), mutation gating, connection. Call this first. |
| `tabs_open` † | Open a URL in a new tab (localhost / allowlisted origins) and wait until it attaches. |
| **Page** | |
| `page_snapshot` | Accessibility-style outline of the page: role, name, state, a CSS selector *and* the owning React component per element. |
| `page_get_errors` | Runtime errors since load: uncaught exceptions, `console.error` with component stacks, error-boundary catches, failed queries/mutations, router errors. |
| `page_highlight` | Draw a temporary highlight overlay around a component or CSS-selector matches. |
| `page_element_at_point` | The DOM element at viewport (x, y) plus the React component that rendered it. |
| `page_pick_element` | Hover-to-highlight pick mode; the user's next click is captured and returned. |
| **React** | |
| `react_explain` | One-call summary of the component behind a DOM element: props, hooks, contexts, owners, rendered DOM, source location. |
| `react_get_renderers` | React version, dev/prod build, root count, how the DevTools hook was obtained, supported capabilities. |
| `react_get_tree` | The mounted component tree as a paginated pre-order list. |
| `react_inspect_element` | One component in depth: props, state, hooks, contexts, owner chain, DOM nodes. |
| `react_search_components` | Find mounted components by display-name regex and/or a props substring. |
| `react_find_by_dom` | CSS selector → the React component(s) that rendered the matching element(s), with ancestors. |
| `react_get_dom_nodes` | The host DOM nodes a component renders (tag, unique selector, rect, text preview). |
| `react_get_source` | Where a component is defined and where its JSX was created (file:line, source-mapped). |
| `react_override_value` † | Set a prop / hook / state value on a mounted component and re-render it. |
| `react_force_rerender` † | Schedule an update on a component subtree without changing props or state. |
| `react_profile_start` / `stop` | Record React commits; `stop` summarises render causes, hottest and most-rendered components. |
| `react_profile_get_commits` | Page through recorded commits: per-component phase, causes, changed props/hooks, timings. |
| `react_watch_renders` | Record for a duration, then return a render digest and a compact timeline (`Counter(props)`, `App(hooks)`, …). |
| **TanStack Query** | |
| `tanstack_query_list_queries` | Every cached query: key, status, fetchStatus, staleness, observers, data preview. |
| `tanstack_query_get_query` | Full detail of one query: state, options, observers. |
| `tanstack_query_list_mutations` | Mutations in the cache: key, status, failure count, variables preview. |
| `tanstack_query_get_mutation` | Full detail of one mutation: state and options. |
| `tanstack_query_invalidate` † | Mark matching queries stale and refetch the active ones. |
| `tanstack_query_refetch` † | Refetch matching queries and wait for them to settle. |
| `tanstack_query_set_data` † | Replace one query's cached data. |
| `tanstack_query_remove` † | Drop matching queries from the cache, or reset them to initial data. |
| **TanStack Router** | |
| `tanstack_router_get_state` | Router status, current location and active matches (params, search, loader state, errors). |
| `tanstack_router_list_routes` | Flat route tree: id, path, parent, which options each route defines (loader, component, …). |
| `tanstack_router_get_match` | One active match in depth: params, search, loaderData, context, error. |
| `tanstack_router_navigate` † | `router.navigate({ to, params, search, … })`, waiting until the router settles. |
| `tanstack_router_invalidate` † | Re-run `beforeLoad`/loaders for the current matches and wait until settled. |

† mutation — gated per origin (extension popup toggle; on by default for localhost).

Plus the **embedded [Playwright MCP](https://github.com/microsoft/playwright-mcp) browser tools**, renamed
`browser_*` → `page_*`: `page_navigate`, `page_click`, `page_type`, `page_take_screenshot`, `page_console_messages`,
`page_network_requests`, `page_evaluate`, `page_tabs`, … (documented upstream; Playwright's `browser_snapshot` is
skipped — `page_snapshot` above is the outline, and its CSS selectors work directly as `page_click` / `page_type`
targets). And three MCP **prompts** that encode whole debugging loops as tool sequences: `debug_rerender`,
`debug_stale_data`, `debug_route`.

Every inspection tool accepts an optional `tab` (from `tabs_list`); it is only required when more than one tab is
attached. The `page_*` browser tools act on their own active page — switch with `page_tabs`. Results are labelled
as untrusted page data.

Full reference with parameters: [docs/TOOLS.md](https://github.com/muhsinmozilor/agent-debug-mcp/blob/main/docs/TOOLS.md).

## Commands

```
agent-debug-mcp                 run the relay (stdio when stdin is not a TTY, plus HTTP)
agent-debug-mcp init            write/merge .mcp.json with the agent-debug relay (browser page_* tools built in)
                                   -o .cursor/mcp.json   --port <n>   --http   --external-playwright
agent-debug-mcp doctor [url]    check relay → extension → CDP → app tab (React/TanStack/mutations); prints fixes
                                   --port <n>   --config <file>   --wait <ms>   --http-token <t>   --no-start
```

## Options

```
-p, --port <n>          default 9333
    --host <addr>       default 127.0.0.1 (anything else exposes your tabs to the network)
    --stdio / --no-stdio
    --no-http           disable /mcp
    --no-cdp            disable /cdp/<token> (connectOverCDP access; also disables the page_* tools)
    --no-playwright     disable the built-in page_* browser tools (embedded Playwright MCP)
    --http-token <t>    require Authorization: Bearer <t> on /mcp
    --allow-extension <id>
    --log-level <l>     debug|info|warn|error (stderr)
```

Config: `~/.agent-debug-mcp/relay.json` (pairing token, CDP token, pinned extension ids; mode 0600). Deleting it is
safe: the extension picks up the new token on its next connection attempt.

## Vite plugin (`agent-debug-mcp/vite`)

Exposes your TanStack Query client and Router to the extension in `vite dev` with no app-code change:

```ts
import { devtoolsMcp } from 'agent-debug-mcp/vite';
export default defineConfig({ plugins: [react(), devtoolsMcp()] }); // options: { query?: boolean; router?: boolean }
```

`npm i -D agent-debug-mcp` provides it; production builds are untouched.

## Browser automation

Built in: the relay runs [Playwright MCP](https://github.com/microsoft/playwright-mcp) in-process against its own CDP
endpoint and re-exports the tools as `page_*` — no second MCP server to configure, and no clash with a separately
installed Playwright MCP (the `browser_*` names stay free). The CDP endpoint (URL printed at startup, also on
`/pair`) remains open for external tooling — `chromium.connectOverCDP(url)`, or `agent-debug-mcp init
--external-playwright` for the classic separate server:

```
npx @playwright/mcp --cdp-endpoint http://127.0.0.1:9333/cdp/<token>
```

One CDP client at a time: an external client displaces the built-in `page_*` tools while connected (they reconnect
on their next call). CSS selectors are the join: `page_snapshot` returns a selector *and* the owning component per
element, and `react_find_by_dom({ selector })` maps anything the browser tools located back to a component.
