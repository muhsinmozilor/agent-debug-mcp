# Agent Debug MCP

Expose the **React DevTools** and **TanStack Query / Router** state of the app running in your Chrome tab
to coding agents (Claude Code, Cursor, Codex, any MCP client) as MCP tools.

```
Chrome tab (your React app) ──► Agent Debug MCP extension ──► local relay (127.0.0.1:9333) ──► agent (stdio or /mcp)
```

Two parts: a Chrome MV3 extension that reads the page, and `agent-debug-mcp`, a local MCP server the
extension connects to.

## What the agent can do

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

Tools marked † mutate the app; they are gated per origin (toggle in the popup; on by default for localhost). All dev tabs are visible to
the agent by default; the popup's **Debug only this tab** restricts it to one tab (the rest go into standby and
reconnect with one click), and the toolbar icon shows a green dot on every tab the agent can reach.
Full reference: [`docs/TOOLS.md`](docs/TOOLS.md).

Screenshots, clicks, typing and navigation are **not** re-implemented here: the relay exposes the attached tabs as a
Chrome DevTools Protocol endpoint; an embedded [Playwright MCP](https://github.com/microsoft/playwright-mcp) (re-exported as `page_*` tools) and any external CDP client drive the same
tabs — see [Browser automation](#browser-automation).

## Setup

**1. Build and load the extension**

```bash
pnpm install
pnpm --filter @devtools-mcp/extension build     # → packages/extension/.output/chrome-mv3
```

Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → `packages/extension/.output/chrome-mv3`.

**2. Wire up your agent — one command**

```bash
npx agent-debug-mcp init             # writes/merges .mcp.json: one agent-debug entry (browser page_* tools built in)
npx agent-debug-mcp init -o .cursor/mcp.json   # Cursor
```

`init` keeps any servers already in the file. It also writes a Claude Code skill
(`.claude/skills/agent-debug/SKILL.md`, `--no-skill` opts out); with the skill you can even skip the `.mcp.json`
entry entirely — tools are then invoked via `npx agent-debug-mcp call <tool>` at ~80 resident context tokens
instead of the full MCP tool list, and the generated file refreshes itself after package updates
(`npx agent-debug-mcp skill` writes just the skill). There is no pairing step: while Chrome is open, the extension finds the
relay on `127.0.0.1:9333` by itself (popup shows **Connected** a few seconds after the relay starts, and the toolbar
icon gets a green dot on connected tabs). Running the relay
on another port? Enter `http://127.0.0.1:<port>` in the extension popup and click **Pair**, or open the relay's `/pair` URL once.

**3. Check the chain**

```bash
npx agent-debug-mcp doctor http://localhost:5173/
```

`doctor` walks Node → config → relay → extension → CDP endpoint → your tab (React, TanStack Query/Router, mutation
gate), opening the URL through the relay if needed, and prints a fix next to anything that fails. Start here when a
tool returns `EXTENSION_DISCONNECTED` or `CAPABILITY_UNAVAILABLE`.

<details><summary>Manual configuration</summary>

Claude Code / Cursor (`.mcp.json` / `.cursor/mcp.json`):

```json
{ "mcpServers": { "agent-debug": { "command": "npx", "args": ["-y", "agent-debug-mcp"] } } }
```

The stdio command is a thin client: it starts (or reuses) a shared relay **daemon** on 127.0.0.1:9333 that outlives the
MCP session, so several agents share one relay and restarting your agent never unpairs the extension or drops CDP
clients. Stop it with `npx agent-debug-mcp stop`.

If you run the relay yourself, use `{ "agent-debug": { "type": "http", "url": "http://127.0.0.1:9333/mcp" } }` instead
(`init --http` writes this form).

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers."agent-debug"]
command = "npx"
args = ["-y", "agent-debug-mcp"]
```

</details>

**4. TanStack (optional, dev only)** — TanStack exposes nothing globally. With Vite, add the plugin and you are done:

```bash
npm i -D agent-debug-mcp
```
```ts
// vite.config.ts
import { agentDebugMcp } from 'agent-debug-mcp/vite';
export default defineConfig({ plugins: [react(), agentDebugMcp()] });
```

(Same package as the relay: `npx agent-debug-mcp` runs the server from npm's cache, the devDependency provides the
plugin — and lets `.mcp.json` use `"command": "agent-debug-mcp"` for a lockfile-pinned, offline start.)

Without Vite, expose the instances yourself in your app entry:

```ts
if (import.meta.env.DEV) {
  window.__TANSTACK_QUERY_CLIENT__ = queryClient;
  window.__TANSTACK_ROUTER__ = router;
}
```

## Debugging workflow

```
reproduce ──► locate ──► inspect ──► fix ──► verify
page_click /  selector →  react_* /    edit +   page_* re-run
page_navigate component   tanstack_*   HMR      + state assertion
```

Every step runs against the same tab. Three tools are built for this loop: `page_snapshot` (what is on screen, with a
selector *and* the owning component per line — the join between Playwright and React), `react_explain` (everything
about the component behind a selector in one call), and `page_get_errors` (what broke since `since=`, across the
console, React, TanStack Query and Router — the verify step). The relay also ships the loop as MCP **prompts** with
the exact tool sequence, so the agent does not have to discover it:

| Prompt | Use when | Arguments |
|---|---|---|
| `debug_rerender` | a component renders too often / the UI feels slow | `target` (selector or name regex), `trigger` |
| `debug_stale_data` | the UI shows stale, missing or wrong server data | `queryKey`, `symptom` |
| `debug_route` | wrong match, loader error, stuck pending, redirect loop | `path`, `expected` |

Claude Code: `/mcp__agent-debug__debug_rerender target=[data-testid="save"] trigger="typing in the search box"` (the
prefix is the server name from your `.mcp.json`). Other clients list them under prompts. Each recipe ends by
re-running the reproduction and reporting root cause + before/after evidence; copy the pattern into your own
CLAUDE.md for team-specific flows.

## Browser automation

Browser automation is built in: the relay embeds [Playwright MCP](https://github.com/microsoft/playwright-mcp) and
re-exports its tools as `page_*` (`page_click`, `page_type`, `page_navigate`, `page_take_screenshot`,
`page_console_messages`, `page_network_requests`, …), driving the very tabs the inspection tools see over the relay's
own CDP endpoint. One `.mcp.json` entry covers everything:

```json
{
  "mcpServers": {
    "agent-debug": { "command": "npx", "args": ["-y", "agent-debug-mcp"] }
  }
}
```

The rename from Playwright's `browser_*` is deliberate: a separately installed Playwright MCP keeps working untouched
next to this server. Playwright's `browser_snapshot` is not re-exported — the relay's `page_snapshot` returns the
outline (CSS selector **and** owning component per line) and its selectors work directly as the `target` of
`page_click` / `page_type`; `ref=eN` handles also appear in every `page_navigate` / `page_click` result. The join to
React stays CSS selectors: `react_explain { selector }` / `react_find_by_dom` map anything the browser tools located
to a component, and `react_get_dom_nodes` returns a unique selector to act on.

### Bring your own Playwright MCP

The CDP endpoint stays open for external tooling — the relay prints it at startup (also shown on `/pair`):
`chromium.connectOverCDP('http://127.0.0.1:9333/cdp/<token>')`, and `agent-debug-mcp init --external-playwright`
writes the classic second server entry (`npx @playwright/mcp@latest --cdp-endpoint <url>`). One CDP client at a
time: an external client displaces the built-in `page_*` tools while connected (they reconnect on their next call).
No Chrome flags: the extension's `chrome.debugger` carries the protocol, so Chrome shows its "Agent Debug MCP is
debugging this browser" bar while a client is connected. `--no-cdp` disables the endpoint (and with it the built-in
browser tools); `--no-playwright` disables just the built-in tools.

## Development

```bash
pnpm test              # unit tests in every package
pnpm typecheck
pnpm test:e2e          # Playwright; needs the extension build, starts the demo app itself
```

## Documentation

- [`docs/TOOL-MAP.md`](docs/TOOL-MAP.md) — which tool family does what: every tool in one line, native vs embedded Playwright MCP
- [`docs/TOOLS.md`](docs/TOOLS.md) — tool reference with parameters (generated)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — layers, request lifecycle, key decisions
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — wire frames, error codes, encoding
- [`docs/SECURITY.md`](docs/SECURITY.md) — trust boundaries, pairing, mutation gate
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — adding tools
- [`CHANGELOG.md`](CHANGELOG.md)

## License

MIT
