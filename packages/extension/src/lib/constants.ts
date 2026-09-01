import { DEFAULTS } from '@devtools-mcp/protocol';

export const PORT_NAME = 'dtmcp/tab';
/** Where the service worker looks for a relay when it is not paired (GET <base>/pair.json). */
export const DEFAULT_RELAY_BASE = `http://127.0.0.1:${DEFAULTS.relayPort}`;
/** Relays must live on loopback; anything else is refused by discovery and by the popup. */
export const LOOPBACK_HTTP_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
export const LOOPBACK_WS_RE = /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/ws$/;
export { DEV_MATCHES } from './dev-matches';
/** Messages between the popup and the service worker (chrome.runtime.sendMessage). */
export type UiRequest =
  | { kind: 'getStatus' }
  | { kind: 'pair'; relayUrl: string; token: string; auto: boolean }
  /** Fetch `<baseUrl>/pair.json` from a relay and pair with it (popup "Pair" button). */
  | { kind: 'discover'; baseUrl: string }
  /** Debug only this tab: put every other attached tab into standby and (re)connect this one. */
  | { kind: 'debugTab'; tabId: number }
  /** Bring a tab to the front (activate it and focus its window). */
  | { kind: 'focusTab'; tabId: number }
  | { kind: 'confirmPendingPair' }
  | { kind: 'unpair' }
  | { kind: 'reconnect' }
  | { kind: 'setMutations'; origin: string; allowed: boolean };

export interface UiStatus {
  paired: boolean;
  relayUrl: string | null;
  relayConnected: boolean;
  lastError: string | null;
  pendingPair: { relayUrl: string } | null;
  tabs: { tab: string; tabId: number; url: string; title: string; capabilities: string[]; state: string; origin: string; mutationsAllowed: boolean; standby: boolean }[];
  /** Chrome tab id of the tab the popup was opened on (null when it cannot be determined). */
  currentTabId: number | null;
  extVersion: string;
}
