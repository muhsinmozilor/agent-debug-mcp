# Wire protocol

Defined in `packages/protocol/src/frame.ts` (zod). One `Frame` type is used on all three hops
(MAIN⇄ISOLATED MessagePort, ISOLATED⇄SW `chrome.runtime.Port`, SW⇄relay WebSocket). JSON only. Envelope:
`{ v: 1, id, ts, t, ...body }`.

| `t` | Direction | Purpose |
|---|---|---|
| `hello` / `hello_ack` / `hello_reject` | ext ⇄ relay, page → isolated | auth (pairing `token`, `extVersion`, `protocolVersion`, `resumeId`); page uses `token` to echo the handshake nonce |
| `tab.attached` / `tab.navigated` / `tab.frozen` / `tab.resumed` / `tab.detached` | isolated → SW → relay | tab lifecycle; `doc` is a per-document uuid; `frozen/resumed` = bfcache; `detached.reason ∈ closed, unload, port_lost, sw_restart, standby` (`standby` = popup's "debug only this tab" hid it — such tabs are also omitted from `tabs.snapshot`) |
| `tabs.snapshot` | SW → relay | full tab list after (re)connect |
| `tab.open` / `tab.open_result` | relay → SW → relay | open an allowlisted URL |
| `cdp.request` / `cdp.response` | relay → SW → relay | CDP bridge control: `op ∈ attach, detach, create, close, activate, version`; `attach`/`create` answer with the tab's CDP `targetInfo` |
| `cdp.command` / `cdp.result` | relay → SW → relay | one CDP command for a tab's `chrome.debugger` session (`sessionId` = child session); `result` carries the CDP result or a CDP-shaped `error {code, message}` |
| `cdp.event` / `cdp.detached` | SW → relay | CDP events from a tab (root or child `sessionId`); Chrome ended the session (`reason`: `target_closed`, `canceled_by_user`, `replaced_with_devtools`) |
| `registry.snapshot` / `registry.diff` / `registry.request_snapshot` | page → relay / relay → page | tool descriptors + capabilities; `gen` must increase |
| `invoke` / `invoke.progress` / `invoke.result` / `invoke.error` / `invoke.cancel` | relay ⇄ page | tool calls; `callId` correlates; `deadlineAt` is absolute; `invoke.cancel.reason ∈ client, timeout, tab_gone` |
| `ping` / `pong` | relay ⇄ SW | heartbeat (20 s; two misses close the socket) |

Handles: `tab` = `t<chromeTabId>` (stable across reloads, dies with the tab); `doc` = uuid per document.
Element ids, cursors and profile data are doc-scoped.

## Errors (`ToolError`)

`{ code, message, hint?, data?, retryable }` with `code` ∈
`TAB_NOT_FOUND AMBIGUOUS_TAB TAB_FROZEN CAPABILITY_UNAVAILABLE TOOL_NOT_FOUND INVALID_INPUT STALE_ELEMENT
STALE_CURSOR DOC_CHANGED MUTATIONS_DISABLED PROFILE_ALREADY_RUNNING TIMEOUT CANCELLED PAYLOAD_TOO_LARGE
PAGE_ERROR EXTENSION_DISCONNECTED EXTENSION_RESTARTED UNAUTHORIZED VERSION_MISMATCH`.
MCP clients receive them as `isError: true` with `{"error": ToolError}` as text.

## Tagged encoding (`packages/protocol/src/encode.ts`)

Page values are encoded to JSON with tags for what JSON cannot express and stubs for what exceeds the budget:

| Tag | Meaning |
|---|---|
| `{"$":"undefined"}`, `{"$":"nan"}`, `{"$":"inf","s":±1}`, `{"$":"bigint","v"}`, `{"$":"date","iso"}`, `{"$":"regexp","src","flags"}`, `{"$":"symbol","d"}` | primitives / builtins |
| `{"$":"fn","name","arity"}` | function |
| `{"$":"map","size","entries":[[k,v]]}`, `{"$":"set","size","values"}`, `{"$":"typed","ctor","length","head"}` | collections (truncated to `maxKeys`) |
| `{"$":"error","name","message","stack?"}`, `{"$":"promise"}` | |
| `{"$":"react_element","type","key","propsPreview"}`, `{"$":"dom","tag","selector","elementId?"}`, `{"$":"fiber","elementId","name"}` | host objects |
| `{"$":"cycle","path"}` | back-reference |
| `{"$":"object","ctor","size","preview","path"}`, `{"$":"array","length","preview","path"}`, `{"$":"string","length","head"}` | **collapsed** — pass `path` to a tool's `expand` to fetch it |

Budget per call: `depth` (containers at this depth collapse), `maxKeys`, `maxString`, `maxBytes` (hard cap 8 MB;
tool results are capped at 2 MB → `PAYLOAD_TOO_LARGE`). Class instances gain `$ctor`; objects with more keys
than `maxKeys` gain `$more`. Mutation inputs (`set_data`, `override_value`) accept the same tags; `decode()`
revives dates/maps/sets/bigints and rejects opaque stubs.

Cursors are base64url `{ doc, kind, gen, pos }`; responses are `{ items, nextCursor?, total?, truncated }`.
