# @devtools-mcp/extension

Chrome MV3 extension built with WXT.

| Entrypoint | World | Role |
|---|---|---|
| `src/entrypoints/main.content.ts` | MAIN, `document_start` | installs/adopts the React DevTools hook, owns the `ToolRegistry`, exposes tools to the relay, WebMCP and `devtoolstooldiscovery` |
| `src/entrypoints/relay.content.ts` | ISOLATED, `document_start` | nonce handshake with MAIN, frame validation, tab lifecycle, mutation gate, pairing-page detection |
| `src/entrypoints/background.ts` | service worker | relay discovery (`GET 127.0.0.1:9333/pair.json`), WebSocket to the relay, tab registry, `tab.open`, allowlist registration, popup messages |
| `src/entrypoints/popup/` | UI | relay status, Pair button for non-default relay URLs, "debug only this tab" / per-tab connect, per-origin mutation toggles |

```bash
pnpm dev      # wxt dev (HMR, opens a browser)
pnpm build    # → .output/chrome-mv3
pnpm zip
```

Activation origins: `localhost`, `127.0.0.1`, `*.local` (manifest) plus user allowlist (runtime registration).
Settings: `chrome.storage.local.settings = { relayUrl, token, allowlist, mutationDeniedOrigins, pendingPair }`.

The toolbar icon is a per-tab dot: green when that tab is attached to a connected relay, gray otherwise. All dev
tabs attach by default; the popup's **Debug only this tab** puts every other tab into *standby* (content scripts
keep running, but the tab is hidden from the relay — `chrome.storage.session.standbyTabs`), and a standby tab's
**Connect this tab for debugging** switches back. Tabs opened by the agent (`tabs_open`) always connect.
