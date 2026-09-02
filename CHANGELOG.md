# Changelog

## Unreleased

Internal cleanup; small agent-facing polish.

- **The stdio entrypoint no longer runs the relay in-process.** When an MCP client spawns `npx agent-debug-mcp`,
  the process now ensures a shared *detached* relay daemon on the port (`daemon.ts`; pid file + stderr log under
  `~/.agent-debug-mcp/`) and proxies stdio to it. The relay — extension pairing, CDP clients — survives MCP client
  restarts, is shared by every session (no more first-session-owns-the-port races), and an outdated daemon is
  restarted in place after an upgrade. If the daemon is killed, live sessions respawn it on their next call.
  New: `agent-debug-mcp stop` (stops the daemon; also the fix for the `pnpm test:e2e` port-9333 conflict) and
  `--no-daemon` (restores in-process stdio serving; `--no-http` implies it).

- **WebMCP exposure removed.** The extension no longer registers tools into `document.modelContext` — Chrome’s
  WebMCP is still an origin-trial experiment and its API surface moved (`navigator.modelContext`). The
  `devtoolstooldiscovery` (chrome-devtools-mcp third-party tools) exposure stays.
- One `capabilityHint` (now in `@devtools-mcp/protocol`) shared by the page registry and the relay — the
  missing-capability hint no longer differs depending on which side reports it.
- Shared `budgetSchema`/`pathSchema` JSON-Schema fragments in protocol; the TanStack Query/Router `budget`
  params regained their bounds and per-field descriptions (visible in `docs/TOOLS.md`).
- `ToolMeta` type moved to protocol (was copied per tools package), presence polling unified in `watchGlobal`,
  the extension's `DEV_MATCHES` single-sourced (`src/lib/dev-matches.ts` feeds both the manifest and the
  runtime URL checks), dead exports and unused dependencies removed.

## 0.1.2 — 2026-09-01

Relay and extension released in lockstep at 0.1.2 (the extension previously reported 0.1.0).

## 0.1.1 — 2026-09-01

Fixes and refinements across the relay, protocol, and page-side tools since the initial publish
(0.1.0 went out mid-development; this is the first complete release of the feature set below).

## 0.1.0 — 2026-08-28

Initial implementation.

- **Embedded browser automation**: the relay runs `@playwright/mcp` in-process against its own CDP endpoint and
  re-exports the tools renamed `browser_*` → `page_*` (`page_click`, `page_navigate`, `page_take_screenshot`, …) —
  one MCP server for state inspection *and* automation, with no name clash with a separately installed Playwright
  MCP (Playwright's `browser_snapshot` is skipped in favour of the relay's own `page_snapshot`; its CSS selectors
  work as `page_click`/`page_type` targets). The embedded client connects lazily on the first call and reconnects
  after an external CDP client displaces it. `init` now writes a single `agent-debug` entry
  (`--external-playwright` restores the two-server config and existing `playwright` entries are never touched);
  `doctor` gained a Browser-tools check and flags redundant external entries; `/health` reports `browserTools`;
  `--no-playwright` disables the embedded tools.

- **Debug only this tab**: the toolbar icon shows a green dot on tabs that are connected to the relay (gray
  otherwise). The popup can restrict debugging to the current tab — every other tab goes into *standby* (hidden from
  the relay, content scripts stay warm) and can be reconnected with one click, which standbys the rest.
- **Zero-step pairing**: the extension discovers the relay itself (`GET 127.0.0.1:9333/pair.json`, or the host/port it
  was last paired with) on startup, every minute, when a dev tab opens and after an `UNAUTHORIZED` reject — so a
  regenerated `relay.json` or a freshly loaded extension needs no `/pair` visit. `localhost` and `127.0.0.1` count as the
  same relay (no spurious "Accept" prompt). Popup: one Pair button taking `http://127.0.0.1:<port>` instead of a pasted
  token. `/health` reports `lastRejectedExtensionId`; `doctor` turns it into the `--allow-extension <id>` fix.

- **protocol**: zod wire frames for MAIN⇄ISOLATED⇄SW⇄relay, `ToolDefinition` contract (WebMCP shape +
  `capability`/`mutation`), tagged encoder with budgets and `expand`-by-path, cursors, error taxonomy.
- **tools-react**: `page_snapshot` (accessibility-style outline annotated with the owning component per element),
  `page_get_errors` (exceptions, console errors, React error-boundary catches with component stacks, failed TanStack
  queries/mutations, router match errors — `since` cursor), `react_explain` (one-call component summary),
  `react_get_renderers`, `react_get_tree`, `react_inspect_element`, `react_search_components`,
  `react_find_by_dom`, `react_get_dom_nodes`, `react_get_source`, `react_override_value`, `react_force_rerender`,
  `react_profile_start/stop/get_commits`, `react_watch_renders`, `page_highlight`, `page_element_at_point`,
  `page_pick_element`. Adopts an existing React DevTools hook or installs one via bippy.
- **tools-tanstack-query**: list/get queries and mutations; invalidate, refetch, set_data, remove.
- **tools-tanstack-router**: get_state, list_routes, get_match, navigate, invalidate.
- **extension** (WXT, MV3): MAIN-world registry with WebMCP (`document.modelContext`) and
  `devtoolstooldiscovery` exposure, ISOLATED trust boundary with per-origin mutation gate, service worker with
  heartbeat-kept WebSocket, popup (status, pairing, mutation toggles), runtime allowlist registration.
- **relay** (`agent-debug-mcp`): stdio + stateless streamable HTTP, fixed tool list with optional `tab`,
  pairing token + pinned extension origin, `/pair` `/pair.json` `/health`, second-instance stdio→HTTP proxy, cancellation and
  progress forwarding. **CDP endpoint** (`/cdp/<token>`, `--no-cdp` to disable): exposes the attached tabs to
  Playwright (`chromium.connectOverCDP`, `@playwright/mcp --cdp-endpoint`) through the extension's `chrome.debugger`
  sessions — screenshots, clicks and navigation come from Playwright instead of bespoke tools (the earlier
  `tabs_screenshot` was removed in favour of this). `agent-debug-mcp init` writes/merges `.mcp.json`; `agent-debug-mcp doctor [url]` checks relay → extension → CDP → app tab and prints fixes. MCP prompts `debug_rerender`, `debug_stale_data`,
  `debug_route` encode the reproduce → locate → inspect → fix → verify loop as exact tool sequences.
- **Vite plugin** (`agent-debug-mcp/vite`, same package as the relay): dev-only aliasing of `@tanstack/react-query` / `@tanstack/react-router` so
  `QueryClient` and `createRouter` register their instances on `window` — no app code changes.
- **e2e**: Playwright tests in real Chromium with the unpacked extension (including a second Playwright client
  driving the tabs over the relay's CDP endpoint); dogfood script for any localhost app.
