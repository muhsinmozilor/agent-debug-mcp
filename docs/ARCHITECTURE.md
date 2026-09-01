# Architecture

## Goal

Give a coding agent the same view a developer has in React DevTools and the TanStack devtools panels — the
mounted component tree, props/state/hooks, why things re-render, the query cache, router matches — as MCP tools,
and let it act (override values, invalidate queries, navigate) under an explicit per-origin gate.

## Layers

```
┌──────────────────────── page (MAIN world, document_start) ────────────────────────┐
│ tools-react        tools-tanstack-query   tools-tanstack-router                    │
│ (DevTools hook + bippy)  (QueryClient global)   (router global)                    │
│                        ▼ ToolRegistry: WebMCP ModelContextTool[]                   │
│   ├─ document.modelContext.registerTool(t, {signal})        (WebMCP, if present)   │
│   ├─ window 'devtoolstooldiscovery' → respondWith({tools})  (chrome-devtools-mcp)  │
│   └─ MessageChannel port (nonce handshake) ─────────────────────────────────┐      │
└─────────────────────────────────────────────────────────────────────────────┼──────┘
                                      ISOLATED content script (chrome.*, zod validation, mutation gate)
                                                 chrome.runtime Port (per tab, frames processed in order)
                                      MV3 service worker (single WebSocket client, tab registry)
                                                 ws://127.0.0.1:9333/ws  (Origin pinned + pairing token)
                                      relay (Node): McpServer ── stdio ──────► Claude Code / Codex
                                                             └── /mcp streamable-HTTP ──► Cursor / others
```

### MAIN world (`packages/extension/src/entrypoints/main.content.ts`)
Runs before the page's JavaScript so the React DevTools hook exists when React loads. Owns the `ToolRegistry`
(the single definition of every tool for this document), tracks capabilities (`react` when a renderer injects,
`tanstack_query` / `tanstack_router` when the app sets the globals — polled 250 ms for 30 s), executes tool
calls with an `AbortController`, and exposes the same registry to WebMCP and to chrome-devtools-mcp's
`devtoolstooldiscovery` event.

It also owns the document's `ErrorLog`: console.error/warn and window error/unhandledrejection hooks are installed
before the app runs (with React component stacks taken from the renderer's current fiber), and TanStack Query/Router
subscribe their failures once their instances appear. `page_get_errors` reads the log with a `since` sequence.

### ISOLATED world (`relay.content.ts`)
The trust boundary. It offers a `MessageChannel` to the MAIN script with a random nonce; the page answers on
the port with `hello{token: nonce}` and the ISOLATED side adopts exactly that channel. Every frame from the page
is zod-parsed; only an allow-list of frame types is forwarded. It announces tab lifecycle (`tab.attached`,
`frozen`/`resumed` for bfcache, `detached`) and enforces the **mutation gate** using the built-in descriptor
tables (`mutationDeniedOrigins` in `chrome.storage.local`). It also detects the relay's `/pair` page and
forwards the pairing token to the service worker (the fallback for non-default hosts/ports — normally the
service worker discovers the relay itself by fetching `http://127.0.0.1:9333/pair.json`).

### Service worker (`background.ts`)
One WebSocket to the relay, kept alive by the relay's 20 s ping (WebSocket traffic resets the MV3 idle timer on
Chrome ≥116) plus a 1-minute alarm as a backup. When unpaired (or after an `UNAUTHORIZED` reject) it discovers the
relay itself: `GET <base>/pair.json` from the last-paired host/port, else `127.0.0.1:9333`. It re-stamps every
frame's `tab` from `port.sender.tab.id`,
maintains `TabInfo` per tab, sends `tabs.snapshot` and asks every tab for a fresh registry on (re)connect, and
handles `tab.open` (allowlisted origins only) and owns the `chrome.debugger` sessions behind the relay's CDP endpoint
(`lib/cdp.ts`: attach/detach on the relay's request, forward `cdp.command`s and `cdp.event`s verbatim, child sessions
included). The popup's **Debug only this tab** puts every other tab into *standby*: announced to the relay as
detached (`reason: 'standby'`), omitted from `tabs.snapshot` and frame forwarding, content scripts kept warm for a
one-click switch back. The toolbar icon is drawn per tab (OffscreenCanvas): green dot = attached to a connected
relay, gray otherwise. Settings live in `chrome.storage.local`, session identity and the standby set in
`chrome.storage.session` (`resumeId`, so the relay can tell a SW restart from a new install; `standbyTabs`).

### Relay (`packages/relay`)
- `ExtensionLink`: WebSocket auth (Origin `chrome-extension://<pinned id>` + token in `hello`), heartbeat,
  `TabRegistry`, `InvokeTracker` (callId → pending promise, deadlines, cancellation, progress).
- `createMcpServer`: fixed tool list = `tabs_list`, `tabs_open` + every descriptor module + the embedded
  Playwright MCP tools (below). Each page tool's
  JSON Schema gets an optional `tab` property and is converted with `z.fromJSONSchema` so the SDK validates
  inputs and re-emits the schema in `tools/list`.
- HTTP: `/mcp` (stateless streamable HTTP — a fresh transport + server per POST, client disconnect aborts the
  page call), `/ws`, `/pair`, `/pair.json` (relay discovery), `/health`, `/cdp/<token>`. Stdio launches (MCP clients) do not serve in-process:
  they ensure a shared *detached* relay daemon on the port (`daemon.ts`; pid file + log under `~/.agent-debug-mcp/`) and proxy
  stdio to it (`proxy.ts`), respawning it if it dies — so the relay, the extension pairing and any CDP client survive MCP client
  restarts and are shared by all sessions. `agent-debug-mcp stop` stops the daemon.
- `CdpBridge` (`cdp.ts`): a Chrome DevTools Protocol endpoint for Playwright (`chromium.connectOverCDP`,
  `@playwright/mcp --cdp-endpoint`). It answers `/json/version`, synthesises the browser-level **Target** domain — one
  root session per attached tab, `Target.attachedToTarget` as tabs appear, `createTarget`/`closeTarget`/`activateTarget`
  mapped to `chrome.tabs` — and forwards every other command to the tab's `chrome.debugger` session through the
  extension. Child sessions (OOPIFs, workers) keep Chrome's ids; the bridge only remembers which tab owns them. One
  client at a time; the client is dropped when the extension disconnects.
- Embedded Playwright MCP (`playwright.ts`): one in-process `@playwright/mcp` server per relay, pointed at the
  relay's own `/cdp/<token>` and wired over an in-memory transport; its tools are re-exported renamed `browser_*` →
  `page_*` (fixed list cached at startup; renames colliding with descriptor tools are skipped — `page_snapshot`
  stays ours). The browser connection is lazy (first tool call) and is recreated after an external CDP client
  evicts it. `--no-playwright` disables it; `--no-cdp` implies it.

## Key decisions

| Decision | Why |
|---|---|
| WebMCP is the *tool shape*, not the transport | Chrome ships WebMCP behind an origin trial until ~M157; extensions can only read a page's tools with a testing flag. The relay works on stable Chrome today; WebMCP/3p exposure come for free. |
| Fixed tool list, optional `tab` argument, no server-side default tab | MCP 2026-07 is stateless; Claude Code rate-limits `list_changed`. Pure resolution (explicit → sole tab → `AMBIGUOUS_TAB` with candidates) gives single-tab convenience without state. |
| Fiber-centric React access via bippy | React DevTools' `RendererInterface` ids require replaying the `operations` stream; flushing it in adopt mode corrupts the official panel. Fibers + `renderer.override*` work identically whether the hook is adopted or installed. |
| No home-grown automation tools; embed Playwright MCP over our own CDP endpoint | Playwright already does browser automation well. The relay exposes the attached tabs over CDP (via the extension's `chrome.debugger`, no `--remote-debugging-port`) and runs `@playwright/mcp` in-process against that endpoint, re-exporting its tools as `page_*` — one server for agents, no name clash with a separately installed Playwright MCP, and the endpoint stays open to external CDP clients. Re-implementing a subset ourselves would be worse at both. |
| Adopt, don't own, the DevTools hook | The official extension defines the hook `configurable: false`. If it is there first we use it; otherwise bippy installs one that hands over cleanly. |
| Summary by default + `expand` by path | Props and cached data can be megabytes; agents pay per token. Collapsed stubs carry their path so the next call fetches exactly what is needed. |
| Doc-scoped ids and cursors | A navigation invalidates fibers; `STALE_ELEMENT`/`STALE_CURSOR` beat silently pointing at the wrong node. |
| Mutation gate in the ISOLATED world | Extension-controlled memory the page cannot flip; decided from built-in descriptor tables, not page-supplied flags. |

## Request lifecycle (one tool call)

1. Agent → relay (`tools/call`, optional `tab`). Relay resolves the tab, checks capability + registered tool.
2. Relay → SW: `invoke{callId, tab, tool, input, deadlineAt}` over the WebSocket.
3. SW → ISOLATED (Port) → gate check → MAIN (MessagePort) → `registry.execute` with an `AbortController`.
4. MAIN → … → relay: `invoke.progress*`, then `invoke.result{doc, result}` or `invoke.error{ToolError}`.
5. Relay returns `{ tab, doc, result }` as text + `structuredContent`, prefixed with an untrusted-data note.
   Cancellation (client abort, `notifications/cancelled`, relay timeout) travels back as `invoke.cancel`.
