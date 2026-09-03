/**
 * `agent-debug-mcp call` — one-shot MCP tool call against the shared relay daemon over streamable HTTP, for
 * agents that reach the relay through the skill/CLI instead of resident MCP tools. Ensures the daemon exactly
 * like the stdio proxy path does, so a bare `npx agent-debug-mcp call tabs_list` works with zero setup.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { DEFAULTS } from '@devtools-mcp/protocol';
import { loadOrCreateConfig } from './config.js';
import { ensureRelayDaemon, fetchRelayHealth } from './daemon.js';

export interface CallOptions {
  /** Tool to call (ignored with list/describe). */
  tool?: string;
  args?: Record<string, unknown>;
  /** List every advertised tool instead of calling one. */
  list?: boolean;
  /** Return the full definition of this tool instead of calling it. */
  describe?: string;
  port?: number;
  host?: string;
  httpToken?: string;
  /** This CLI's version (daemon restart-on-mismatch + MCP client info). */
  version: string;
  /** Spawn the relay daemon when none is running (default true; tests point at a live relay). */
  ensureDaemon?: boolean;
}

export type CallOutcome =
  | { kind: 'list'; tools: Pick<Tool, 'name' | 'description'>[] }
  | { kind: 'describe'; tool: Tool }
  | { kind: 'result'; result: CallToolResult };

/** Longest page-side tool deadline (react_watch_renders / page_pick_element ≈ 310 s) plus slack. */
const CALL_TIMEOUT_MS = 330_000;

export async function runCall(opts: CallOptions): Promise<CallOutcome> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? loadOrCreateConfig(DEFAULTS.relayPort).port;
  if (opts.ensureDaemon !== false && !(await fetchRelayHealth(host, port))) {
    await ensureRelayDaemon({ port, host, version: opts.version });
  }
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://${host}:${port}/mcp`),
    opts.httpToken ? { requestInit: { headers: { authorization: `Bearer ${opts.httpToken}` } } } : undefined,
  );
  const client = new Client({ name: 'agent-debug-cli', version: opts.version });
  await client.connect(transport);
  try {
    if (opts.list || opts.describe) {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools({ cursor });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      if (opts.describe) {
        const tool = tools.find((t) => t.name === opts.describe);
        if (!tool) throw new Error(`unknown tool "${opts.describe}" — run \`agent-debug-mcp call --list\``);
        return { kind: 'describe', tool };
      }
      return { kind: 'list', tools: tools.map((t) => ({ name: t.name, description: t.description })) };
    }
    if (!opts.tool) throw new Error('no tool given — usage: agent-debug-mcp call <tool> [json-args]');
    const result = (await client.callTool({ name: opts.tool, arguments: opts.args ?? {} }, undefined, {
      timeout: CALL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
    })) as CallToolResult;
    return { kind: 'result', result };
  } finally {
    await client.close();
  }
}
