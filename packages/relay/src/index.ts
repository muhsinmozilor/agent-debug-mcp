import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULTS } from '@devtools-mcp/protocol';
import { CdpBridge } from './cdp.js';
import { loadOrCreateConfig, type RelayConfig } from './config.js';
import { ExtensionLink } from './extension-link.js';
import { createHttpServer } from './http.js';
import { log, setLogLevel, type Level } from './log.js';
import { createMcpServer, RELAY_TOOL_METAS } from './mcp.js';
import { createPlaywrightBridge, type PlaywrightBridge } from './playwright.js';

export { RELAY_TOOL_METAS } from './mcp.js';
export { connectPlaywrightServer, createPlaywrightBridge } from './playwright.js';
export type { EmbeddedTool, PlaywrightBridge, PlaywrightBridgeOptions } from './playwright.js';
export { ExtensionLink } from './extension-link.js';
export { CdpBridge, CdpError } from './cdp.js';
export { PROMPTS, registerPrompts } from './prompts.js';
export { runInit, mergeMcpConfig, devtoolsServerEntry, playwrightServerEntry } from './init.js';
export type { InitOptions, InitResult, McpConfigFile } from './init.js';
export { ensureRelayDaemon, stopRelayDaemon, fetchRelayHealth, readDaemonInfo, daemonPidFile, daemonLogFile } from './daemon.js';
export type { EnsureDaemonOptions, EnsureDaemonResult, StopDaemonResult, DaemonInfo, RelayHealth } from './daemon.js';

export const RELAY_VERSION = '0.1.9';

export interface RelayOptions {
  host?: string;
  port?: number;
  stdio?: boolean;
  http?: boolean;
  httpToken?: string;
  /** Expose attached tabs over CDP at /cdp/<token> for Playwright (default true). */
  cdp?: boolean;
  /** Embedded Playwright MCP (page_* browser tools); default true. Needs the CDP endpoint. Object form adds extra capabilities (e.g. 'vision'). */
  playwright?: boolean | { capabilities?: string[] };
  allowExtensions?: string[];
  logLevel?: Level;
  /** Override config (tests). */
  config?: RelayConfig;
  heartbeatMs?: number;
}

export interface RunningRelay {
  port: number;
  host: string;
  config: RelayConfig;
  link: ExtensionLink;
  instanceId: string;
  /** `http://host:port/cdp/<token>` for `chromium.connectOverCDP` / `@playwright/mcp --cdp-endpoint`; null when disabled. */
  cdpUrl: string | null;
  close: () => Promise<void>;
}

export async function startRelay(options: RelayOptions = {}): Promise<RunningRelay> {
  setLogLevel(options.logLevel ?? 'info');
  const host = options.host ?? '127.0.0.1';
  const config = options.config ?? loadOrCreateConfig(options.port ?? DEFAULTS.relayPort);
  const port = options.port ?? config.port;
  for (const id of options.allowExtensions ?? []) if (!config.extensionIds.includes(id)) config.extensionIds.push(id);
  const instanceId = randomUUID();

  const link = new ExtensionLink({ config, relayVersion: RELAY_VERSION, heartbeatMs: options.heartbeatMs });
  const cdp = options.cdp === false ? null : new CdpBridge(link, config.cdpToken);
  // Filled after listen (the bridge needs the actual port in its CDP URL); per-request MCP servers read `.current`.
  const playwrightRef: { current: PlaywrightBridge | null } = { current: null };
  const http = createHttpServer({
    host,
    port,
    config,
    link,
    version: RELAY_VERSION,
    instanceId,
    httpToken: options.httpToken,
    enableHttp: options.http ?? true,
    cdp,
    playwright: playwrightRef,
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, () => {
      http.off('error', reject);
      resolve();
    });
  });
  const actualPort = (http.address() as { port: number }).port;
  const cdpUrl = cdp ? cdp.httpUrl(`${host}:${actualPort}`) : null;
  log('info', `listening on http://${host}:${actualPort}  (ws: /ws, mcp: /mcp, pair: /pair${cdp ? ', cdp: /cdp/<token>' : ''})`);

  if (options.playwright !== false) {
    if (!cdpUrl) {
      log('info', 'embedded browser tools (page_*) disabled: they need the CDP endpoint (--no-cdp)');
    } else {
      try {
        const existingNames = new Set<string>([...RELAY_TOOL_METAS.map((m) => m.name), 'tabs_list', 'tabs_open']);
        playwrightRef.current = await createPlaywrightBridge({
          cdpUrl,
          existingNames,
          version: RELAY_VERSION,
          ...(typeof options.playwright === 'object' && options.playwright.capabilities?.length ? { capabilities: options.playwright.capabilities } : {}),
        });
        log('info', `browser tools: ${playwrightRef.current.tools.length} embedded Playwright MCP tools (page_*)`);
      } catch (e) {
        // The relay must start even when the embedded server cannot (broken install, version clash, …).
        log('warn', `embedded browser tools disabled: ${(e as Error).message}`);
      }
    }
  }

  let stdioMcp: ReturnType<typeof createMcpServer> | null = null;
  if (options.stdio) {
    // Long-lived McpServer for stdio (HTTP gets a fresh instance per request).
    stdioMcp = createMcpServer({ link, version: RELAY_VERSION, playwright: playwrightRef.current });
    await stdioMcp.connect(new StdioServerTransport());
    log('info', 'stdio transport connected');
  }

  return {
    port: actualPort,
    host,
    config,
    link,
    instanceId,
    cdpUrl,
    close: async () => {
      // Bridge first: it may hold a CDP WebSocket into this very server.
      await playwrightRef.current?.close().catch(() => undefined);
      cdp?.close();
      link.close();
      await stdioMcp?.close().catch(() => undefined);
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}
