/**
 * CDP endpoint for Playwright & co. — `chromium.connectOverCDP(relay.cdpUrl)` / `@playwright/mcp --cdp-endpoint`.
 *
 * The client sees a Chrome with one browser context whose pages are exactly the tabs attached to Agent Debug MCP
 * (plus any it opens itself). We synthesise the browser-level *Target* domain here — root sessions per tab,
 * attach/detach events, create/close/activate — and forward everything else to the extension, which owns the
 * `chrome.debugger` sessions. Child sessions (OOPIFs, workers) pass straight through: Chrome mints their ids,
 * we only remember which tab they belong to so replies route back.
 *
 * One client at a time (a new connection replaces the old one). Access requires the CDP token in the path;
 * upgrades carrying an `Origin` header are refused so web pages cannot reach it.
 */
import type { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { DEFAULTS, type FrameOf, type TabHandle } from '@devtools-mcp/protocol';
import { log } from './log.js';

export class CdpError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export type CdpOp = FrameOf<'cdp.request'>['op'];
export interface CdpResponse {
  tab?: TabHandle;
  targetInfo?: Record<string, unknown>;
  userAgent?: string;
}

/** What the bridge needs from ExtensionLink (kept small so tests can fake it). */
export interface CdpLink extends EventEmitter {
  readonly connected: boolean;
  readonly tabs: { list(): { tab: string }[] };
  cdpRequest(op: CdpOp, opts?: { tab?: TabHandle; url?: string }): Promise<CdpResponse>;
  cdpCommand(tab: TabHandle, sessionId: string | undefined, method: string, params?: Record<string, unknown>): Promise<unknown>;
}

interface Target {
  tab: TabHandle;
  targetId: string;
  /** Root session id we hand to the client for this tab. */
  sessionId: string;
  info: Record<string, unknown>;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

const BROWSER_TARGET = { targetId: 'agent-debug-mcp-browser', type: 'browser', title: 'Agent Debug MCP', url: '', attached: true, canAccessOpener: false };
const CDP_PATH_RE = /^\/cdp\/([A-Za-z0-9_-]+)(\/json\/version\/?)?$/;

export class CdpBridge {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: DEFAULTS.maxFrameBytes });
  private client: CdpClient | null = null;

  constructor(
    private readonly link: CdpLink,
    private readonly token: string,
  ) {
    link.on('cdp.event', (e: FrameOf<'cdp.event'>) => this.client?.onExtensionEvent(e));
    link.on('cdp.detached', (e: FrameOf<'cdp.detached'>) => this.client?.onExtensionDetached(e));
    link.on('tabs', () => void this.client?.syncTargets());
    link.on('disconnected', () => this.client?.close(4010, 'Agent Debug MCP extension disconnected'));
  }

  get connected(): boolean {
    return this.client !== null;
  }

  /** `http://host/cdp/<token>` — what to pass to connectOverCDP / --cdp-endpoint. */
  httpUrl(hostHeader: string): string {
    return `http://${hostHeader}/cdp/${this.token}`;
  }

  /** Handles `/cdp/<token>/json/version` (Playwright's discovery request). Returns false if the path is not ours. */
  async handleHttp(req: IncomingMessage, res: ServerResponse, pathname: string, hostHeader: string): Promise<boolean> {
    const m = CDP_PATH_RE.exec(pathname);
    if (!m) return false;
    if (m[1] !== this.token) {
      json(res, 401, { error: 'Unknown CDP token', hint: 'Use the /cdp/<token> URL printed when the relay started (also shown on /pair).' });
      return true;
    }
    if (!m[2]) {
      json(res, 200, { name: 'Agent Debug MCP CDP endpoint', webSocketDebuggerUrl: `ws://${hostHeader}/cdp/${this.token}`, clientConnected: this.connected, extensionConnected: this.link.connected });
      return true;
    }
    if (req.method !== 'GET') {
      json(res, 405, { error: 'GET only' });
      return true;
    }
    const ua = this.link.connected ? await this.link.cdpRequest('version').then((r) => r.userAgent ?? '', () => '') : '';
    json(res, 200, {
      Browser: `Chrome/${chromeVersion(ua)}`,
      'Protocol-Version': '1.3',
      'User-Agent': ua,
      'V8-Version': '',
      'WebKit-Version': '',
      webSocketDebuggerUrl: `ws://${hostHeader}/cdp/${this.token}`,
    });
    return true;
  }

  /** WebSocket upgrade for `/cdp/<token>`. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, pathname: string): void {
    const m = CDP_PATH_RE.exec(pathname);
    if (!m || m[2] || m[1] !== this.token) {
      socket.write(m ? 'HTTP/1.1 401 Unauthorized\r\n\r\n' : 'HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    if (req.headers.origin !== undefined) {
      // Browsers always send Origin; CDP clients (Node) do not. Keeps web pages from driving your tabs.
      log('warn', `rejected CDP upgrade with Origin "${req.headers.origin}"`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.client?.close(4000, 'replaced by a new CDP client');
      const client = new CdpClient(ws, this.link, () => {
        if (this.client === client) this.client = null;
      });
      this.client = client;
      log('info', 'CDP client connected');
    });
  }

  close(): void {
    this.client?.close(1001, 'relay shutting down');
    this.wss.close();
  }
}

class CdpClient {
  private readonly targets = new Map<string, Target>(); // targetId → target
  private readonly sessions = new Map<string, Target>(); // root sessionId → target
  private readonly byTab = new Map<TabHandle, Target>();
  private readonly childSessions = new Map<string, Target>(); // Chrome-minted child sessionId → owning target
  /** Tabs we must not (re)attach for this client: attach failed, client detached them, or DevTools took over. */
  private readonly declined = new Set<TabHandle>();
  private readonly attaching = new Map<TabHandle, Promise<Target | null>>();
  private autoAttach = false;
  private closed = false;
  private sessionCounter = 0;

  constructor(
    private readonly ws: WebSocket,
    private readonly link: CdpLink,
    private readonly onClose: () => void,
  ) {
    ws.on('message', (data) => {
      let msg: CdpMessage;
      try {
        msg = JSON.parse(data.toString()) as CdpMessage;
      } catch {
        return;
      }
      if (typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
      void this.handle(msg as CdpMessage & { id: number; method: string });
    });
    ws.on('close', () => this.close(1000, 'client closed'));
    ws.on('error', (e) => log('warn', `CDP client socket error: ${(e as Error).message}`));
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close(code, reason);
    } catch {
      /* ignore */
    }
    if (this.link.connected) {
      for (const t of this.byTab.values()) void this.link.cdpRequest('detach', { tab: t.tab }).catch(() => undefined);
    }
    this.targets.clear();
    this.sessions.clear();
    this.byTab.clear();
    this.childSessions.clear();
    log('info', `CDP client disconnected (${reason})`);
    this.onClose();
  }

  // ---- extension → client ----

  onExtensionEvent(e: FrameOf<'cdp.event'>): void {
    const target = this.byTab.get(e.tab as TabHandle);
    if (!target) return;
    const params = e.params as { sessionId?: unknown } | undefined;
    if (e.method === 'Target.attachedToTarget' && typeof params?.sessionId === 'string') this.childSessions.set(params.sessionId, target);
    if (e.method === 'Target.detachedFromTarget' && typeof params?.sessionId === 'string') this.childSessions.delete(params.sessionId);
    this.send({ method: e.method, params: e.params ?? {}, sessionId: e.sessionId ?? target.sessionId });
  }

  onExtensionDetached(e: FrameOf<'cdp.detached'>): void {
    const target = this.byTab.get(e.tab as TabHandle);
    if (!target) return;
    // target_closed = the tab is gone; anything else (DevTools opened, user cancelled) leaves a tab we must not re-grab.
    if (e.reason !== 'target_closed') this.declined.add(target.tab);
    this.dropTarget(target);
  }

  /** Attach every Agent Debug MCP tab the client has not seen yet (called on connect and whenever the tab list changes). */
  async syncTargets(): Promise<void> {
    if (!this.autoAttach || this.closed) return;
    for (const { tab } of this.link.tabs.list()) {
      const h = tab as TabHandle;
      if (this.byTab.has(h) || this.declined.has(h) || this.attaching.has(h)) continue;
      const p = this.link
        .cdpRequest('attach', { tab: h })
        .then(
          (res) => this.addTarget(res),
          (e: Error) => {
            log('warn', `CDP: could not attach ${h}: ${e.message}`);
            this.declined.add(h);
            return null;
          },
        )
        .finally(() => this.attaching.delete(h));
      this.attaching.set(h, p);
    }
    await Promise.all([...this.attaching.values()]);
  }

  // ---- client → extension ----

  private async handle(msg: CdpMessage & { id: number; method: string }): Promise<void> {
    try {
      const result = await this.dispatch(msg);
      this.send({ id: msg.id, result: result ?? {}, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) });
    } catch (e) {
      const error = e instanceof CdpError ? { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) } : { code: -32000, message: (e as Error)?.message ?? String(e) };
      this.send({ id: msg.id, error, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) });
    }
  }

  private async dispatch(msg: CdpMessage & { method: string }): Promise<unknown> {
    const params = msg.params ?? {};
    if (msg.sessionId) {
      const root = this.sessions.get(msg.sessionId);
      if (root) return this.link.cdpCommand(root.tab, undefined, msg.method, msg.params);
      const owner = this.childSessions.get(msg.sessionId);
      if (owner) return this.link.cdpCommand(owner.tab, msg.sessionId, msg.method, msg.params);
      throw new CdpError(-32001, 'Session with given id not found.');
    }
    switch (msg.method) {
      case 'Browser.getVersion': {
        const { userAgent = '' } = await this.request('version');
        return { protocolVersion: '1.3', product: `Chrome/${chromeVersion(userAgent)}`, revision: '', userAgent, jsVersion: '' };
      }
      case 'Browser.close':
        setTimeout(() => this.close(1000, 'Browser.close'), 0); // after the reply below is written
        return {};
      case 'Browser.setDownloadBehavior':
      case 'Browser.setDockTile':
      case 'Target.setDiscoverTargets':
      case 'Target.setRemoteLocations':
      case 'Target.disposeBrowserContext':
        return {};
      case 'Target.setAutoAttach':
        this.autoAttach = params.autoAttach === true;
        // Announce every existing tab before replying: Playwright waits for the pages it saw here to initialise.
        if (this.autoAttach) await this.syncTargets();
        return {};
      case 'Target.getTargetInfo': {
        if (typeof params.targetId !== 'string') return { targetInfo: BROWSER_TARGET };
        return { targetInfo: this.target(params.targetId).info };
      }
      case 'Target.getTargets':
        return { targetInfos: [...this.targets.values()].map((t) => t.info) };
      case 'Target.attachToTarget':
        return { sessionId: this.target(String(params.targetId)).sessionId };
      case 'Target.detachFromTarget': {
        const target = typeof params.sessionId === 'string' ? this.sessions.get(params.sessionId) : undefined;
        if (target) {
          this.declined.add(target.tab);
          this.dropTarget(target, false);
          await this.request('detach', { tab: target.tab }).catch(() => undefined);
        }
        return {};
      }
      case 'Target.createTarget': {
        const url = typeof params.url === 'string' && params.url ? params.url : 'about:blank';
        const target = this.addTarget(await this.request('create', { url }));
        return { targetId: target.targetId };
      }
      case 'Target.closeTarget':
        await this.request('close', { tab: this.target(String(params.targetId)).tab });
        return { success: true };
      case 'Target.activateTarget':
        await this.request('activate', { tab: this.target(String(params.targetId)).tab });
        return {};
      case 'Target.createBrowserContext':
        throw new CdpError(-32000, 'Agent Debug MCP exposes a single browser context (the attached tabs); use browser.contexts()[0] instead of newContext()');
      case 'Target.attachToBrowserTarget':
      case 'Target.exposeDevToolsProtocol':
        throw new CdpError(-32601, `'${msg.method}' is not supported by the Agent Debug MCP CDP bridge`);
      default: {
        // Other browser-level commands (Browser.*, Storage.*, Emulation on the browser…) are accepted by Chrome on a
        // page session too; route through any attached tab.
        const first = this.targets.values().next().value as Target | undefined;
        if (!first) throw new CdpError(-32000, `'${msg.method}' is unavailable: no tab is attached to Agent Debug MCP yet`);
        return this.link.cdpCommand(first.tab, undefined, msg.method, msg.params);
      }
    }
  }

  private async request(op: CdpOp, opts?: { tab?: TabHandle; url?: string }): Promise<CdpResponse> {
    if (!this.link.connected) {
      throw new CdpError(-32000, 'The Agent Debug MCP Chrome extension is not connected to the relay (is Chrome open with the extension loaded? run `npx agent-debug-mcp doctor`)');
    }
    try {
      return await this.link.cdpRequest(op, opts);
    } catch (e) {
      throw e instanceof CdpError ? e : new CdpError(-32000, (e as Error).message ?? String(e));
    }
  }

  private target(targetId: string): Target {
    const t = this.targets.get(targetId);
    if (!t) throw new CdpError(-32602, `No target with given id found: ${targetId}`);
    return t;
  }

  private addTarget(res: CdpResponse): Target {
    const info = res.targetInfo;
    if (!res.tab || !info || typeof info.targetId !== 'string') throw new CdpError(-32000, 'Extension returned no target info');
    const existing = this.byTab.get(res.tab);
    if (existing) return existing;
    const target: Target = {
      tab: res.tab,
      targetId: info.targetId,
      sessionId: `dtmcp-${res.tab}-${(++this.sessionCounter).toString(36)}`,
      // Playwright asserts on browserContextId and files the page under its default context when the id is unknown.
      info: { ...info, attached: true, browserContextId: typeof info.browserContextId === 'string' ? info.browserContextId : 'Agent Debug MCP' },
    };
    this.targets.set(target.targetId, target);
    this.sessions.set(target.sessionId, target);
    this.byTab.set(target.tab, target);
    this.send({ method: 'Target.attachedToTarget', params: { sessionId: target.sessionId, targetInfo: target.info, waitingForDebugger: false } });
    return target;
  }

  private dropTarget(target: Target, notify = true): void {
    this.targets.delete(target.targetId);
    this.sessions.delete(target.sessionId);
    this.byTab.delete(target.tab);
    for (const [sid, owner] of this.childSessions) if (owner === target) this.childSessions.delete(sid);
    if (notify) this.send({ method: 'Target.detachedFromTarget', params: { sessionId: target.sessionId, targetId: target.targetId } });
  }

  private send(msg: Record<string, unknown>): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }
}

function chromeVersion(userAgent: string): string {
  return /Chrome\/(\S+)/.exec(userAgent)?.[1] ?? '0.0.0.0';
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}
