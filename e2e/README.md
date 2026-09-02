# e2e

Playwright tests that load the built extension (`packages/extension/.output/chrome-mv3`) into a persistent
Chromium context, start a relay in-process on a random port, pair via `/pair` (random port ⇒ auto-discovery
does not apply; `pairing.spec.ts` covers discovery), and speak MCP over
streamable HTTP as a client. The demo app is started by Playwright's `webServer`.

```bash
pnpm --filter @devtools-mcp/extension build   # first, and after any change bundled into the extension
pnpm test            # all specs
pnpm test:headed
pnpm exec tsx scripts/debug-extension.mts               # print SW/page console when the extension misbehaves
pnpm exec tsx scripts/dogfood-cookieyes.mts <url>       # run the tools against any localhost React app
```

Specs are grouped by delivery slice (`slice1` skeleton … `slice6` 3p exposure) plus `browser-tools.spec.ts` (the embedded
Playwright MCP `page_*` tools through the relay's own MCP endpoint, including eviction by / recovery from an
external CDP client), `cdp.spec.ts` (a second Playwright
client driving the attached tabs through the relay's CDP endpoint), `doctor.spec.ts` (`init` + `doctor` end to end),
`page-tools.spec.ts` (`page_snapshot`, `react_explain`, `page_get_errors`), `pairing.spec.ts` (relay auto-discovery:
default port, token rotation, localhost ≡ 127.0.0.1) and `debug-tab.spec.ts` (popup "debug only this tab" standby
switching). `fixtures.ts` provides
`relay`, `context`, `mcp` and `waitForTabs()`; `parseResult()` unwraps `structuredContent`.
