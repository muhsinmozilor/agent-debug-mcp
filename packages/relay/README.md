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
[**agent-debug-mcp-0.1.6-chrome.zip**](https://github.com/muhsinmozilor/agent-debug-mcp/raw/main/releases/agent-debug-mcp-0.1.6-chrome.zip)
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

`tabs_list`, `tabs_open`, `page_snapshot`, `page_get_errors`, `page_highlight`, `page_element_at_point`, `page_pick_element`,
`react_explain`, `react_get_renderers`, `react_get_tree`, `react_inspect_element`, `react_search_components`,
`react_find_by_dom`, `react_get_dom_nodes`, `react_get_source`, `react_override_value`, `react_force_rerender`,
`react_profile_start|stop|get_commits`, `react_watch_renders`,
`tanstack_query_list_queries|get_query|list_mutations|get_mutation|invalidate|refetch|set_data|remove`,
`tanstack_router_get_state|list_routes|get_match|navigate|invalidate` — plus the **embedded Playwright MCP browser
tools**, renamed `browser_*` → `page_*`: `page_navigate`, `page_click`, `page_type`, `page_take_screenshot`,
`page_console_messages`, `page_network_requests`, `page_evaluate`, `page_tabs`, … (Playwright's `browser_snapshot` is
skipped: `page_snapshot` above is the outline, and its CSS selectors work directly as `page_click`/`page_type`
targets).

Every inspection tool accepts an optional `tab` (from `tabs_list`); it is only required when more than one tab is
attached. The `page_*` browser tools act on their own active page — switch with `page_tabs`. Results are labelled
as untrusted page data.

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
