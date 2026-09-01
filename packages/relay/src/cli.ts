import { parseArgs } from 'node:util';
import { DEFAULTS } from '@devtools-mcp/protocol';
import { loadOrCreateConfig } from './config.js';
import { daemonLogFile, ensureRelayDaemon, stopRelayDaemon } from './daemon.js';
import { runDoctor, type Check } from './doctor.js';
import { RELAY_VERSION, startRelay } from './index.js';
import { runInit } from './init.js';
import { log, setLogLevel, type Level } from './log.js';
import { proxyStdioToHttp } from './proxy.js';

// ---- subcommands: init / doctor / stop ----
const [sub, ...subArgs] = process.argv.slice(2);
if (sub === 'init') {
  const { values: v } = parseArgs({
    args: subArgs,
    options: { out: { type: 'string', short: 'o' }, port: { type: 'string', short: 'p' }, http: { type: 'boolean' }, 'external-playwright': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    strict: true,
  });
  if (v.help) {
    process.stdout.write(`Usage: agent-debug-mcp init [options]

Write (or merge into) an MCP client config with the agent-debug relay wired up. Browser automation
(page_* tools, embedded Playwright MCP) is built into the relay — no second server needed.

  -o, --out <file>            Config file (default .mcp.json; Cursor: .cursor/mcp.json)
  -p, --port <n>              Relay port (default ${DEFAULTS.relayPort})
      --http                  Reference a running relay over HTTP instead of spawning it over stdio
      --external-playwright   Also add a separate @playwright/mcp server pointed at the relay's CDP endpoint
`);
    process.exit(0);
  }
  try {
    const r = runInit({ out: v.out, port: v.port ? Number(v.port) : undefined, transport: v.http ? 'http' : 'stdio', externalPlaywright: !!v['external-playwright'] });
    process.stdout.write(`${r.created ? 'Wrote' : 'Updated'} ${r.path}\n\n${JSON.stringify(r.config.mcpServers, null, 2)}\n
Next:
  1. Load the extension: chrome://extensions → Developer mode → Load unpacked → packages/extension/.output/chrome-mv3
  2. Restart your MCP client (or run npx agent-debug-mcp) — the extension pairs with the relay by itself while Chrome is open${
    r.pairUrl.includes(`:${DEFAULTS.relayPort}/`) ? '' : `\n     (non-default port: open ${r.pairUrl} once, or enter it in the extension popup)`
  }
  3. Check the chain: npx agent-debug-mcp doctor http://localhost:<port>/
`);
    process.exit(0);
  } catch (e) {
    process.stderr.write(`init failed: ${(e as Error).message}\n`);
    process.exit(1);
  }
}
if (sub === 'doctor') {
  const { values: v, positionals } = parseArgs({
    args: subArgs,
    options: { port: { type: 'string', short: 'p' }, config: { type: 'string', short: 'c' }, wait: { type: 'string' }, 'http-token': { type: 'string' }, 'no-start': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    allowPositionals: true,
    strict: true,
  });
  if (v.help) {
    process.stdout.write(`Usage: agent-debug-mcp doctor [url] [options]

Check Node → MCP client config → relay → Chrome extension → CDP endpoint → your app tab (React / TanStack
capabilities, mutation gate), printing a fix for each problem. Starts a temporary relay if none is running.

  <url>                 App URL to check, e.g. http://localhost:5173/ (opened through the relay if needed)
  -p, --port <n>        Relay port (default ${DEFAULTS.relayPort})
  -c, --config <file>   MCP client config to inspect (default .mcp.json)
      --wait <ms>       How long to wait for the extension / tab (default 20000)
      --http-token <t>  Bearer token if the relay runs with --http-token
      --no-start        Do not start a temporary relay
`);
    process.exit(0);
  }
  const icon: Record<Check['status'], string> = { ok: '✓', warn: '!', fail: '✗', skip: '–' };
  const report = await runDoctor({
    url: positionals[0],
    port: v.port ? Number(v.port) : undefined,
    configPath: v.config,
    waitMs: v.wait ? Number(v.wait) : undefined,
    httpToken: v['http-token'],
    startRelay: !v['no-start'],
    onNote: (m) => process.stdout.write(`  … ${m}\n`),
    onCheck: (c) => process.stdout.write(`${icon[c.status]} ${c.title}: ${c.detail}${c.fix && c.status !== 'ok' ? `\n    → ${c.fix}` : ''}\n`),
  });
  process.stdout.write(report.ok ? '\nAll good.\n' : '\nSome checks failed — see the fixes above.\n');
  process.exit(report.ok ? 0 : 1);
}
if (sub === 'stop') {
  const { values: v } = parseArgs({
    args: subArgs,
    options: { port: { type: 'string', short: 'p' }, help: { type: 'boolean', short: 'h' } },
    strict: true,
  });
  if (v.help) {
    process.stdout.write(`Usage: agent-debug-mcp stop [--port <n>]

Stop the detached relay daemon (started automatically when an MCP client runs "npx agent-debug-mcp").
Live MCP sessions are not broken for good: their proxies respawn the daemon on the next tool call.

  -p, --port <n>   Relay port (default ${DEFAULTS.relayPort})
`);
    process.exit(0);
  }
  const r = await stopRelayDaemon(v.port ? Number(v.port) : loadOrCreateConfig(DEFAULTS.relayPort).port);
  process.stdout.write(`${r.detail}\n`);
  process.exit(r.status === 'foreign' ? 1 : 0);
}

const { values } = parseArgs({
  options: {
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    stdio: { type: 'boolean' },
    'no-stdio': { type: 'boolean' },
    'no-http': { type: 'boolean' },
    'no-daemon': { type: 'boolean' },
    'no-cdp': { type: 'boolean' },
    'no-playwright': { type: 'boolean' },
    'http-token': { type: 'string' },
    'allow-extension': { type: 'string', multiple: true },
    'log-level': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
  strict: true,
});

if (values.help) {
  process.stdout.write(`agent-debug-mcp ${RELAY_VERSION}

Usage: agent-debug-mcp [options]
       agent-debug-mcp init [--out <file>] [--port <n>] [--http] [--external-playwright]
       agent-debug-mcp doctor [url] [--port <n>] [--config <file>] [--wait <ms>]
       agent-debug-mcp stop [--port <n>]

In a terminal (TTY) the relay runs in this process. Spawned by an MCP client (stdio), the process instead
ensures a shared *detached* relay daemon on the port and proxies stdio to it, so the relay — and with it the
extension pairing and any CDP client — survives MCP client restarts and is shared by all sessions.

  -p, --port <n>            Port for /ws, /mcp, /pair (default ${DEFAULTS.relayPort})
      --host <addr>         Bind address (default 127.0.0.1; anything else is a security risk)
      --stdio               Serve MCP over stdio (default when stdin is not a TTY)
      --no-stdio            Never serve stdio
      --no-daemon           With stdio: run the relay in this process instead of daemon + proxy
      --no-http             Disable the /mcp streamable-HTTP endpoint (implies --no-daemon)
      --no-cdp              Disable the /cdp/<token> endpoint (connectOverCDP access; also disables the page_* tools)
      --no-playwright       Disable the built-in page_* browser tools (embedded Playwright MCP)
      --http-token <t>      Require "Authorization: Bearer <t>" on /mcp
      --allow-extension <id> Pin an additional Chrome extension id (repeatable)
      --log-level <l>       debug | info | warn | error (default info; logs go to stderr)
  -h, --help
  -v, --version

  init    write/merge .mcp.json with the agent-debug relay wired up (browser page_* tools built in)
  doctor  check relay → extension → CDP → app tab and print a fix for each problem
  stop    stop the detached relay daemon
`);
  process.exit(0);
}
if (values.version) {
  process.stdout.write(`${RELAY_VERSION}\n`);
  process.exit(0);
}

const stdio = values['no-stdio'] ? false : values.stdio ?? !process.stdin.isTTY;
const port = values.port ? Number(values.port) : undefined;
const host = values.host;
if (host && host !== '127.0.0.1' && host !== 'localhost') {
  log('warn', `binding to ${host} exposes your browser tabs to the network. Only do this on trusted networks.`);
}

// Spawned by an MCP client (stdio): do NOT run the relay in this process — its lifetime would be tied to this
// one client session, so closing the session would unpair the extension, evict CDP clients and break every
// other session proxying to it. Ensure a detached relay daemon on the port and proxy stdio to it instead.
// `--no-daemon` restores the in-process behavior; `--no-http` implies it (the proxy needs /mcp).
if (stdio && !values['no-daemon'] && !values['no-http']) {
  setLogLevel((values['log-level'] as Level | undefined) ?? 'info');
  const h = host ?? '127.0.0.1';
  const p = port ?? loadOrCreateConfig(DEFAULTS.relayPort).port;
  const daemonArgs: string[] = [];
  if (values['no-cdp']) daemonArgs.push('--no-cdp');
  if (values['no-playwright']) daemonArgs.push('--no-playwright');
  if (values['http-token']) daemonArgs.push('--http-token', values['http-token']);
  for (const id of values['allow-extension'] ?? []) daemonArgs.push('--allow-extension', id);
  if (values['log-level']) daemonArgs.push('--log-level', values['log-level']);
  const ensure = (): ReturnType<typeof ensureRelayDaemon> => ensureRelayDaemon({ port: p, host: h, version: RELAY_VERSION, daemonArgs });
  try {
    const ensured = await ensure();
    log(
      'info',
      ensured.started
        ? `started the relay daemon on ${h}:${p} (log: ${daemonLogFile(p)}; stop it with: npx agent-debug-mcp stop); proxying stdio to it`
        : `relay v${ensured.health.version ?? '?'} already running on ${h}:${p}; proxying stdio to it`,
    );
    await proxyStdioToHttp(`http://${h}:${p}/mcp`, values['http-token'], {
      onUnreachable: () => ensure().then(() => true),
    });
    process.exit(0); // stdin closed — the daemon keeps running for other sessions
  } catch (e) {
    log('error', (e as Error).message);
    process.exit(1);
  }
}

try {
  const relay = await startRelay({
    port,
    host,
    stdio,
    http: !values['no-http'],
    cdp: !values['no-cdp'],
    playwright: !values['no-playwright'],
    httpToken: values['http-token'],
    allowExtensions: values['allow-extension'],
    logLevel: (values['log-level'] as 'debug' | 'info' | 'warn' | 'error' | undefined) ?? 'info',
  });
  log(
    'info',
    relay.port === DEFAULTS.relayPort && (relay.host === '127.0.0.1' || relay.host === 'localhost')
      ? `the Chrome extension pairs with this relay automatically (keep Chrome open); if it does not, open http://${relay.host}:${relay.port}/pair`
      : `non-default host/port: pair Chrome by opening http://${relay.host}:${relay.port}/pair (or enter http://${relay.host}:${relay.port} in the extension popup)`,
  );
  if (relay.cdpUrl) log('info', `browser automation: built-in page_* tools; external CDP clients: chromium.connectOverCDP('${relay.cdpUrl}') (displaces the built-in tools while connected)`);
  const shutdown = async (): Promise<void> => {
    await relay.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  if (stdio) process.stdin.on('end', () => void shutdown());
} catch (e) {
  const err = e as NodeJS.ErrnoException;
  if (err.code === 'EADDRINUSE') {
    const p = port ?? DEFAULTS.relayPort;
    const h = host ?? '127.0.0.1';
    const running = await fetch(`http://${h}:${p}/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (running && (running as { name?: string }).name === 'agent-debug-mcp') {
      if (stdio) {
        log('info', `relay already running on ${h}:${p}; proxying stdio to it`);
        await proxyStdioToHttp(`http://${h}:${p}/mcp`, values['http-token']);
      } else {
        log('error', `a agent-debug-mcp is already running on ${h}:${p}`);
        process.exit(1);
      }
    } else {
      log('error', `port ${p} is in use by another process. Use --port to pick a different one.`);
      process.exit(1);
    }
  } else {
    log('error', `failed to start: ${err.message}`);
    process.exit(1);
  }
}
