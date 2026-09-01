import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { DEFAULTS } from '@devtools-mcp/protocol';
import type { CdpBridge } from './cdp.js';
import type { PlaywrightBridge } from './playwright.js';
import type { ExtensionLink } from './extension-link.js';
import type { RelayConfig } from './config.js';
import { log } from './log.js';
import { createMcpServer } from './mcp.js';

export interface HttpOptions {
  host: string;
  port: number;
  config: RelayConfig;
  link: ExtensionLink;
  version: string;
  instanceId: string;
  httpToken?: string;
  enableHttp: boolean;
  /** CDP endpoint for Playwright & co.; null when disabled (--no-cdp). */
  cdp: CdpBridge | null;
  /** Embedded Playwright MCP bridge; `.current` is filled after listen and read per request. */
  playwright?: { current: PlaywrightBridge | null };
}

const HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

export function createHttpServer(opts: HttpOptions): Server {
  /**
   * Stateless MCP over HTTP: every POST gets its own transport + server instance (the SDK's
   * recommended pattern; no sessions). Shared state (tabs, extension link) lives in `opts.link`.
   * If the client disconnects mid-call, the request's AbortController cancels the page invocation.
   */
  const handleMcp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' }).end(JSON.stringify({ error: 'Stateless server: use POST' }));
      return;
    }
    const ac = new AbortController();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: false });
    const server = createMcpServer({ link: opts.link, version: opts.version, externalSignal: ac.signal, playwright: opts.playwright?.current });
    res.on('close', () => {
      if (!res.writableFinished) ac.abort();
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };

  const server = createServer((req, res) => void route(req, res));

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? '';
    if (!HOST_RE.test(host)) {
      res.writeHead(421, { 'content-type': 'text/plain' }).end('Invalid Host header');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${host}`);
    try {
      if (url.pathname.startsWith('/cdp/')) {
        if (!opts.cdp) json(res, 404, { error: 'CDP endpoint disabled (--no-cdp)' });
        else if (!(await opts.cdp.handleHttp(req, res, url.pathname, host))) json(res, 404, { error: 'Not found' });
        return;
      }
      switch (url.pathname) {
        case '/health':
          json(res, 200, {
            name: 'agent-debug-mcp',
            version: opts.version,
            instanceId: opts.instanceId,
            extensionConnected: opts.link.connected,
            tabs: opts.link.tabs.list().length,
            cdp: opts.cdp ? { enabled: true, clientConnected: opts.cdp.connected } : { enabled: false },
            browserTools: opts.playwright?.current ? { enabled: true, tools: opts.playwright.current.tools.length } : { enabled: false },
            lastRejectedExtensionId: opts.link.lastRejectedExtensionId,
          });
          return;
        case '/pair':
          html(res, 200, pairPage(opts, host));
          return;
        case '/pair.json':
          // Machine-readable pairing info for the extension's auto-discovery (SW fetch from 127.0.0.1:9333) and the
          // popup's "Pair" button. Same localhost-only surface as the /pair HTML (which carries the token in a <meta>
          // tag); deliberately no CORS headers, so web pages cannot read it — extension fetches bypass CORS via
          // host_permissions.
          json(res, 200, { name: 'agent-debug-mcp', version: opts.version, instanceId: opts.instanceId, wsUrl: `ws://${host}/ws`, token: opts.config.token });
          return;
        case '/mcp':
          if (!opts.enableHttp) {
            json(res, 404, { error: 'HTTP transport disabled (--no-http)' });
            return;
          }
          if (opts.httpToken) {
            const auth = req.headers.authorization ?? '';
            if (auth !== `Bearer ${opts.httpToken}`) {
              json(res, 401, { error: 'Unauthorized' });
              return;
            }
          }
          await handleMcp(req, res);
          return;
        default:
          json(res, 404, { error: 'Not found', routes: ['/health', '/pair', '/pair.json', '/mcp', '/ws', '/cdp/<token>'] });
      }
    } catch (e) {
      log('error', `http error on ${url.pathname}: ${(e as Error).message}`);
      if (!res.headersSent) json(res, 500, { error: 'Internal error' });
    }
  }

  server.on('upgrade', (req, socket, head) => {
    const host = req.headers.host ?? '';
    const url = new URL(req.url ?? '/', `http://${host || '127.0.0.1'}`);
    if (HOST_RE.test(host) && url.pathname === '/ws') {
      opts.link.handleUpgrade(req, socket, head);
      return;
    }
    if (HOST_RE.test(host) && opts.cdp && url.pathname.startsWith('/cdp/')) {
      opts.cdp.handleUpgrade(req, socket, head, url.pathname);
      return;
    }
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });

  return server;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}
function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' }).end(body);
}

function pairPage(opts: HttpOptions, hostHeader: string): string {
  // Host was validated against HOST_RE, so it is safe to echo; it carries the *bound* port.
  const wsUrl = `ws://${hostHeader}/ws`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Agent Debug MCP relay — pair</title>
<meta name="dtmcp-pair" content="${opts.config.token}">
<meta name="dtmcp-relay" content="${wsUrl}">
<style>body{font:15px system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;color:#1f2328}code{background:#f6f8fa;padding:2px 6px;border-radius:4px}pre{background:#f6f8fa;padding:10px;border-radius:6px;overflow-x:auto}pre code{padding:0}.ok{color:#1a7f37}.warn{color:#9a6700}</style></head>
<body><h1>Agent Debug MCP relay</h1>
<p id="status">The Agent Debug MCP Chrome extension finds a relay on the default port (<code>127.0.0.1:${DEFAULTS.relayPort}</code>) by itself — no pairing step. Opening this page pairs the extension with <b>this</b> relay (useful for another host or port); check the extension popup, it should show <b>Connected</b>.</p>
<p>Manual pairing: open the extension popup and enter <code>http://${hostHeader}</code>, then click <b>Pair</b>.</p>
<p class="warn">Anything on this machine can pair with this relay and drive your dev tabs through it. The pairing token lives in <code>~/.agent-debug-mcp/relay.json</code>.</p>
${opts.cdp ? `<h2>Browser automation</h2>
<p>Browser automation (page_click, page_navigate, page_take_screenshot, …) is built into the agent-debug MCP server — no separate Playwright MCP needed. The relay also exposes the attached tabs as a Chrome DevTools Protocol endpoint for your own tooling:</p>
<pre><code>chromium.connectOverCDP('${opts.cdp.httpUrl(hostHeader)}')</code></pre>
<p>One CDP client at a time: an external client displaces the built-in page_* tools while connected. Chrome shows its "Agent Debug MCP is debugging this browser" bar while a client is attached.</p>` : ''}
<script>
fetch('/health').then(r=>r.json()).then(h=>{if(h.extensionConnected){document.getElementById('status').innerHTML='<span class="ok">✓ Extension connected.</span> You can close this tab.'}});
setInterval(()=>fetch('/health').then(r=>r.json()).then(h=>{if(h.extensionConnected){document.getElementById('status').innerHTML='<span class="ok">✓ Extension connected.</span> You can close this tab.'}}),1500);
</script></body></html>`;
}
