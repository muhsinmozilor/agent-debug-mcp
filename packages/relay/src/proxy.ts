/**
 * Thin stdio → streamable-HTTP proxy. This is what an MCP-client-spawned `agent-debug-mcp` process runs:
 * the relay itself lives in a detached daemon (see daemon.ts) and every session proxies to it. Statelessness
 * makes this trivial: each JSON-RPC message is POSTed independently; SSE responses are unwrapped back to
 * line-delimited JSON on stdout.
 */
import { createInterface } from 'node:readline';
import { log } from './log.js';

export interface ProxyOptions {
  /**
   * Called when the upstream relay is unreachable (daemon stopped/killed). Return true once it is back
   * (e.g. after respawning the daemon) and the message is retried once; false/throw drops the message.
   */
  onUnreachable?: () => Promise<boolean>;
}

export async function proxyStdioToHttp(url: string, token?: string, opts: ProxyOptions = {}): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (msg: unknown): void => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  // Serialize recovery: concurrent in-flight messages that all hit a dead relay share one respawn attempt.
  let recovering: Promise<boolean> | null = null;
  const recover = (): Promise<boolean> => {
    recovering ??= (opts.onUnreachable ? opts.onUnreachable() : Promise.resolve(false))
      .catch((e: unknown) => {
        log('warn', `proxy: could not revive the relay: ${(e as Error).message}`);
        return false;
      })
      .finally(() => {
        recovering = null;
      });
    return recovering;
  };

  const post = async (body: string): Promise<Response> => {
    try {
      return await fetch(url, { method: 'POST', headers, body });
    } catch (e) {
      // Only a network-level failure lands here (relay daemon gone) — never a bad response body.
      if (!(await recover())) throw e;
      return fetch(url, { method: 'POST', headers, body });
    }
  };

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue;
    }
    void (async () => {
      try {
        const res = await post(JSON.stringify(msg));
        if (res.status === 202 || res.status === 204) return; // notification accepted
        const ct = res.headers.get('content-type') ?? '';
        if (ct.includes('text/event-stream')) {
          const text = await res.text();
          for (const evt of text.split('\n\n')) {
            const data = evt
              .split('\n')
              .filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trim())
              .join('');
            if (data) write(JSON.parse(data));
          }
        } else if (ct.includes('application/json')) {
          const body = (await res.json()) as unknown;
          if (Array.isArray(body)) body.forEach(write);
          else write(body);
        } else if (!res.ok) {
          log('warn', `proxy: upstream responded ${res.status}`);
        }
      } catch (e) {
        log('error', `proxy error: ${(e as Error).message}`);
      }
    })();
  }
  process.exit(0);
}
