/**
 * `agent-debug-mcp doctor [url]` — walk the whole chain and print a fix for whatever is broken:
 * Node → MCP client config → relay → Chrome extension → CDP endpoint → (optionally) your app tab and its
 * capabilities. Starts a temporary relay when none is running so the extension check is meaningful.
 * Exposed as `runDoctor()` so the e2e suite can run it against a real Chrome.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DEFAULTS } from '@devtools-mcp/protocol';
import { loadOrCreateConfig } from './config.js';
import { startRelay, type RunningRelay } from './index.js';
import type { McpConfigFile } from './init.js';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';
export interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}
export interface DoctorOptions {
  port?: number;
  host?: string;
  /** App URL to check (opened through the relay if not already attached). */
  url?: string;
  cwd?: string;
  /** MCP client config to inspect, relative to cwd (default `.mcp.json`). */
  configPath?: string;
  /** How long to wait for the extension / the tab (default 20 s). */
  waitMs?: number;
  /** Start a temporary relay when none answers on the port (default true). */
  startRelay?: boolean;
  /** `Authorization: Bearer` for /mcp when the relay runs with --http-token. */
  httpToken?: string;
  onCheck?: (c: Check) => void;
  onNote?: (msg: string) => void;
}
export interface DoctorReport {
  checks: Check[];
  ok: boolean;
}

interface Health {
  name?: string;
  version?: string;
  extensionConnected?: boolean;
  tabs?: number;
  cdp?: { enabled: boolean; clientConnected?: boolean };
  lastRejectedExtensionId?: string | null;
}
interface TabSummary {
  tab: string;
  url: string;
  title: string;
  capabilities: string[];
  mutationsAllowed: boolean;
  tools: number;
  state: string;
}

const TANSTACK_HINT =
  'If the app uses it: add the Vite plugin (`import { agentDebugMcp } from "agent-debug-mcp/vite"` → `plugins: [react(), agentDebugMcp()]`), or expose the instance in dev: `if (import.meta.env.DEV) { window.__TANSTACK_QUERY_CLIENT__ = queryClient; window.__TANSTACK_ROUTER__ = router; }`';

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: Check[] = [];
  const push = (c: Check): Check => {
    checks.push(c);
    opts.onCheck?.(c);
    return c;
  };
  const note = (m: string): void => opts.onNote?.(m);
  const host = opts.host ?? '127.0.0.1';
  const waitMs = opts.waitMs ?? 20_000;
  const relayCfg = loadOrCreateConfig(opts.port ?? DEFAULTS.relayPort);
  const port = opts.port ?? relayCfg.port;
  const base = `http://${host}:${port}`;
  const cdpUrl = `${base}/cdp/${relayCfg.cdpToken}`;

  // 1. Node
  const major = Number(process.versions.node.split('.')[0]);
  push(
    major >= 22
      ? { id: 'node', title: 'Node.js', status: 'ok', detail: `v${process.versions.node}` }
      : { id: 'node', title: 'Node.js', status: 'fail', detail: `v${process.versions.node}`, fix: 'agent-debug-mcp needs Node.js 22 or newer.' },
  );

  // 2. MCP client config
  push(checkMcpConfig(resolve(opts.cwd ?? process.cwd(), opts.configPath ?? '.mcp.json'), { port, cdpUrl }));

  // 3. Relay
  let temp: RunningRelay | null = null;
  let health = await fetchHealth(base);
  if (health && health.name !== 'agent-debug-mcp') {
    push({ id: 'relay', title: 'Relay', status: 'fail', detail: `something else answers on ${base}`, fix: 'Stop that process or run the relay with --port <n> (and pass --port here).' });
    health = null;
  } else if (health) {
    push({ id: 'relay', title: 'Relay', status: 'ok', detail: `running on ${base} (v${health.version ?? '?'})` });
  } else if (opts.startRelay === false) {
    push({ id: 'relay', title: 'Relay', status: 'fail', detail: `nothing answers on ${base}`, fix: `Start it: npx agent-debug-mcp${port !== DEFAULTS.relayPort ? ` --port ${port}` : ''}` });
  } else {
    try {
      temp = await startRelay({ port, host, stdio: false, http: true, logLevel: 'error', config: relayCfg });
      health = await fetchHealth(base);
      push({ id: 'relay', title: 'Relay', status: 'ok', detail: `was not running — started a temporary one on ${base} for this check`, fix: `Your MCP client starts it on demand (stdio), or run npx agent-debug-mcp yourself.` });
    } catch (e) {
      push({ id: 'relay', title: 'Relay', status: 'fail', detail: `could not start on ${base}: ${(e as Error).message}`, fix: 'Free the port or pick another with --port.' });
    }
  }

  const client = new Client({ name: 'agent-debug-doctor', version: '0' });
  try {
    if (!health) {
      for (const [id, title] of [['extension', 'Chrome extension'], ['cdp', 'CDP endpoint (Playwright)'], ['tab', 'App tab'], ['browser', 'Browser tools']] as const) {
        push({ id, title, status: 'skip', detail: 'relay not reachable' });
      }
      return finish(checks);
    }

    // 4. Extension
    const defaultRelay = port === DEFAULTS.relayPort;
    if (!health.extensionConnected) {
      note(
        `waiting up to ${Math.round(waitMs / 1000)} s for the Chrome extension… ${
          defaultRelay ? 'it finds the relay on its own while Chrome is open (click Reconnect in the popup to hurry it)' : `non-default port: open ${base}/pair or enter ${base} in the popup`
        }`,
      );
    }
    const deadline = Date.now() + waitMs;
    while (!health.extensionConnected && Date.now() < deadline) {
      await sleep(500);
      health = (await fetchHealth(base)) ?? health;
    }
    const rejected = health.lastRejectedExtensionId;
    push(
      health.extensionConnected
        ? { id: 'extension', title: 'Chrome extension', status: 'ok', detail: `connected, ${health.tabs ?? 0} tab(s) attached` }
        : rejected
          ? {
              id: 'extension',
              title: 'Chrome extension',
              status: 'fail',
              detail: `extension ${rejected} tried to connect but is not pinned in ~/.agent-debug-mcp/relay.json (extension reloaded from another path, or a second Chrome profile)`,
              fix: `Run the relay once with --allow-extension ${rejected}, or remove "extensionIds" from ~/.agent-debug-mcp/relay.json and restart the relay.`,
            }
          : {
              id: 'extension',
              title: 'Chrome extension',
              status: 'fail',
              detail: `not connected after ${Math.round(waitMs / 1000)} s`,
              fix: `Chrome → chrome://extensions → Developer mode → Load unpacked → packages/extension/.output/chrome-mv3 (build with pnpm --filter @devtools-mcp/extension build). ${
                defaultRelay ? 'With Chrome open it pairs by itself — click Reconnect in the extension popup' : `Then enter ${base} in the extension popup and click Pair`
              } (or open ${base}/pair once).`,
            },
    );

    // 5. CDP endpoint
    if (health.cdp && !health.cdp.enabled) {
      push({ id: 'cdp', title: 'CDP endpoint (Playwright)', status: 'warn', detail: 'disabled (--no-cdp)', fix: 'The built-in page_* browser tools and external CDP clients cannot drive the tabs while it is disabled.' });
    } else {
      const v = await fetch(`${cdpUrl}/json/version`)
        .then((r) => (r.ok ? (r.json() as Promise<{ webSocketDebuggerUrl?: string }>) : null))
        .catch(() => null);
      push(
        v?.webSocketDebuggerUrl
          ? { id: 'cdp', title: 'CDP endpoint (Playwright)', status: 'ok', detail: `${cdpUrl}${health.cdp?.clientConnected ? ' (a client is connected)' : ''}` }
          : { id: 'cdp', title: 'CDP endpoint (Playwright)', status: 'fail', detail: `${cdpUrl}/json/version did not answer`, fix: 'The running relay may predate the CDP endpoint or use a different token: restart it and run init again.' },
      );
    }

    // 6. App tab
    if (!opts.url) return finish(checks);
    if (!health.extensionConnected) {
      push({ id: 'tab', title: 'App tab', status: 'skip', detail: 'extension not connected' });
      return finish(checks);
    }
    let target: URL;
    try {
      target = new URL(opts.url);
    } catch {
      push({ id: 'tab', title: 'App tab', status: 'fail', detail: `"${opts.url}" is not an absolute URL`, fix: 'Pass e.g. http://localhost:5173/' });
      return finish(checks);
    }
    if (!isDevHost(target.hostname)) {
      push({
        id: 'origin',
        title: 'Origin',
        status: 'warn',
        detail: `${target.origin} is not localhost / 127.0.0.1 / *.local`,
        fix: 'Add the origin in the extension popup (allowlist) — the tools activate only on dev origins by default.',
      });
    }
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), opts.httpToken ? { requestInit: { headers: { authorization: `Bearer ${opts.httpToken}` } } } : undefined));
    } catch (e) {
      push({ id: 'tab', title: 'App tab', status: 'fail', detail: `cannot reach ${base}/mcp: ${(e as Error).message}`, fix: 'The relay runs with --no-http or --http-token; pass --http-token, or drop --no-http.' });
      return finish(checks);
    }
    let tab = findTab(await listTabs(client), target);
    if (!tab) {
      note(`opening ${target.href} through the relay…`);
      const opened = await client.callTool({ name: 'tabs_open', arguments: { url: target.href, waitMs: Math.min(waitMs, 60_000) } });
      if (opened.isError) {
        const text = (opened.content as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text ?? '';
        push({ id: 'tab', title: 'App tab', status: 'fail', detail: `could not open ${target.href}: ${text}`, fix: 'Open the URL in Chrome yourself and re-run doctor.' });
        return finish(checks);
      }
    }
    // Give the page a moment to register its tools / capabilities (TanStack globals are polled for 30 s).
    const tabDeadline = Date.now() + waitMs;
    while (Date.now() < tabDeadline) {
      tab = findTab(await listTabs(client), target);
      if (tab && tab.tools > 0 && tab.capabilities.includes('react') && (tab.capabilities.includes('tanstack_query') || Date.now() > tabDeadline - waitMs / 2)) break;
      await sleep(500);
    }
    if (!tab) {
      push({
        id: 'tab',
        title: 'App tab',
        status: 'fail',
        detail: `no attached tab for ${target.origin}`,
        fix: 'Reload the tab. The content scripts run at document_start on dev origins only; check the popup shows the tab.',
      });
      return finish(checks);
    }
    push({ id: 'tab', title: 'App tab', status: 'ok', detail: `${tab.tab} ${tab.url} — ${tab.tools} tools, state ${tab.state}` });
    push(
      tab.capabilities.includes('react')
        ? { id: 'react', title: 'React', status: 'ok', detail: 'renderer detected' }
        : {
            id: 'react',
            title: 'React',
            status: 'fail',
            detail: 'no React renderer reported',
            fix: 'Reload the tab (the DevTools hook must exist before React loads). Production builds without the DevTools hook are not supported.',
          },
    );
    for (const cap of ['tanstack_query', 'tanstack_router'] as const) {
      const title = cap === 'tanstack_query' ? 'TanStack Query' : 'TanStack Router';
      push(
        tab.capabilities.includes(cap)
          ? { id: cap, title, status: 'ok', detail: 'detected' }
          : { id: cap, title, status: 'warn', detail: `not detected (window.${cap === 'tanstack_query' ? '__TANSTACK_QUERY_CLIENT__' : '__TANSTACK_ROUTER__'} missing)`, fix: TANSTACK_HINT },
      );
    }
    push(
      tab.mutationsAllowed
        ? { id: 'mutations', title: 'Mutations', status: 'ok', detail: 'allowed for this origin (override props/state, set query data, navigate)' }
        : { id: 'mutations', title: 'Mutations', status: 'warn', detail: 'disabled for this origin', fix: 'Toggle them in the extension popup if the agent should be able to change state.' },
    );
    // 8. Built-in browser tools: page_tabs {action:"list"} proves relay -> embedded Playwright -> CDP -> extension.
    // Note: this takes the single CDP client slot (evicting an external CDP client) - acceptable for a doctor run.
    try {
      const toolNames = new Set((await client.listTools()).tools.map((t) => t.name));
      if (!toolNames.has('page_tabs')) {
        push({ id: 'browser', title: 'Browser tools', status: 'skip', detail: 'page_* tools not advertised (relay running with --no-playwright or --no-cdp?)' });
      } else {
        const res = await client.callTool({ name: 'page_tabs', arguments: { action: 'list' } });
        const text = ((res.content ?? []) as { type: string; text?: string }[]).find((c) => c.type === 'text' && c.text)?.text ?? '';
        push(
          res.isError
            ? { id: 'browser', title: 'Browser tools', status: 'warn', detail: `page_tabs failed: ${text.slice(0, 300)}`, fix: 'Close any external CDP client (only one at a time) and retry - the built-in tools reconnect on the next call.' }
            : { id: 'browser', title: 'Browser tools', status: 'ok', detail: 'page_* tools drive the attached tabs (embedded Playwright MCP over the relay CDP endpoint)' },
        );
      }
    } catch (e) {
      push({ id: 'browser', title: 'Browser tools', status: 'warn', detail: `check failed: ${(e as Error).message}` });
    }
    return finish(checks);
  } finally {
    await client.close().catch(() => undefined);
    await temp?.close().catch(() => undefined);
  }
}

export function checkMcpConfig(path: string, expected: { port: number; cdpUrl: string }): Check {
  const title = 'MCP client config';
  if (!existsSync(path)) return { id: 'config', title, status: 'warn', detail: `${path} not found`, fix: 'Run `npx agent-debug-mcp init` to write it.' };
  let cfg: McpConfigFile;
  try {
    cfg = JSON.parse(readFileSync(path, 'utf8')) as McpConfigFile;
  } catch (e) {
    return { id: 'config', title, status: 'fail', detail: `${path} is not valid JSON (${(e as Error).message})`, fix: 'Fix the file or delete it and run `npx agent-debug-mcp init`.' };
  }
  const servers = cfg.mcpServers ?? {};
  const devtools = Object.values(servers).find((s) => {
    const args = Array.isArray(s.args) ? (s.args as unknown[]).join(' ') : '';
    return args.includes('agent-debug-mcp') || (typeof s.url === 'string' && s.url.includes(`:${expected.port}/mcp`));
  });
  if (!devtools) return { id: 'config', title, status: 'warn', detail: `${path} has no agent-debug-mcp server`, fix: 'Run `npx agent-debug-mcp init` (merges into the existing file).' };
  // stdio entries pin the port via --port (http entries were matched by URL above); flag a mismatch.
  if (typeof devtools.url !== 'string') {
    const args = Array.isArray(devtools.args) ? (devtools.args as string[]) : [];
    const portIdx = args.indexOf('--port');
    const cfgPort = portIdx >= 0 ? Number(args[portIdx + 1]) : DEFAULTS.relayPort;
    if (cfgPort !== expected.port) {
      return { id: 'config', title, status: 'warn', detail: `${path}: agent-debug entry targets port ${cfgPort}, this check runs against ${expected.port}`, fix: `Run \`npx agent-debug-mcp init --port ${expected.port}\`, or pass --port ${cfgPort} to doctor.` };
    }
  }
  // A separate Playwright MCP entry is no longer needed: the page_* browser tools are built into the relay.
  const playwright = Object.values(servers).find((s) => Array.isArray(s.args) && (s.args as unknown[]).some((a) => typeof a === 'string' && a.startsWith('http') && a.includes('/cdp/')));
  if (!playwright) return { id: 'config', title, status: 'ok', detail: `${path}: agent-debug server present (browser page_* tools are built in)` };
  const endpoint = (playwright.args as string[]).find((a) => a.includes('/cdp/'));
  const stale = endpoint !== expected.cdpUrl ? `; its endpoint ${endpoint} does not match the relay's (${expected.cdpUrl})` : '';
  return {
    id: 'config',
    title,
    status: 'warn',
    detail: `${path}: separate Playwright MCP entry found${stale} — it and the built-in page_* tools evict each other on the CDP endpoint`,
    fix: 'Remove the entry (browser tools are built into agent-debug), or keep it deliberately and re-create it with `npx agent-debug-mcp init --external-playwright`.',
  };
}

function finish(checks: Check[]): DoctorReport {
  return { checks, ok: checks.every((c) => c.status !== 'fail') };
}

async function fetchHealth(base: string): Promise<Health | null> {
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? ((await r.json()) as Health) : null;
  } catch {
    return null;
  }
}

async function listTabs(client: Client): Promise<TabSummary[]> {
  const res = await client.callTool({ name: 'tabs_list', arguments: {} });
  const payload = (res.structuredContent ?? {}) as { tabs?: TabSummary[] };
  return payload.tabs ?? [];
}

function findTab(tabs: TabSummary[], target: URL): TabSummary | undefined {
  const sameOrigin = tabs.filter((t) => {
    try {
      return new URL(t.url).origin === target.origin;
    } catch {
      return false;
    }
  });
  return sameOrigin.find((t) => t.url === target.href) ?? sameOrigin.find((t) => t.state === 'attached') ?? sameOrigin[0];
}

function isDevHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.local');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
