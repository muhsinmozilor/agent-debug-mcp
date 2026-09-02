# CLAUDE.md — Agent Debug MCP

Guide for Claude Code and other AI agents working in this repository. Read this before changing anything.

## What this repo is

A pnpm monorepo that exposes **React DevTools** and **TanStack Query / Router** runtime state of a Chrome tab
to coding agents as **MCP tools**. Two deliverables: a Chrome MV3 extension (`packages/extension`) and a local
MCP relay (`packages/relay`, published as `agent-debug-mcp`). Everything else is shared libraries, a demo
app and tests. Architecture → `docs/ARCHITECTURE.md`. Tool reference → `docs/TOOLS.md` (generated).

```
packages/protocol               wire frames (zod), ToolDefinition/ToolMeta contract, shared budget/path schema fragments,
                                capabilityHint, watchGlobal, tagged encoder, cursors, errors
packages/tools-react            page-side React tools (fiber-centric: DevTools hook + bippy)
packages/tools-tanstack-query   page-side TanStack Query tools (window.__TANSTACK_QUERY_CLIENT__)
packages/tools-tanstack-router  page-side TanStack Router tools (window.__TANSTACK_ROUTER__ | window.router)
packages/extension              WXT MV3 extension: MAIN + ISOLATED content scripts, service worker, popup
packages/relay                  Node MCP server (stdio + streamable HTTP), WebSocket for the extension, pairing, CDP bridge,
                                init/doctor CLI, and src/vite.ts = the `agent-debug-mcp/vite` plugin (own tsup entry, no relay imports)
packages/demo-app               React 19 + TanStack fixture used by e2e and for manual testing
e2e                             Playwright suite (real Chromium + unpacked extension + in-process relay)
docs                            architecture, protocol, security, generated tool reference
```

## Commands

```bash
pnpm install
pnpm typecheck                                   # every package
pnpm test                                        # vitest in every package (jsdom where needed)
pnpm --filter @devtools-mcp/extension build      # → packages/extension/.output/chrome-mv3  (REQUIRED before e2e)
pnpm test:e2e                                    # Playwright; starts the demo app itself
pnpm dev:relay                                   # tsx packages/relay/src/cli.ts (extension pairs by itself; prints the CDP URL)
pnpm --filter agent-debug-mcp exec tsx src/cli.ts init     # write/merge .mcp.json (single agent-debug entry; --external-playwright adds a separate Playwright MCP)
pnpm --filter agent-debug-mcp exec tsx src/cli.ts doctor <url>   # check relay → extension → CDP → tab, with fixes
pnpm dev:demo                                    # demo app on http://localhost:5199
pnpm --filter agent-debug-mcp exec tsx ../../scripts/gen-tool-docs.mts   # regenerate docs/TOOLS.md (maintainer-local script, git-ignored)
bash scripts/release.sh [patch|minor|major|x.y.z] [--dry-run]   # maintainer-local: bump ext+relay, zip extension → releases/, publish to npm, commit+tag
pnpm --filter e2e exec tsx scripts/dogfood-cookieyes.mts <url>   # run the tools against any localhost React app
```

The e2e suite loads `packages/extension/.output/chrome-mv3` — rebuild the extension after touching
`packages/extension` **or any `tools-*` / `protocol` package** (they are bundled into the content scripts).

## Core conventions (do not break these)

1. **A tool is defined once**, in a `tools-*` package, in the MCP tool shape
   (`name, title, description, inputSchema (JSON Schema), annotations, execute(input, {signal, progress})`) plus
   `capability` and `mutation`. Metadata lives in that package's `src/descriptors.ts` with **no DOM/React
   imports** — the relay imports `@devtools-mcp/<pkg>/descriptors` in Node. Executors live in `src/tools/*`.
2. **Fixed tool list on the MCP server.** The relay advertises `RELAY_TOOL_METAS` (all descriptor modules +
   `tabs_list`/`tabs_open`). Never mirror per-tab registries dynamically (Claude Code rate-limits `list_changed`).
   Browser-level tools that need `chrome.*` (open a tab) are relay-side: a request/result frame pair
   in `protocol/src/frame.ts`, handled in the service worker, exposed from `ExtensionLink` and registered in `mcp.ts`.
   **No home-grown screenshot / click / navigate tools**: browser automation is Playwright's job. The relay embeds
   `@playwright/mcp` in-process (`packages/relay/src/playwright.ts`), pointed at its own CDP endpoint (`/cdp/<token>`,
   `packages/relay/src/cdp.ts` ⇄ `packages/extension/src/lib/cdp.ts` over `cdp.*` frames), and re-exports its tools
   renamed `browser_*` → `page_*` (fixed list cached at startup — no list_changed; renames colliding with descriptor
   tools are skipped, so `page_snapshot` stays ours). External clients (`chromium.connectOverCDP`, a user's own
   Playwright MCP) still drive the same tabs through the endpoint — one CDP client at a time, the embedded client
   reconnects lazily after an eviction. Do not add automation tools that duplicate Playwright; extend the bridge
   instead.
   **Prompts** (`packages/relay/src/prompts.ts`) encode the debugging loop as tool sequences (`debug_rerender`,
   `debug_stale_data`, `debug_route`). When a tool is renamed or its params change, update the recipes — the unit test
   only checks that mentioned tool names exist, not their arguments.
3. **`tab` is injected by the relay**, optional, resolved purely: explicit → sole attached tab → `AMBIGUOUS_TAB`.
   Page-side tools never see `tab`. There is no server-side "current tab" state. The *extension* service worker does
   have a per-tab **standby** set (popup "debug only this tab"): standby tabs are hidden from the relay — every new
   SW→relay frame or `tabs.snapshot` source must respect `standbyTabs` in `background.ts`, and the per-tab toolbar
   icon (green = connected) must be updated on new connect/disconnect paths.
4. **Tools return JSON-safe results and encode page values themselves** with `encode()` from `protocol`
   (stubs `{ "$": ... }`, `expand` by path). The page registry passes results through **untouched** — re-encoding
   already-encoded output corrupts nested stub paths (this was a real bug).
5. **Mutation tools** must set `mutation: true`. The ISOLATED content script gates them using the built-in
   descriptor tables (never the page's own descriptor), so add new descriptor modules to `MUTATION_TOOLS` in
   `packages/extension/src/entrypoints/relay.content.ts`, `RELAY_TOOL_METAS` in `packages/relay/src/mcp.ts`, and
   `noExternal` in `packages/relay/tsup.config.ts`.
6. **Trust boundary:** the MAIN world is page-controlled. Anything crossing MAIN → ISOLATED → SW → relay is
   zod-parsed (`parseFrame`), the SW re-stamps `tab` from `port.sender.tab.id`, and results are labelled
   untrusted. Never trust a `tab`/`doc` field coming from the page.
7. **React access is fiber-centric via bippy** (`getFiberId/getFiberById` for stable ids, `renderer.overrideProps/
   overrideHookState/scheduleUpdate`, `bippy/source` for hooks/source). Do not build on React DevTools'
   `operations`/`RendererInterface` Store — replaying it corrupts the official extension's panel in adopt mode.
8. **Runtime error capture** is one `ErrorLog` (protocol, pure ring buffer) per document, created in
   `main.content.ts` and fed by `installErrorCapture` (tools-react: console/window hooks + current-fiber component
   stacks), `captureQueryErrors` and `captureRouterErrors`. `page_get_errors` only reads it. New error sources push
   into that log; do not add a second buffer.
9. **Errors** are `DevtoolsError(code, message, {hint, data, retryable})` with codes from `protocol/src/errors.ts`.
   Add a hint the agent can act on. Element ids and cursors are doc-scoped → `STALE_ELEMENT` / `STALE_CURSOR`.

## Adding a tool (checklist)

1. Add a `ToolMeta` (type from `@devtools-mcp/protocol`, as are the shared `budgetSchema`/`pathSchema`
   fragments) to the package's `src/descriptors.ts` and push it into the exported `*ToolMetas` array.
2. Implement `defineTool({...meta, execute})` in `src/tools/*.ts`; register it in the package's `create*Tools()`.
3. Unit test in that package (`test/*.test.ts(x)`; React tests must `import './hook-first.js'` **before** react-dom).
4. If it mutates: `mutation: true` (gating is automatic once the descriptor module is wired).
5. Rebuild the extension, add/extend an e2e spec in `e2e/tests`, run `pnpm test:e2e`, then regenerate `docs/TOOLS.md` (maintainer-local gen-tool-docs script).

## Testing notes

- React unit tests run in jsdom against real React 19; the DevTools hook must exist before `react-dom` loads —
  hence the `hook-first.ts` import ordering. `test/adopt.test.tsx` simulates the official React DevTools hook.
- jsdom has no layout: stub `Element.prototype.getBoundingClientRect` when testing overlay/highlight code.
- Playwright uses `chromium.launchPersistentContext` with `--load-extension` (`channel: 'chromium'`, headless
  works). The extension pairs by fetching `127.0.0.1:9333/pair.json` itself; because the e2e relay runs on a random
  port, the fixture still visits `/pair` (the content-script fallback). `waitForTabs()` waits until a tab has synced
  its registry, not merely attached.
- Debug a broken extension load with `e2e/scripts/debug-extension.mts` (prints SW + page console).
- The suite refuses to start while a real relay listens on 127.0.0.1:9333 (`e2e/global-setup.ts`): the fresh test
  extension would auto-discover and pair with it instead of the per-test relay, failing every test with
  "pairing failed". Stop it with `npx agent-debug-mcp stop` — stdio MCP sessions run the relay as a shared detached
  daemon (`packages/relay/src/daemon.ts`) and proxy to it, so the daemon, not any one session, owns port 9333.
- `init`/`doctor` live in `packages/relay/src/init.ts` / `doctor.ts` as plain functions (`runInit`, `runDoctor`);
  the CLI only formats. `e2e/tests/doctor.spec.ts` runs the doctor against the real chain; `test/init.test.ts` covers
  merging and `checkMcpConfig` offline. Keep new setup checks in `runDoctor` so both CLI and e2e see them.
- `e2e/tests/cdp.spec.ts` connects a *second* Playwright (`chromium.connectOverCDP(relay.cdpUrl)`) to the relay while
  the first one owns the test browser; Chrome allows both CDP clients plus `chrome.debugger` on one tab.
  `packages/relay/test/cdp.test.ts` covers the Target-domain synthesis against a fake link without Chrome.

## Known quirks / lessons

- bippy `traverseRenderedFibers` reports every fiber as a *mount* the first time it sees a root → the profiler
  primes each root once (`primeRoots`) and normalises phase from `fiber.alternate`.
- bippy names context hooks after the context (`Theme`, not `Context`) and unwraps `useRef` to `.current`.
- Stateless MCP over HTTP: the SDK client does **not** close the SSE stream on abort; it POSTs
  `notifications/cancelled` separately, which lands in a fresh per-request server instance. The relay keeps a
  process-wide `requestId → callId` map to honour it (`packages/relay/src/mcp.ts`).
- Playwright's `connectOverCDP` handshake: `Browser.getVersion` → `Target.setAutoAttach` (expects
  `Target.attachedToTarget` for every page **before** the reply; asserts `targetInfo.browserContextId`) →
  `Target.getTargetInfo` (no params → browser target) → per page `Page.enable`… The page targetId doubles as the main
  frame id, so the bridge must use Chrome's real `targetId` (from `Target.getTargetInfo` over `chrome.debugger`).
  `chrome.debugger` child sessions need Chrome ≥125 (`minimum_chrome_version`). Only one extension can hold a
  tab's debugger; opening DevTools detaches us (`replaced_with_devtools`) and the tab is not re-grabbed until the
  CDP client reconnects.
- The service worker must process a tab's frames **in order** (`tab.attached` awaits `chrome.tabs.get`), or a
  registry snapshot reaches the relay before the tab exists. The relay also buffers early snapshots.
- `@vitejs/plugin-react` 6 requires Vite 8. pnpm 11 needs `allowBuilds: { esbuild: true }` in `pnpm-workspace.yaml`.
- TanStack exposes nothing globally; apps set `window.__TANSTACK_QUERY_CLIENT__` / `window.__TANSTACK_ROUTER__`
  under `import.meta.env.DEV` — or use `agent-debug-mcp/vite` (`packages/relay/src/vite.ts`), which aliases the TanStack entry points in `vite dev`
  to wrappers that register the instances (the demo app uses it from source). Missing globals surface as
  `CAPABILITY_UNAVAILABLE` with that hint.
- React (dev) logs caught errors/warnings inside `runWithFiberInDEV`, so `renderer.getCurrentFiber()` identifies the
  culprit while a console patch runs — that is how `page_get_errors` gets component stacks without the official
  DevTools' console patching.
- The official React DevTools extension (v7) guards its hook install with `window.hasOwnProperty('__REACT_DEVTOOLS_
  GLOBAL_HOOK__')` **twice** (outer + inner), and its panel only works with the hook its own installer creates
  (renderer attach happens inside its `inject()`; `initBackend` no longer attaches). bippy 0.7.3's one-shot
  hasOwnProperty trap defuses only the first check, so when we install first the official panel showed "not using
  React" and backendManager crashed on `hook.backends.has`. Fix: `tools-react/src/cooperative-hook.ts` installs an
  official-shaped hook with a diplomacy trap that survives both checks and yields the slot (hook.ts rebinds via
  `onTakeover`). Never let bippy's `getRDTHook()` be the first-run installer.
- **bippy's main entry auto-installs its minimal hook as an import side effect** (`dist/index.js` does
  `import "./install-hook-only.js"`), so by the time `initReactHook` runs, a bippy hook already owns the slot and
  "a hook exists" does not mean adopt. `initReactHook` evicts an untouched bippy auto-hook (bippy marker, zero
  renderers, configurable) plus bippy's own one-shot hasOwnProperty trap before the cooperative install
  (`test/bippy-eviction.test.tsx` replays the real globalThis flow — most other tests mask this with custom
  targets or pre-seeded hooks).

## Do not

- Do not commit or push without being asked. Do not change pinned versions of `bippy` without re-running the
  full e2e suite (its API churned heavily between minors).
- Do not add `tab` to page-side schemas, and do not add per-tab tool names on the MCP server.
- Do not widen `host_permissions` beyond localhost/127.0.0.1/*.local (single source:
  `packages/extension/src/lib/dev-matches.ts`, used by both the manifest and the runtime URL checks); extra
  origins belong to the runtime allowlist (`optional_host_permissions` — service-worker plumbing exists, grant UI does not yet).
- Do not bind the relay to anything but `127.0.0.1` by default, and never drop the pairing token / Origin pin.
