/**
 * MV3 service worker: bridges tab Ports to the relay over a single WebSocket. Kept alive by the
 * relay's 20 s ping (WebSocket traffic resets the SW idle timer on Chrome ≥116) and a 1-minute alarm. Also owns
 * the chrome.debugger sessions behind the relay's CDP endpoint (see lib/cdp.ts).
 *
 * Pairing: when unpaired (or the stored token was rejected) the worker discovers the relay itself by fetching
 * `<base>/pair.json` — from the stored relay's host/port, else the default 127.0.0.1:9333 — so the user never has to
 * visit /pair. The /pair page (content script) and the popup's Pair button remain for non-default hosts/ports.
 */
import { defineBackground } from 'wxt/utils/define-background';
import { makeFrame, parseFrame, type Frame, type TabHandle, type TabInfo } from '@devtools-mcp/protocol';
import { DEFAULT_RELAY_BASE, DEV_MATCHES, LOOPBACK_HTTP_RE, LOOPBACK_WS_RE, PORT_NAME, type UiRequest, type UiStatus } from '../lib/constants';
import { getSession, getSettings, updateSettings } from '../lib/storage';
import { CdpSessions } from '../lib/cdp';

interface TabConn {
  tab: TabHandle;
  tabId: number;
  port: chrome.runtime.Port;
  info: TabInfo | null;
  registryGen: number;
  /** Frames from a tab are processed strictly in order (tab.attached awaits chrome.tabs.get). */
  chain: Promise<void>;
}

export default defineBackground({
  type: 'module',
  main() {
    const extVersion = chrome.runtime.getManifest().version;
    const tabs = new Map<number, TabConn>();
    let ws: WebSocket | null = null;
    let wsReady = false;
    let wsBackoff = 1000;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let lastError: string | null = null;
    let helloTimer: ReturnType<typeof setTimeout> | null = null;
    let connecting = false;

    const handle = (tabId: number): TabHandle => `t${tabId}`;
    const wsSend = (f: Frame): void => {
      if (ws && wsReady && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f));
    };

    // ---------- standby ("debug only this tab") ----------
    // Tabs in standby keep their content scripts and port, but are hidden from the relay (announced as detached).
    // The set survives SW restarts via storage.session; tab ids are browser-session scoped anyway.
    const standbyTabs = new Set<number>();
    const standbyReady = chrome.storage.session.get('standbyTabs').then((r) => {
      for (const id of ((r as { standbyTabs?: number[] }).standbyTabs ?? [])) standbyTabs.add(id);
    });
    const persistStandby = (): Promise<void> => chrome.storage.session.set({ standbyTabs: [...standbyTabs] });

    const tabInfos = (): TabInfo[] => [...tabs.values()].filter((c) => !standbyTabs.has(c.tabId)).map((c) => c.info).filter((x): x is TabInfo => !!x);

    // ---------- toolbar icon (green dot = this tab is connected to the relay) ----------
    const ICON_ON = '#2da44e';
    const ICON_OFF = '#8c959f';
    const iconCache = new Map<string, Record<number, ImageData>>();
    const iconImage = (color: string): Record<number, ImageData> => {
      const cached = iconCache.get(color);
      if (cached) return cached;
      const out: Record<number, ImageData> = {};
      for (const size of [16, 32]) {
        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
        ctx.clearRect(0, 0, size, size);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size * 0.34, 0, Math.PI * 2);
        ctx.fill();
        out[size] = ctx.getImageData(0, 0, size, size);
      }
      iconCache.set(color, out);
      return out;
    };
    const updateTabIcon = (tabId: number): void => {
      const conn = tabs.get(tabId);
      const on = !!conn?.info && wsReady && !standbyTabs.has(tabId);
      void chrome.action.setIcon({ tabId, imageData: iconImage(on ? ICON_ON : ICON_OFF) }).catch(() => undefined);
      void chrome.action
        .setTitle({ tabId, title: on ? 'Agent Debug MCP — this tab is connected' : conn?.info ? 'Agent Debug MCP — tab not connected (open the popup to connect it)' : 'Agent Debug MCP' })
        .catch(() => undefined);
    };
    const updateAllIcons = (): void => {
      for (const id of tabs.keys()) updateTabIcon(id);
    };
    void chrome.action.setIcon({ imageData: iconImage(ICON_OFF) }).catch(() => undefined);

    /** Announce a formerly-standby tab to the relay again. */
    const announceTab = (conn: TabConn): void => {
      if (!conn.info) return;
      wsSend(makeFrame({ t: 'tab.attached', tab: conn.tab, doc: conn.info.doc, url: conn.info.url, title: conn.info.title, mutationsAllowed: conn.info.mutationsAllowed }));
      try {
        conn.port.postMessage(makeFrame({ t: 'registry.request_snapshot', tab: conn.tab }));
      } catch {
        /* port gone; the tab will re-attach on its own */
      }
    };
    /** Debug only `target`: standby every other attached tab, (re)connect the target. */
    const debugOnly = async (target: number): Promise<void> => {
      await standbyReady;
      for (const [id, conn] of tabs) {
        if (id === target || standbyTabs.has(id)) continue;
        standbyTabs.add(id);
        if (conn.info) wsSend(makeFrame({ t: 'tab.detached', tab: conn.tab, doc: conn.info.doc, reason: 'standby' }));
      }
      if (standbyTabs.delete(target)) {
        const conn = tabs.get(target);
        if (conn) announceTab(conn);
      }
      await persistStandby();
      updateAllIcons();
    };

    // ---------- relay discovery ----------
    /** `ws://h:p/ws` → `http://h:p`; undefined for anything that is not a loopback relay URL. */
    const wsToHttpBase = (wsUrl: string): string | undefined => (LOOPBACK_WS_RE.test(wsUrl) ? `http://${new URL(wsUrl).host}` : undefined);
    const portOf = (u: URL): string => u.port || (u.protocol === 'ws:' || u.protocol === 'http:' ? '80' : '');
    /** Same relay = both loopback and same port (localhost ≡ 127.0.0.1 ≡ [::1]). */
    const sameRelay = (a: string, b: string): boolean => {
      if (!LOOPBACK_WS_RE.test(a) || !LOOPBACK_WS_RE.test(b)) return a === b;
      return portOf(new URL(a)) === portOf(new URL(b));
    };
    /**
     * Fetch the relay's pairing info and store it. `baseUrl` (popup) → the stored relay's host/port → the default
     * 127.0.0.1:9333. Only loopback relays are accepted; the response must look like an agent-debug-mcp relay.
     */
    const discoverRelay = async (baseUrl?: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      const settings = await getSettings();
      const base = (baseUrl ?? (settings.relayUrl ? wsToHttpBase(settings.relayUrl) : undefined) ?? DEFAULT_RELAY_BASE).replace(/\/+$/, '');
      if (!LOOPBACK_HTTP_RE.test(base)) return { ok: false, error: `Relay URL must be http://127.0.0.1:<port> (got ${base})` };
      let info: { name?: unknown; wsUrl?: unknown; token?: unknown };
      try {
        const res = await fetch(`${base}/pair.json`, { signal: AbortSignal.timeout(1500), cache: 'no-store' });
        if (!res.ok) return { ok: false, error: `${base} answered ${res.status} — not an agent-debug-mcp relay?` };
        info = (await res.json()) as typeof info;
      } catch {
        return { ok: false, error: `No relay at ${base}. Start it with: npx agent-debug-mcp` };
      }
      if (info?.name !== 'agent-debug-mcp' || typeof info.token !== 'string' || info.token.length < 32 || typeof info.wsUrl !== 'string' || !LOOPBACK_WS_RE.test(info.wsUrl)) {
        return { ok: false, error: `${base} is not an agent-debug-mcp relay` };
      }
      await updateSettings({ relayUrl: info.wsUrl, token: info.token, pendingPair: null });
      return { ok: true };
    };

    // ---------- relay WebSocket ----------
    const connectRelay = async (): Promise<void> => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (connecting) return;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
      connecting = true;
      try {
        await openRelaySocket();
      } finally {
        connecting = false;
      }
    };
    const openRelaySocket = async (): Promise<void> => {
      let settings = await getSettings();
      if (!settings.relayUrl || !settings.token) {
        // Unpaired (or the token was rejected): find the relay ourselves.
        const found = await discoverRelay();
        if (!found.ok) {
          lastError = found.error;
          scheduleReconnect();
          return;
        }
        settings = await getSettings();
        if (!settings.relayUrl || !settings.token) return;
      }
      const session = await getSession();
      try {
        ws = new WebSocket(settings.relayUrl);
      } catch (e) {
        lastError = (e as Error).message;
        scheduleReconnect();
        return;
      }
      const sock = ws;
      sock.onopen = () => {
        sock.send(
          JSON.stringify(
            makeFrame({
              t: 'hello',
              role: 'extension',
              token: settings.token as string,
              extVersion,
              protocolVersion: 1,
              resumeId: session.resumeId,
            }),
          ),
        );
        helloTimer = setTimeout(() => sock.close(), 5000);
      };
      sock.onmessage = (ev) => {
        let raw: unknown;
        try {
          raw = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        const f = parseFrame(raw);
        if (!f) return;
        void onRelayFrame(f, sock);
      };
      sock.onclose = () => {
        wsReady = false;
        updateAllIcons();
        // The relay (and with it any CDP client) is gone: release the debugger sessions it asked for.
        void cdp.detachAll();
        if (helloTimer) clearTimeout(helloTimer);
        if (ws === sock) ws = null;
        scheduleReconnect();
      };
      sock.onerror = () => {
        lastError = 'WebSocket error';
      };
    };
    const scheduleReconnect = (): void => {
      if (reconnectTimer) return;
      const jitter = Math.random() * 300;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connectRelay();
      }, wsBackoff + jitter);
      wsBackoff = Math.min(wsBackoff * 2, 30_000);
    };

    const onRelayFrame = async (f: Frame, sock: WebSocket): Promise<void> => {
      switch (f.t) {
        case 'hello_ack':
          wsReady = true;
          wsBackoff = 1000;
          lastError = null;
          if (helloTimer) clearTimeout(helloTimer);
          await standbyReady;
          wsSend(makeFrame({ t: 'tabs.snapshot', tabs: tabInfos() }));
          // Re-sync registries so the relay has current descriptors after a (re)connect.
          for (const c of tabs.values()) c.port.postMessage(makeFrame({ t: 'registry.request_snapshot', tab: c.tab }));
          updateAllIcons();
          return;
        case 'hello_reject':
          lastError = `${f.code}: ${f.message}`;
          wsReady = false;
          if (f.code === 'UNAUTHORIZED') {
            // Token no longer valid (relay.json regenerated): drop it; the next (backed-off) attempt re-discovers
            // the token from the same relay URL via /pair.json.
            await updateSettings({ token: null });
          }
          sock.close();
          return;
        case 'ping':
          sock.send(JSON.stringify(makeFrame({ t: 'pong', n: f.n })));
          return;
        case 'tab.open': {
          const allowed = await isAllowedUrl(f.url);
          if (!allowed) {
            wsSend(
              makeFrame({
                t: 'tab.open_result',
                requestId: f.requestId,
                error: { code: 'INVALID_INPUT', message: `URL not in the activation allowlist: ${f.url}`, hint: 'Only localhost/127.0.0.1/*.local and allowlisted origins can be opened.', retryable: false },
              }),
            );
            return;
          }
          try {
            const created = await chrome.tabs.create({ url: f.url, active: true });
            if (created.id === undefined) throw new Error('no tab id');
            // A tab the agent asked for is meant to be debugged: never leave it in standby.
            if (standbyTabs.delete(created.id)) await persistStandby();
            wsSend(makeFrame({ t: 'tab.open_result', requestId: f.requestId, tab: handle(created.id) }));
          } catch (e) {
            wsSend(makeFrame({ t: 'tab.open_result', requestId: f.requestId, error: { code: 'PAGE_ERROR', message: (e as Error).message, retryable: false } }));
          }
          return;
        }
        case 'cdp.request':
          await cdp.handleRequest(f);
          return;
        case 'cdp.command':
          await cdp.handleCommand(f);
          return;
        case 'invoke':
        case 'invoke.cancel':
        case 'registry.request_snapshot': {
          const tabId = Number(f.tab.slice(1));
          const conn = standbyTabs.has(tabId) ? undefined : tabs.get(tabId);
          if (!conn) {
            if (f.t === 'invoke') {
              wsSend(
                makeFrame({
                  t: 'invoke.error',
                  callId: f.callId,
                  error: { code: 'TAB_NOT_FOUND', message: `Tab ${f.tab} is not attached`, retryable: false },
                }),
              );
            }
            return;
          }
          try {
            conn.port.postMessage(f);
          } catch {
            dropTab(tabId, 'port_lost');
          }
          return;
        }
        default:
          return;
      }
    };

    // ---------- tab ports ----------
    const dropTab = (tabId: number, reason: 'closed' | 'unload' | 'port_lost' | 'sw_restart'): void => {
      const conn = tabs.get(tabId);
      if (!conn) return;
      tabs.delete(tabId);
      if (conn.info && !standbyTabs.has(tabId)) wsSend(makeFrame({ t: 'tab.detached', tab: conn.tab, doc: conn.info.doc, reason }));
      if (reason === 'closed' && standbyTabs.delete(tabId)) void persistStandby();
      updateTabIcon(tabId);
    };

    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== PORT_NAME) return;
      const tabId = port.sender?.tab?.id;
      if (tabId === undefined || (port.sender?.frameId ?? 0) !== 0) {
        port.disconnect();
        return;
      }
      const existing = tabs.get(tabId);
      if (existing && existing.port !== port) {
        try {
          existing.port.disconnect();
        } catch {
          /* ignore */
        }
      }
      const conn: TabConn = { tab: handle(tabId), tabId, port, info: existing?.info ?? null, registryGen: 0, chain: Promise.resolve() };
      tabs.set(tabId, conn);
      port.onMessage.addListener((msg: unknown) => {
        const f = parseFrame(msg);
        if (!f) return;
        conn.chain = conn.chain.then(() => onTabFrame(conn, f)).catch(() => undefined);
      });
      port.onDisconnect.addListener(() => {
        if (tabs.get(tabId)?.port === port) dropTab(tabId, 'port_lost');
      });
      // The user just opened a dev tab: try the relay now instead of waiting out the backoff.
      wsBackoff = 1000;
      void connectRelay();
    });

    const onTabFrame = async (conn: TabConn, f: Frame): Promise<void> => {
      // Re-stamp the tab handle: never trust the page/content script's `tab` field.
      await standbyReady;
      const standby = standbyTabs.has(conn.tabId);
      switch (f.t) {
        case 'tab.attached': {
          const chromeTab = await chrome.tabs.get(conn.tabId).catch(() => null);
          const prev = conn.info;
          conn.info = {
            tab: conn.tab,
            doc: f.doc,
            url: f.url,
            title: f.title || chromeTab?.title || '',
            active: chromeTab?.active ?? false,
            windowId: chromeTab?.windowId ?? -1,
            capabilities: prev?.doc === f.doc ? prev.capabilities : [],
            mutationsAllowed: f.mutationsAllowed,
            state: 'attached',
            registryGen: prev?.doc === f.doc ? prev.registryGen : 0,
          };
          if (standby) {
            updateTabIcon(conn.tabId);
            return; // hidden from the relay; state was still updated for the popup
          }
          if (prev && prev.doc !== f.doc) {
            wsSend(makeFrame({ t: 'tab.navigated', tab: conn.tab, doc: f.doc, prevDoc: prev.doc, url: f.url, title: conn.info.title }));
          } else {
            wsSend(makeFrame({ ...f, tab: conn.tab, title: conn.info.title }));
          }
          updateTabIcon(conn.tabId);
          return;
        }
        case 'tab.frozen':
        case 'tab.resumed':
          if (conn.info) conn.info.state = f.t === 'tab.frozen' ? 'frozen' : 'attached';
          if (!standby) wsSend({ ...f, tab: conn.tab });
          return;
        case 'tab.detached':
          if (!standby) wsSend({ ...f, tab: conn.tab });
          return;
        case 'registry.snapshot':
        case 'registry.diff':
          if (conn.info) {
            conn.info.capabilities = f.capabilities;
            conn.info.registryGen = f.gen;
          }
          if (!standby) wsSend({ ...f, tab: conn.tab });
          return;
        case 'invoke.result':
        case 'invoke.error':
        case 'invoke.progress':
          wsSend(f);
          return;
        default:
          return;
      }
    };

    chrome.tabs.onRemoved.addListener((tabId) => dropTab(tabId, 'closed'));
    chrome.tabs.onUpdated.addListener((tabId, change) => {
      const conn = tabs.get(tabId);
      if (conn?.info && change.title) {
        conn.info.title = change.title;
        if (!standbyTabs.has(tabId)) wsSend(makeFrame({ t: 'tab.attached', tab: conn.tab, doc: conn.info.doc, url: conn.info.url, title: change.title, mutationsAllowed: conn.info.mutationsAllowed }));
      }
    });
    chrome.tabs.onActivated.addListener(({ tabId }) => {
      for (const c of tabs.values()) if (c.info) c.info.active = c.tabId === tabId;
    });

    const matchPatternToRegex = (pattern: string): RegExp => {
      // <scheme>://<host>/<path>; host may start with *. ; port is ignored by Chrome when omitted
      const m = /^(\*|https?):\/\/(\*|(?:\*\.)?[^/*]+)(\/.*)$/.exec(pattern);
      if (!m) return /^$/;
      const scheme = m[1] === '*' ? 'https?' : m[1];
      const host = m[2] === '*' ? '[^/]+' : m[2]!.startsWith('*.') ? `([^/.]+\\.)*${escapeRe(m[2]!.slice(2))}` : escapeRe(m[2]!);
      const path = escapeRe(m[3]!).replace(/\\\*/g, '.*');
      return new RegExp(`^${scheme}://${host}(:\\d+)?${path}$`);
    };
    const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const isAllowedUrl = async (url: string): Promise<boolean> => {
      const { allowlist } = await getSettings();
      return [...DEV_MATCHES, ...allowlist].some((p) => matchPatternToRegex(p).test(url));
    };
    // ---------- CDP bridge (chrome.debugger sessions for the relay's CDP endpoint) ----------
    const cdp = new CdpSessions(wsSend, isAllowedUrl);

    // ---------- allowlist: runtime-registered content scripts ----------
    const syncAllowlist = async (): Promise<void> => {
      const { allowlist } = await getSettings();
      const ids = ['dtmcp-main-extra', 'dtmcp-relay-extra'];
      await chrome.scripting.unregisterContentScripts({ ids }).catch(() => undefined);
      if (allowlist.length === 0) return;
      const granted = await chrome.permissions.contains({ origins: allowlist }).catch(() => false);
      if (!granted) return;
      await chrome.scripting.registerContentScripts([
        { id: ids[0] as string, js: ['content-scripts/main.js'], matches: allowlist, runAt: 'document_start', world: 'MAIN', persistAcrossSessions: true },
        { id: ids[1] as string, js: ['content-scripts/relay.js'], matches: allowlist, runAt: 'document_start', persistAcrossSessions: true },
      ]);
    };

    const safeOrigin = (url: string): string => {
      try {
        return new URL(url).origin;
      } catch {
        return url;
      }
    };

    // ---------- UI messages ----------
    chrome.runtime.onMessage.addListener((msg: UiRequest, _sender, sendResponse) => {
      void (async () => {
        switch (msg.kind) {
          case 'getStatus': {
            await standbyReady;
            const s = await getSettings();
            const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
            const status: UiStatus = {
              paired: !!(s.relayUrl && s.token),
              relayUrl: s.relayUrl,
              relayConnected: wsReady,
              lastError,
              pendingPair: s.pendingPair ? { relayUrl: s.pendingPair.relayUrl } : null,
              // All tabs with content scripts, standby included (the relay-facing list is tabInfos()).
              tabs: [...tabs.values()]
                .filter((c): c is TabConn & { info: TabInfo } => !!c.info)
                .map((c) => ({
                  tab: c.info.tab,
                  tabId: c.tabId,
                  url: c.info.url,
                  title: c.info.title,
                  capabilities: c.info.capabilities,
                  state: c.info.state,
                  origin: safeOrigin(c.info.url),
                  mutationsAllowed: !s.mutationDeniedOrigins.includes(safeOrigin(c.info.url)),
                  standby: standbyTabs.has(c.tabId),
                })),
              currentTabId: activeTab?.id ?? null,
              extVersion,
            };
            sendResponse(status);
            return;
          }
          case 'debugTab':
            await debugOnly(msg.tabId);
            sendResponse({ ok: true });
            return;
          case 'focusTab': {
            const tab = await chrome.tabs.update(msg.tabId, { active: true }).catch(() => null);
            if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
            sendResponse({ ok: !!tab });
            return;
          }
          case 'pair': {
            // From the /pair page (auto) or a manual request. Silently adopt when unpaired, when explicitly asked,
            // or when it is the same relay (same loopback port — a regenerated token or localhost vs 127.0.0.1).
            // A *different* relay while paired needs the user's Accept in the popup.
            const s = await getSettings();
            const alreadyPaired = !!(s.relayUrl && s.token);
            const same = !!s.relayUrl && sameRelay(s.relayUrl, msg.relayUrl);
            if (alreadyPaired && msg.auto && !same) {
              await updateSettings({ pendingPair: { relayUrl: msg.relayUrl, token: msg.token } });
              sendResponse({ ok: true, paired: false, pending: true });
              return;
            }
            if (alreadyPaired && same && s.token === msg.token && wsReady) {
              sendResponse({ ok: true, paired: true });
              return;
            }
            await updateSettings({ relayUrl: msg.relayUrl, token: msg.token, pendingPair: null });
            wsBackoff = 1000;
            ws?.close();
            ws = null;
            await connectRelay();
            sendResponse({ ok: true, paired: true });
            return;
          }
          case 'discover': {
            const found = await discoverRelay(msg.baseUrl.trim());
            if (!found.ok) {
              lastError = found.error;
              sendResponse(found);
              return;
            }
            wsBackoff = 1000;
            ws?.close();
            ws = null;
            await connectRelay();
            sendResponse({ ok: true });
            return;
          }
          case 'confirmPendingPair': {
            const s = await getSettings();
            if (s.pendingPair) {
              await updateSettings({ relayUrl: s.pendingPair.relayUrl, token: s.pendingPair.token, pendingPair: null });
              ws?.close();
              ws = null;
              await connectRelay();
            }
            sendResponse({ ok: true });
            return;
          }
          case 'unpair':
            await updateSettings({ relayUrl: null, token: null, pendingPair: null });
            ws?.close();
            ws = null;
            sendResponse({ ok: true });
            return;
          case 'reconnect':
            wsBackoff = 1000;
            ws?.close();
            ws = null;
            await connectRelay();
            sendResponse({ ok: true });
            return;
          case 'setMutations': {
            const s = await getSettings();
            const denied = new Set(s.mutationDeniedOrigins);
            if (msg.allowed) denied.delete(msg.origin);
            else denied.add(msg.origin);
            await updateSettings({ mutationDeniedOrigins: [...denied] });
            sendResponse({ ok: true });
            return;
          }
        }
      })();
      return true; // async response
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) void syncAllowlist();
    });

    // ---------- lifecycle ----------
    chrome.alarms.create('dtmcp-keepalive', { periodInMinutes: 1 });
    chrome.alarms.onAlarm.addListener((a) => {
      if (a.name === 'dtmcp-keepalive') void connectRelay();
    });
    chrome.runtime.onStartup.addListener(() => void connectRelay());
    chrome.runtime.onInstalled.addListener(() => void syncAllowlist());
    void connectRelay();
    void syncAllowlist();
  },
});
