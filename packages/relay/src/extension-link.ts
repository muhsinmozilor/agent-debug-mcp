/**
 * The relay's view of the (single) connected extension: WebSocket auth, heartbeat, tab registry
 * updates, invoke routing and the CDP bridge's requests/commands.
 */
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  DEFAULTS,
  DevtoolsError,
  makeFrame,
  parseFrame,
  PROTOCOL_VERSION,
  type Frame,
  type TabHandle,
} from '@devtools-mcp/protocol';
import { CdpError, type CdpLink, type CdpOp, type CdpResponse } from './cdp.js';
import { InvokeTracker, type PendingCall, type ProgressUpdate } from './invoke.js';
import { log } from './log.js';
import { TabRegistry } from './tabs.js';
import type { RelayConfig } from './config.js';
import { saveConfig } from './config.js';

const STALE_GRACE_MS = 5000;

export interface ExtensionLinkOptions {
  config: RelayConfig;
  relayVersion: string;
  heartbeatMs?: number;
}

export class ExtensionLink extends EventEmitter implements CdpLink {
  readonly tabs = new TabRegistry();
  readonly calls = new InvokeTracker();
  private socket: WebSocket | null = null;
  private wss: WebSocketServer;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongDeadline: ReturnType<typeof setTimeout> | null = null;
  private pruneTimer: ReturnType<typeof setTimeout> | null = null;
  private pingCounter = 0;
  private resumeId: string | null = null;
  private openRequests = new Map<string, { resolve: (tab: TabHandle) => void; reject: (e: DevtoolsError) => void; timer: ReturnType<typeof setTimeout> }>();
  private cdpRequests = new Map<string, { resolve: (r: CdpResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private cdpCommands = new Map<number, { resolve: (r: unknown) => void; reject: (e: CdpError) => void }>();
  private cdpCmdCounter = 0;
  /** Registry snapshots that arrived before their tab.attached (defensive against ordering races). */
  private earlySnapshots = new Map<string, Extract<Frame, { t: 'registry.snapshot' }>>();
  /** Last extension id refused by the id pin (surfaced on /health so `doctor` can print the --allow-extension fix). */
  private rejectedExtensionId: string | null = null;

  constructor(private readonly opts: ExtensionLinkOptions) {
    super();
    this.wss = new WebSocketServer({ noServer: true, maxPayload: DEFAULTS.maxFrameBytes });
  }

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === this.socket.OPEN && this.resumeId !== null;
  }

  get lastRejectedExtensionId(): string | null {
    return this.rejectedExtensionId;
  }

  /** Called by the HTTP server on `upgrade` for /ws. */
  handleUpgrade(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    const origin = req.headers.origin ?? '';
    if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
      log('warn', `rejected WS upgrade from origin "${origin}"`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const extId = origin.slice('chrome-extension://'.length);
    if (this.opts.config.extensionIds.length > 0 && !this.opts.config.extensionIds.includes(extId)) {
      this.rejectedExtensionId = extId;
      log('warn', `rejected WS upgrade from unpinned extension ${extId} (allow with --allow-extension ${extId})`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, extId));
  }

  private accept(ws: WebSocket, extId: string): void {
    let authed = false;
    const authTimer = setTimeout(() => {
      if (!authed) ws.close(4001, 'hello timeout');
    }, 5000);

    ws.on('message', (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        return;
      }
      const frame = parseFrame(raw);
      if (!frame) return;
      if (!authed) {
        if (frame.t !== 'hello' || frame.role !== 'extension') return;
        if (frame.token !== this.opts.config.token) {
          ws.send(JSON.stringify(makeFrame({ t: 'hello_reject', code: 'UNAUTHORIZED', message: 'Invalid pairing token' })));
          ws.close(4003, 'unauthorized');
          return;
        }
        if (frame.protocolVersion !== PROTOCOL_VERSION) {
          ws.send(JSON.stringify(makeFrame({ t: 'hello_reject', code: 'VERSION_MISMATCH', message: `Relay speaks protocol v${PROTOCOL_VERSION}` })));
          ws.close(4004, 'version');
          return;
        }
        authed = true;
        clearTimeout(authTimer);
        if (this.rejectedExtensionId === extId) this.rejectedExtensionId = null;
        if (!this.opts.config.extensionIds.includes(extId)) {
          this.opts.config.extensionIds.push(extId);
          saveConfig(this.opts.config);
          log('info', `paired extension ${extId}`);
        }
        this.replaceSocket(ws, frame.resumeId ?? null, frame.extVersion);
        ws.send(
          JSON.stringify(
            makeFrame({
              t: 'hello_ack',
              relayVersion: this.opts.relayVersion,
              serverTime: Date.now(),
              heartbeatMs: this.opts.heartbeatMs ?? DEFAULTS.heartbeatMs,
              maxFrameBytes: DEFAULTS.maxFrameBytes,
            }),
          ),
        );
        return;
      }
      this.onFrame(frame);
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      if (this.socket === ws) this.onDisconnect();
    });
    ws.on('error', (e) => log('warn', `ws error: ${(e as Error).message}`));
  }

  private replaceSocket(ws: WebSocket, resumeId: string | null, extVersion: string): void {
    const prev = this.socket;
    const sameSession = resumeId !== null && resumeId === this.resumeId;
    this.socket = ws;
    this.resumeId = resumeId ?? `anon-${Date.now()}`;
    if (prev && prev !== ws) {
      try {
        prev.close(4000, 'replaced');
      } catch {
        /* ignore */
      }
    }
    if (this.pruneTimer) {
      clearTimeout(this.pruneTimer);
      this.pruneTimer = null;
    }
    if (!sameSession) {
      // New extension session (SW restart or reinstall): in-flight calls cannot complete.
      this.calls.failAll(new DevtoolsError('EXTENSION_RESTARTED', 'The extension restarted while the call was in flight'));
    }
    this.startHeartbeat();
    log('info', `extension connected (v${extVersion}, resume=${resumeId ?? 'none'}, sameSession=${sameSession})`);
    this.emit('connected');
  }

  private onDisconnect(): void {
    log('info', 'extension disconnected');
    this.socket = null;
    this.stopHeartbeat();
    this.tabs.markAllStale();
    this.pruneTimer = setTimeout(() => {
      const removed = this.tabs.pruneStale(STALE_GRACE_MS);
      if (removed.length) log('info', `dropped ${removed.length} stale tab(s)`);
      this.emit('tabs');
    }, STALE_GRACE_MS + 50);
    this.calls.failAll(new DevtoolsError('EXTENSION_DISCONNECTED', 'The extension disconnected while the call was in flight'));
    this.failCdp('The extension disconnected');
    this.emit('disconnected');
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const every = this.opts.heartbeatMs ?? DEFAULTS.heartbeatMs;
    this.pingTimer = setInterval(() => {
      if (!this.socket) return;
      const n = ++this.pingCounter;
      this.send(makeFrame({ t: 'ping', n }));
      if (this.pongDeadline) clearTimeout(this.pongDeadline);
      this.pongDeadline = setTimeout(() => {
        log('warn', 'heartbeat timeout; closing extension socket');
        this.socket?.terminate();
      }, DEFAULTS.heartbeatTimeoutMs);
    }, every);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongDeadline) clearTimeout(this.pongDeadline);
    this.pingTimer = null;
    this.pongDeadline = null;
  }

  private send(frame: Frame): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify(frame));
  }

  private onFrame(frame: Frame): void {
    if (this.calls.handle(frame)) return;
    switch (frame.t) {
      case 'pong':
        if (this.pongDeadline) {
          clearTimeout(this.pongDeadline);
          this.pongDeadline = null;
        }
        return;
      case 'tabs.snapshot':
        this.tabs.applySnapshot(frame.tabs);
        this.emit('tabs');
        return;
      case 'tab.attached': {
        const prev = this.tabs.get(frame.tab as TabHandle);
        const early = this.earlySnapshots.get(frame.tab);
        this.earlySnapshots.delete(frame.tab);
        this.tabs.upsert({
          tab: frame.tab,
          doc: frame.doc,
          url: frame.url,
          title: frame.title,
          active: prev?.active ?? false,
          windowId: prev?.windowId ?? -1,
          capabilities: prev && prev.doc === frame.doc ? prev.capabilities : [],
          mutationsAllowed: frame.mutationsAllowed,
          state: 'attached',
          registryGen: prev && prev.doc === frame.doc ? prev.registryGen : 0,
        });
        if (early && early.doc === frame.doc) {
          this.tabs.replaceRegistry(frame.tab as TabHandle, early.doc, early.gen, early.capabilities, early.tools);
        }
        this.emit('tabs');
        return;
      }
      case 'tab.navigated':
        this.calls.failAll(new DevtoolsError('DOC_CHANGED', 'The page navigated while the call was in flight'), (p) => p.tab === frame.tab);
        this.tabs.navigate(frame.tab as TabHandle, frame.doc, frame.url, frame.title);
        this.emit('tabs');
        return;
      case 'tab.frozen':
        this.tabs.setState(frame.tab as TabHandle, 'frozen');
        return;
      case 'tab.resumed':
        this.tabs.setState(frame.tab as TabHandle, 'attached');
        return;
      case 'tab.detached':
        this.calls.failAll(new DevtoolsError('TAB_NOT_FOUND', 'The tab closed while the call was in flight'), (p) => p.tab === frame.tab);
        this.tabs.remove(frame.tab as TabHandle);
        this.emit('tabs');
        return;
      case 'registry.snapshot':
        if (!this.tabs.get(frame.tab as TabHandle)) this.earlySnapshots.set(frame.tab, frame);
        else this.tabs.replaceRegistry(frame.tab as TabHandle, frame.doc, frame.gen, frame.capabilities, frame.tools);
        this.emit('tabs');
        return;
      case 'registry.diff':
        this.tabs.setRegistry(frame.tab as TabHandle, frame.doc, frame.gen, frame.capabilities, frame.added, frame.removed);
        this.emit('tabs');
        return;
      case 'tab.open_result': {
        const req = this.openRequests.get(frame.requestId);
        if (!req) return;
        clearTimeout(req.timer);
        this.openRequests.delete(frame.requestId);
        if (frame.error) req.reject(DevtoolsError.from(frame.error));
        else if (frame.tab) req.resolve(frame.tab as TabHandle);
        else req.reject(new DevtoolsError('PAGE_ERROR', 'Extension returned neither a tab nor an error'));
        return;
      }
      case 'cdp.response': {
        const req = this.cdpRequests.get(frame.requestId);
        if (!req) return;
        clearTimeout(req.timer);
        this.cdpRequests.delete(frame.requestId);
        if (frame.error) req.reject(DevtoolsError.from(frame.error));
        else {
          const res: CdpResponse = {};
          if (frame.tab) res.tab = frame.tab as TabHandle;
          if (frame.targetInfo) res.targetInfo = frame.targetInfo;
          if (frame.userAgent !== undefined) res.userAgent = frame.userAgent;
          req.resolve(res);
        }
        return;
      }
      case 'cdp.result': {
        const cmd = this.cdpCommands.get(frame.cmdId);
        if (!cmd) return;
        this.cdpCommands.delete(frame.cmdId);
        if (frame.error) cmd.reject(new CdpError(frame.error.code, frame.error.message, frame.error.data));
        else cmd.resolve(frame.result ?? {});
        return;
      }
      case 'cdp.event':
        this.emit('cdp.event', frame);
        return;
      case 'cdp.detached':
        this.emit('cdp.detached', frame);
        return;
      default:
        return;
    }
  }

  /** Cancel an in-flight call (client-side cancellation received out of band). */
  cancelCall(callId: string, reason: 'client' | 'timeout' | 'tab_gone' = 'client'): boolean {
    const p = this.calls.cancel(callId, new DevtoolsError('CANCELLED', 'The client cancelled the request'));
    if (!p) return false;
    this.send(makeFrame({ t: 'invoke.cancel', callId, tab: p.tab as TabHandle, reason }));
    return true;
  }

  /** Ask the extension to open a tab; resolves with its handle once Chrome created it. */
  openTab(url: string, timeoutMs = 10_000): Promise<TabHandle> {
    if (!this.connected) {
      return Promise.reject(new DevtoolsError('EXTENSION_DISCONNECTED', 'The Agent Debug MCP Chrome extension is not connected to this relay'));
    }
    const requestId = this.calls.nextCallId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.openRequests.delete(requestId);
        reject(new DevtoolsError('TIMEOUT', 'The extension did not open the tab in time'));
      }, timeoutMs);
      this.openRequests.set(requestId, { resolve, reject, timer });
      this.send(makeFrame({ t: 'tab.open', requestId, url }));
    });
  }

  // ---- CDP bridge ----

  /** Browser-level CDP operation carried out by the service worker (attach/detach debugger, open/close/activate a tab). */
  cdpRequest(op: CdpOp, opts: { tab?: TabHandle; url?: string } = {}, timeoutMs = 15_000): Promise<CdpResponse> {
    if (!this.connected) {
      return Promise.reject(new DevtoolsError('EXTENSION_DISCONNECTED', 'The Agent Debug MCP Chrome extension is not connected to this relay'));
    }
    const requestId = this.calls.nextCallId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cdpRequests.delete(requestId);
        reject(new DevtoolsError('TIMEOUT', `The extension did not answer cdp.request ${op} within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.cdpRequests.set(requestId, { resolve, reject, timer });
      const frame = makeFrame({ t: 'cdp.request', requestId, op });
      if (opts.tab) frame.tab = opts.tab;
      if (opts.url) frame.url = opts.url;
      this.send(frame);
    });
  }

  /** Forward one CDP command to a tab's debugger session (or a child session inside it). No relay-side timeout: CDP clients manage their own. */
  cdpCommand(tab: TabHandle, sessionId: string | undefined, method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) return Promise.reject(new CdpError(-32000, 'The Agent Debug MCP Chrome extension is not connected to the relay'));
    const cmdId = ++this.cdpCmdCounter;
    return new Promise((resolve, reject) => {
      this.cdpCommands.set(cmdId, { resolve, reject });
      const frame = makeFrame({ t: 'cdp.command', cmdId, tab, method });
      if (sessionId) frame.sessionId = sessionId;
      if (params !== undefined) frame.params = params;
      this.send(frame);
    });
  }

  private failCdp(why: string): void {
    for (const [id, req] of this.cdpRequests) {
      clearTimeout(req.timer);
      this.cdpRequests.delete(id);
      req.reject(new DevtoolsError('EXTENSION_DISCONNECTED', `${why} while the CDP request was in flight`));
    }
    for (const [id, cmd] of this.cdpCommands) {
      this.cdpCommands.delete(id);
      cmd.reject(new CdpError(-32000, `${why} while the CDP command was in flight`));
    }
  }

  /** Wait until a tab has synced its registry (and optionally a capability). */
  async waitForTab(tab: TabHandle, opts: { capability?: string; timeoutMs: number }): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < opts.timeoutMs) {
      const rec = this.tabs.get(tab);
      if (rec && rec.tools.size > 0 && (!opts.capability || rec.capabilities.includes(opts.capability as never))) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Invoke a tool on a tab. Resolves with the page's encoded result. */
  invoke(
    tab: TabHandle,
    tool: string,
    input: unknown,
    options: { timeoutMs: number; signal?: AbortSignal; onProgress?: (u: ProgressUpdate) => void; progressToken?: string; onStart?: (callId: string) => void },
  ): Promise<{ result: unknown; doc: string; truncated: boolean }> {
    if (!this.connected) {
      return Promise.reject(
        new DevtoolsError('EXTENSION_DISCONNECTED', 'The Agent Debug MCP Chrome extension is not connected to this relay', {
          hint: 'Make sure Chrome is open with the Agent Debug MCP extension loaded — it pairs with a relay on 127.0.0.1:9333 by itself. For another host/port, click Pair in the extension popup or open the relay\'s /pair URL. Run `npx agent-debug-mcp doctor` to see which link is broken.',
        }),
      );
    }
    const callId = this.calls.nextCallId();
    const startedAt = Date.now();
    const deadlineAt = startedAt + options.timeoutMs;
    options.onStart?.(callId);
    return new Promise((resolve, reject) => {
      const pending = this.calls.track(
        { callId, tab, tool, startedAt, deadlineAt, resolve, reject, onProgress: options.onProgress },
        (p: PendingCall) => this.send(makeFrame({ t: 'invoke.cancel', callId: p.callId, tab: p.tab as TabHandle, reason: 'timeout' })),
      );
      const onAbort = (): void => {
        this.calls.cancel(pending.callId, new DevtoolsError('CANCELLED', 'The client cancelled the request'));
        this.send(makeFrame({ t: 'invoke.cancel', callId: pending.callId, tab, reason: 'client' }));
      };
      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
      const frame = makeFrame({ t: 'invoke', callId, tab, tool, input, deadlineAt });
      if (options.progressToken) frame.progressToken = options.progressToken;
      this.send(frame);
    });
  }

  close(): void {
    this.stopHeartbeat();
    if (this.pruneTimer) clearTimeout(this.pruneTimer);
    this.calls.failAll(new DevtoolsError('EXTENSION_DISCONNECTED', 'Relay shutting down'));
    this.failCdp('Relay shutting down');
    this.socket?.close(1001, 'relay shutting down');
    this.wss.close();
  }
}
