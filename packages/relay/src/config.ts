import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface RelayConfig {
  /** Pairing token the extension presents in `hello`. */
  token: string;
  /** Path token for the CDP endpoint (`/cdp/<cdpToken>`), consumed by Playwright & co. */
  cdpToken: string;
  port: number;
  extensionIds: string[];
}

function configDir(): string {
  return process.env.AGENT_DEBUG_MCP_HOME ?? join(homedir(), '.agent-debug-mcp');
}

export function loadOrCreateConfig(defaultPort: number): RelayConfig {
  const dir = configDir();
  const file = join(dir, 'relay.json');
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<RelayConfig>;
      if (typeof parsed.token === 'string' && parsed.token.length >= 32) {
        const cfg: RelayConfig = {
          token: parsed.token,
          cdpToken: typeof parsed.cdpToken === 'string' && parsed.cdpToken.length >= 32 ? parsed.cdpToken : newToken(),
          port: typeof parsed.port === 'number' ? parsed.port : defaultPort,
          extensionIds: parsed.extensionIds ?? [],
        };
        if (cfg.cdpToken !== parsed.cdpToken) saveConfig(cfg); // upgrade older config files in place
        return cfg;
      }
    } catch {
      /* rewrite below */
    }
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const cfg: RelayConfig = { token: newToken(), cdpToken: newToken(), port: defaultPort, extensionIds: [] };
  saveConfig(cfg);
  return cfg;
}

function newToken(): string {
  return randomBytes(24).toString('hex');
}

export function saveConfig(cfg: RelayConfig): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'relay.json');
  writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
}
