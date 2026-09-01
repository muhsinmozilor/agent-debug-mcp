/**
 * Daemon lifecycle for the stdio entrypoint. When an MCP client spawns `npx agent-debug-mcp`, the process must
 * NOT run the relay (WebSocket / HTTP / CDP) in-process: the relay's lifetime would be tied to that one client
 * session, so closing the session would unpair the extension, evict CDP clients and break every other session
 * proxying to it. Instead the CLI ensures a *detached* relay daemon is running on the port and proxies stdio to
 * it — every MCP session is an equal thin client, and the daemon outlives them all (`agent-debug-mcp stop`).
 *
 * State lives next to relay.json: `daemon-<port>.json` (pid) and `relay-<port>.log` (the daemon's stderr).
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { log } from './log.js';

export interface RelayHealth {
  name?: string;
  version?: string;
  instanceId?: string;
}

export interface DaemonInfo {
  pid: number;
  port: number;
  version: string;
  startedAt: string;
  log: string;
}

export interface EnsureDaemonOptions {
  port: number;
  host?: string;
  /** This CLI's version — a daemon-owned relay reporting a different version is restarted in place. */
  version: string;
  /** Extra CLI flags forwarded to the daemon (--http-token, --allow-extension, --no-cdp, …). */
  daemonArgs?: string[];
  /** Command line that starts the CLI (tests); default: this process re-invoked (node + execArgv + argv[1]). */
  spawnCmd?: string[];
  /** Extra environment for the daemon (tests). */
  env?: Record<string, string>;
  /** How long to wait for /health after spawning (default 15 s). */
  waitMs?: number;
}

export interface EnsureDaemonResult {
  /** Streamable-HTTP MCP endpoint of the (now-running) relay. */
  url: string;
  /** True when this call spawned the serving daemon; false when one was already answering. */
  started: boolean;
  health: RelayHealth;
}

export interface StopDaemonResult {
  status: 'stopped' | 'not-running' | 'stale' | 'foreign';
  detail: string;
}

function stateDir(): string {
  return process.env.AGENT_DEBUG_MCP_HOME ?? join(homedir(), '.agent-debug-mcp');
}
export function daemonPidFile(port: number): string {
  return join(stateDir(), `daemon-${port}.json`);
}
export function daemonLogFile(port: number): string {
  return join(stateDir(), `relay-${port}.log`);
}

export async function fetchRelayHealth(host: string, port: number, timeoutMs = 1500): Promise<RelayHealth | null> {
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = (await res.json()) as RelayHealth;
    return body?.name === 'agent-debug-mcp' ? body : null;
  } catch {
    return null;
  }
}

export function readDaemonInfo(port: number): DaemonInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(daemonPidFile(port), 'utf8')) as Partial<DaemonInfo>;
    return typeof parsed.pid === 'number' ? (parsed as DaemonInfo) : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Make sure a relay daemon is serving on `host:port` and return its /mcp URL. Reuses a healthy relay
 * (restarting it first when it is a daemon we own on an outdated version), otherwise spawns a detached one
 * and waits for /health. Losing a spawn race to a concurrent session is fine: our child exits with
 * EADDRINUSE, the winner answers /health, and we proxy to it without touching the winner's pid file.
 */
export async function ensureRelayDaemon(opts: EnsureDaemonOptions): Promise<EnsureDaemonResult> {
  const host = opts.host ?? '127.0.0.1';
  const { port } = opts;
  const url = `http://${host}:${port}/mcp`;

  let health = await fetchRelayHealth(host, port);
  if (health && health.version !== opts.version) {
    const info = readDaemonInfo(port);
    if (info && pidAlive(info.pid)) {
      log('info', `relay daemon v${health.version ?? '?'} on ${host}:${port} does not match this CLI (v${opts.version}); restarting it`);
      await stopRelayDaemon(port, host);
      health = await fetchRelayHealth(host, port);
    } else {
      log('warn', `relay v${health.version ?? '?'} on ${host}:${port} was not started as a daemon; proxying to it as-is (this CLI is v${opts.version})`);
    }
  }
  if (health) return { url, started: false, health };

  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const logPath = daemonLogFile(port);
  const entry = process.argv[1];
  const [bin, ...rest] = opts.spawnCmd ?? [process.execPath, ...process.execArgv, ...(entry ? [entry] : [])];
  if (!bin) throw new Error('empty spawnCmd');
  const args = [...rest, '--no-stdio', '--port', String(port), ...(host === '127.0.0.1' ? [] : ['--host', host]), ...(opts.daemonArgs ?? [])];
  const fd = openSync(logPath, 'a');
  const child = spawn(bin, args, {
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, ...opts.env },
  });
  child.unref();
  closeSync(fd);

  const deadline = Date.now() + (opts.waitMs ?? 15_000);
  while (Date.now() < deadline) {
    health = await fetchRelayHealth(host, port, 1000);
    if (health) break;
    if (child.exitCode !== null) {
      // our child died — likely lost a startup race to another session's daemon; give the winner a moment
      await sleep(300);
      health = await fetchRelayHealth(host, port, 1000);
      break;
    }
    await sleep(150);
  }
  if (!health) {
    throw new Error(`failed to start the relay daemon on ${host}:${port} — check ${logPath}`);
  }
  const ours = child.exitCode === null && child.pid !== undefined && pidAlive(child.pid);
  if (ours) {
    const info: DaemonInfo = { pid: child.pid as number, port, version: opts.version, startedAt: new Date().toISOString(), log: logPath };
    writeFileSync(daemonPidFile(port), `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  }
  return { url, started: ours, health };
}

/** Stop the daemon recorded in `daemon-<port>.json` (SIGTERM, then SIGKILL after 5 s). */
export async function stopRelayDaemon(port: number, host = '127.0.0.1'): Promise<StopDaemonResult> {
  const info = readDaemonInfo(port);
  if (info) {
    if (pidAlive(info.pid)) {
      try {
        process.kill(info.pid, 'SIGTERM');
      } catch {
        /* races with the process exiting */
      }
      const deadline = Date.now() + 5000;
      while (pidAlive(info.pid) && Date.now() < deadline) await sleep(100);
      if (pidAlive(info.pid)) {
        try {
          process.kill(info.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
        await sleep(200);
      }
      rmSync(daemonPidFile(port), { force: true });
      return { status: 'stopped', detail: `stopped the relay daemon (pid ${info.pid}, v${info.version}) on port ${port}` };
    }
    rmSync(daemonPidFile(port), { force: true });
    const health = await fetchRelayHealth(host, port);
    if (health) {
      return {
        status: 'foreign',
        detail: `removed a stale daemon pid file, but a relay v${health.version ?? '?'} still listens on ${host}:${port} and was not started as a daemon (find it with: lsof -nP -iTCP:${port} -sTCP:LISTEN)`,
      };
    }
    return { status: 'stale', detail: `removed a stale daemon pid file for port ${port}; no daemon was running` };
  }
  const health = await fetchRelayHealth(host, port);
  if (health) {
    return {
      status: 'foreign',
      detail: `a relay v${health.version ?? '?'} listens on ${host}:${port} but was not started as a daemon (find it with: lsof -nP -iTCP:${port} -sTCP:LISTEN)`,
    };
  }
  return { status: 'not-running', detail: `no relay daemon on port ${port}` };
}
