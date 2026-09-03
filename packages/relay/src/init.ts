/**
 * `agent-debug-mcp init` — write (or merge into) an MCP client config with the `agent-debug` relay wired up.
 * Browser automation (page_* tools, embedded Playwright MCP) is built into the relay; `--external-playwright`
 * additionally adds a separate `playwright` server (@playwright/mcp pointed at the relay's CDP endpoint). The CDP
 * token is stable across relay restarts (`~/.agent-debug-mcp/relay.json`), so the URL can be baked into the file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DEFAULTS } from '@devtools-mcp/protocol';
import { loadOrCreateConfig } from './config.js';
import { writeSkill, type WriteSkillResult } from './skill.js';

export type McpServerEntry = Record<string, unknown>;
export interface McpConfigFile {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export interface InitOptions {
  cwd?: string;
  /** Output file, relative to cwd (default `.mcp.json`; use `.cursor/mcp.json` for Cursor). */
  out?: string;
  port?: number;
  host?: string;
  /** How the client should reach the relay: spawn it over stdio (default) or connect to a running one over HTTP. */
  transport?: 'stdio' | 'http';
  /** Also add a separate `playwright` server (@playwright/mcp --cdp-endpoint). The page_* browser tools are built into the relay, so default false. */
  externalPlaywright?: boolean;
  /** Also write the Claude Code skill (kept fresh on package updates by the stdio proxy and `call`). Default true. */
  skill?: boolean;
}

export interface InitResult {
  path: string;
  created: boolean;
  config: McpConfigFile;
  cdpUrl: string | null;
  pairUrl: string;
  /** Skill file written alongside the config; null with skill: false. */
  skill: WriteSkillResult | null;
}

export function agentDebugServerEntry(opts: { port: number; host: string; transport: 'stdio' | 'http' }): McpServerEntry {
  if (opts.transport === 'http') return { type: 'http', url: `http://${opts.host}:${opts.port}/mcp` };
  const args = ['-y', 'agent-debug-mcp'];
  if (opts.port !== DEFAULTS.relayPort) args.push('--port', String(opts.port));
  return { command: 'npx', args };
}

export function playwrightServerEntry(cdpUrl: string): McpServerEntry {
  return { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--cdp-endpoint', cdpUrl] };
}

/** Pure merge: keeps every other server and top-level key, replaces only `agent-debug` (and `playwright` when an entry is passed — otherwise an existing `playwright` entry is deliberately left untouched: users may run their own). */
export function mergeMcpConfig(existing: McpConfigFile, entries: { agentDebug: McpServerEntry; playwright?: McpServerEntry }): McpConfigFile {
  const servers = { ...(existing.mcpServers ?? {}) };
  servers['agent-debug'] = entries.agentDebug;
  if (entries.playwright) servers.playwright = entries.playwright;
  return { ...existing, mcpServers: servers };
}

export function runInit(opts: InitOptions = {}): InitResult {
  const cwd = opts.cwd ?? process.cwd();
  const host = opts.host ?? '127.0.0.1';
  const relayCfg = loadOrCreateConfig(opts.port ?? DEFAULTS.relayPort);
  const port = opts.port ?? relayCfg.port;
  const transport = opts.transport ?? 'stdio';
  const cdpUrl = opts.externalPlaywright ? `http://${host}:${port}/cdp/${relayCfg.cdpToken}` : null;

  const path = resolve(cwd, opts.out ?? '.mcp.json');
  let existing: McpConfigFile = {};
  const created = !existsSync(path);
  if (!created) {
    const raw = readFileSync(path, 'utf8');
    try {
      const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('top level is not an object');
      existing = parsed as McpConfigFile;
    } catch (e) {
      throw new Error(`${path} is not a JSON object (${(e as Error).message}); fix or remove it and run init again`);
    }
  }
  const config = mergeMcpConfig(existing, {
    agentDebug: agentDebugServerEntry({ port, host, transport }),
    ...(cdpUrl ? { playwright: playwrightServerEntry(cdpUrl) } : {}),
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  const skill = opts.skill !== false ? writeSkill({ cwd }) : null;
  return { path, created, config, cdpUrl, pairUrl: `http://${host}:${port}/pair`, skill };
}
