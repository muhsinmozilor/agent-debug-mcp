/**
 * Embedded Playwright MCP: the relay runs one in-process @playwright/mcp server per process, pointed at its own
 * /cdp/<token> endpoint, and re-exports its tools renamed `browser_*` → `page_*` so they never collide with a
 * separately-installed Playwright MCP server. The tool list is fetched once and cached (fixed list — no
 * list_changed churn, same convention as the rest of the server). The browser connection is lazy (first tool
 * call) and self-heals: when an external CDP client evicts it (the relay allows one CDP client at a time), the
 * next call reconnects.
 */
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, type CallToolResult, type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import type { JsonSchema } from '@devtools-mcp/protocol';
import { log } from './log.js';
import { toZod, UNTRUSTED_NOTE } from './mcp.js';

export interface EmbeddedTool {
  /** Renamed tool name (page_*). */
  name: string;
  /** Original Playwright MCP name (browser_*), used when forwarding the call. */
  sourceName: string;
  title?: string;
  description: string;
  /** Pre-converted once at startup; registering per stateless-HTTP request stays cheap. */
  inputSchema: z.ZodType;
  annotations: ToolAnnotations;
}

export interface PlaywrightBridge {
  tools: EmbeddedTool[];
  call(sourceName: string, args: Record<string, unknown> | undefined, opts?: { signal?: AbortSignal }): Promise<CallToolResult>;
  close(): Promise<void>;
}

/** `browser_click` → `page_click`; non-browser_ names pass through. */
export function renameToolName(name: string): string {
  return name.startsWith('browser_') ? `page_${name.slice('browser_'.length)}` : name;
}

/** Rewrite tool-name references inside titles/descriptions to the renamed set. */
export function rewriteToolRefs(text: string): string {
  return text.replace(/\bbrowser_([a-z][a-z0-9_]*)/g, 'page_$1');
}

const PAGE_TABS_NOTE = ' Tab indexes here are Playwright page indexes, unrelated to Agent Debug tab handles (t123) from tabs_list.';

/** Structural: the real @playwright/mcp Server and any MCP server used as a fake in tests. */
export interface ConnectablePlaywrightServer {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
}

export interface PlaywrightBridgeOptions {
  /** The relay's own CDP endpoint (`http://127.0.0.1:<port>/cdp/<token>`). */
  cdpUrl: string;
  /** Extra Playwright MCP capabilities (e.g. 'vision', 'pdf'); core is always on. */
  capabilities?: string[];
  /** Tool names already registered on the MCP server; colliding renames are skipped (page_snapshot stays ours). */
  existingNames: ReadonlySet<string>;
  version: string;
}

/**
 * Wire an already-created Playwright MCP server over an in-memory transport, list its tools once and build the
 * renamed, pre-converted tool set. Split from `createPlaywrightBridge` so tests can inject a fake server.
 */
export async function connectPlaywrightServer(
  server: ConnectablePlaywrightServer,
  opts: Pick<PlaywrightBridgeOptions, 'existingNames' | 'version'>,
): Promise<PlaywrightBridge> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  // No `roots` capability: Playwright MCP would otherwise round-trip listRoots() on backend init.
  const client = new Client({ name: 'agent-debug-relay', version: opts.version });
  await client.connect(clientTransport);

  const listed = await client.listTools();
  const tools: EmbeddedTool[] = [];
  for (const t of listed.tools) {
    const name = renameToolName(t.name);
    if (opts.existingNames.has(name)) {
      log('warn', `embedded Playwright tool ${t.name} skipped: ${name} already exists on this server`);
      continue;
    }
    let description = rewriteToolRefs(t.description ?? '');
    if (t.name === 'browser_tabs') description += PAGE_TABS_NOTE;
    tools.push({
      name,
      sourceName: t.name,
      title: typeof t.title === 'string' ? rewriteToolRefs(t.title) : undefined,
      description,
      inputSchema: toZod(t.inputSchema as JsonSchema),
      // Pages reach the network: default openWorldHint true unless Playwright says otherwise.
      annotations: { openWorldHint: true, ...(t.annotations ?? {}) },
    });
  }

  return {
    tools,
    async call(sourceName, args, callOpts = {}) {
      // The SDK client mints its own request ids, so N concurrent stateless-HTTP servers can share this one
      // client safely. Abort → the SDK sends notifications/cancelled to the in-process server.
      const res = (await client.callTool({ name: sourceName, arguments: args ?? {} }, CallToolResultSchema, {
        signal: callOpts.signal,
        // Backstop only — Playwright's own action/navigation timeouts do the real limiting.
        timeout: 300_000,
        resetTimeoutOnProgress: true,
      })) as CallToolResult;
      if (res.isError) return res; // Playwright already formats errors ("### Error…"); pass through verbatim.
      const content = Array.isArray(res.content) ? res.content : [];
      return { ...res, content: [{ type: 'text', text: UNTRUSTED_NOTE }, ...content] };
    },
    async close() {
      const closeAll = (async () => {
        await client.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      })();
      // A wedged browser connection must not hang relay shutdown.
      await Promise.race([closeAll, new Promise((r) => setTimeout(r, 3000))]);
    },
  };
}

type CreateConnection = (config?: Record<string, unknown>) => Promise<ConnectablePlaywrightServer>;

/**
 * Create the embedded Playwright MCP server (lazy import — `--no-playwright` never loads the ~19 MB bundle).
 * With `cdpEndpoint` the browser connection happens on the first tool call, so this is safe to run at startup
 * before the extension has paired.
 */
export async function createPlaywrightBridge(opts: PlaywrightBridgeOptions): Promise<PlaywrightBridge> {
  // CJS shim (`module.exports = { createConnection }`); createRequire avoids ESM named-export lexer variance
  // and keeps our typecheck independent of @playwright/mcp's type resolution.
  const require = createRequire(import.meta.url);
  const { createConnection } = require('@playwright/mcp') as { createConnection?: CreateConnection };
  if (typeof createConnection !== 'function') throw new Error('@playwright/mcp does not export createConnection');
  const server = await createConnection({
    browser: { cdpEndpoint: opts.cdpUrl },
    ...(opts.capabilities?.length ? { capabilities: opts.capabilities } : {}),
    // Default 'auto' keys off the client name; we proxy, so always pass images through.
    imageResponses: 'allow',
  });
  return connectPlaywrightServer(server, opts);
}
