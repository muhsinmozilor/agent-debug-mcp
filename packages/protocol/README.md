# @devtools-mcp/protocol

Shared contract between the extension and the relay (and any future host):

- `frame.ts` — zod `Frame` union for every hop, `TabInfo`, handshake messages, `DEFAULTS` (ports, timeouts).
- `tool.ts` — `ToolDefinition` (WebMCP `ModelContextTool` shape + `capability`, `mutation`, `timeoutMs`),
  `ToolDescriptor` (serialisable), `hashSchema`, `defineTool`.
- `encode.ts` — tagged JSON encoding with budgets, `expandPaths`, `decode`, `preview`, `defaultDomSelector`.
- `cursor.ts` — opaque base64url cursors `{ doc, kind, gen, pos }` and the `Page<T>` shape.
- `errors.ts` — `DevtoolsError` and the error-code list.

No DOM or Node dependencies (DOM nodes are handled structurally) so it compiles for the page, the service
worker and Node. See `docs/PROTOCOL.md`.
