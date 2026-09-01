import { RELAY_TOOL_METAS } from '../src/mcp.js';
import { createPlaywrightBridge, type PlaywrightBridge } from '../src/playwright.js';

export const EXISTING_NAMES: ReadonlySet<string> = new Set([...RELAY_TOOL_METAS.map((m) => m.name), 'tabs_list', 'tabs_open']);

/** Real @playwright/mcp, offline-safe: with a cdpEndpoint nothing touches a browser until a tool call. */
export function makeOfflineBridge(): Promise<PlaywrightBridge> {
  return createPlaywrightBridge({ cdpUrl: 'http://127.0.0.1:1/cdp/deadbeef', existingNames: EXISTING_NAMES, version: '0.0.0-test' });
}
