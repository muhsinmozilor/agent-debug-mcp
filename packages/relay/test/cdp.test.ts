import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { TabHandle } from '@devtools-mcp/protocol';
import { CdpBridge, CdpError, type CdpLink, type CdpOp, type CdpResponse } from '../src/cdp.js';

/** Fake ExtensionLink: one attached tab "t1", records every request/command. */
class FakeLink extends EventEmitter implements CdpLink {
  connected = true;
  tabList: { tab: string }[] = [{ tab: 't1' }];
  tabs = { list: () => this.tabList };
  requests: { op: CdpOp; opts?: { tab?: TabHandle; url?: string } }[] = [];
  commands: { tab: TabHandle; sessionId?: string; method: string; params?: Record<string, unknown> }[] = [];
  nextTabId = 2;

  async cdpRequest(op: CdpOp, opts?: { tab?: TabHandle; url?: string }): Promise<CdpResponse> {
    this.requests.push({ op, opts });
    switch (op) {
      case 'version':
        return { userAgent: 'Mozilla/5.0 Chrome/131.0.6778.1 Safari/537.36' };
      case 'attach':
        return { tab: opts!.tab!, targetInfo: { targetId: `TARGET-${opts!.tab}`, type: 'page', url: 'http://localhost:5199/', title: 'demo', browserContextId: 'CTX' } };
      case 'create': {
        const tab = `t${this.nextTabId++}` as TabHandle;
        this.tabList.push({ tab });
        return { tab, targetInfo: { targetId: `TARGET-${tab}`, type: 'page', url: opts?.url ?? 'about:blank', title: '' } };
      }
      default:
        return { tab: opts?.tab };
    }
  }
  async cdpCommand(tab: TabHandle, sessionId: string | undefined, method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ tab, sessionId, method, params });
    if (method === 'Boom.now') throw new CdpError(-32601, `'${method}' wasn't found`);
    return { echoed: method, tab, sessionId: sessionId ?? null };
  }
}

class Client {
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, (m: Record<string, unknown>) => void>();
  readonly events: Record<string, unknown>[] = [];
  static async connect(url: string, headers?: Record<string, string>): Promise<Client> {
    const c = new Client();
    c.ws = new WebSocket(url, { headers });
    await new Promise<void>((res, rej) => {
      c.ws.once('open', () => res());
      c.ws.once('error', rej);
      c.ws.once('unexpected-response', (_req, r) => rej(new Error(`HTTP ${r.statusCode}`)));
    });
    c.ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as Record<string, unknown>;
      if (typeof m.id === 'number') c.pending.get(m.id)?.(m);
      else c.events.push(m);
    });
    return c;
  }
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<Record<string, unknown>> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((r) => this.pending.set(id, r));
  }
  closed(): Promise<number> {
    return new Promise((r) => this.ws.once('close', (code) => r(code)));
  }
  close(): void {
    this.ws.close();
  }
}

describe('CdpBridge', () => {
  let server: Server;
  let link: FakeLink;
  let bridge: CdpBridge;
  let port: number;
  const TOKEN = 'a'.repeat(32);

  beforeEach(async () => {
    link = new FakeLink();
    bridge = new CdpBridge(link, TOKEN);
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      void bridge.handleHttp(req, res, url.pathname, req.headers.host ?? '').then((h) => {
        if (!h) res.writeHead(404).end();
      });
    });
    server.on('upgrade', (req, socket, head) => bridge.handleUpgrade(req, socket, head, new URL(req.url ?? '/', 'http://127.0.0.1').pathname));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });
  afterEach(async () => {
    bridge.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('serves /json/version with the websocket url and refuses bad tokens', async () => {
    const ok = await fetch(`http://127.0.0.1:${port}/cdp/${TOKEN}/json/version/`).then((r) => r.json() as Promise<Record<string, string>>);
    expect(ok.webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${port}/cdp/${TOKEN}`);
    expect(ok.Browser).toBe('Chrome/131.0.6778.1');
    expect(ok['Protocol-Version']).toBe('1.3');
    const bad = await fetch(`http://127.0.0.1:${port}/cdp/${'b'.repeat(32)}/json/version`);
    expect(bad.status).toBe(401);
    await expect(Client.connect(`ws://127.0.0.1:${port}/cdp/${'b'.repeat(32)}`)).rejects.toThrow(/401/);
    await expect(Client.connect(`ws://127.0.0.1:${port}/cdp/${TOKEN}`, { origin: 'http://evil.localhost' })).rejects.toThrow(/403/);
  });

  it('runs the Playwright connect handshake: version, autoAttach → attachedToTarget per tab, forwarding by session', async () => {
    const c = await Client.connect(`ws://127.0.0.1:${port}/cdp/${TOKEN}`);
    expect(bridge.connected).toBe(true);
    const v = (await c.send('Browser.getVersion')).result as Record<string, string>;
    expect(v.product).toBe('Chrome/131.0.6778.1');

    await c.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    // Event arrives before the reply.
    const attached = c.events.find((e) => e.method === 'Target.attachedToTarget') as { params: { sessionId: string; targetInfo: Record<string, unknown> } };
    expect(attached).toBeDefined();
    expect(attached.params.targetInfo).toMatchObject({ targetId: 'TARGET-t1', type: 'page', attached: true, browserContextId: 'CTX' });
    expect(link.requests.map((r) => r.op)).toEqual(['version', 'attach']);

    const info = (await c.send('Target.getTargetInfo')).result as { targetInfo: { type: string } };
    expect(info.targetInfo.type).toBe('browser');
    expect(((await c.send('Target.getTargets')).result as { targetInfos: unknown[] }).targetInfos).toHaveLength(1);

    // Page-session command → forwarded to the tab's root debugger session; reply carries the sessionId back.
    const sid = attached.params.sessionId;
    const r = await c.send('Page.navigate', { url: 'http://localhost:5199/users' }, sid);
    expect(r.sessionId).toBe(sid);
    expect(r.result).toEqual({ echoed: 'Page.navigate', tab: 't1', sessionId: null });
    expect(link.commands.at(-1)).toMatchObject({ tab: 't1', sessionId: undefined, method: 'Page.navigate' });

    // Errors keep CDP shape.
    const err = await c.send('Boom.now', {}, sid);
    expect(err.error).toEqual({ code: -32601, message: "'Boom.now' wasn't found" });
    expect((await c.send('Page.enable', {}, 'nope')).error).toMatchObject({ code: -32001 });

    // Root-level unknown methods route through the first attached tab.
    expect((await c.send('Storage.getCookies', {})).result).toMatchObject({ echoed: 'Storage.getCookies', tab: 't1' });
    c.close();
  });

  it('routes child sessions, tab lifecycle and target creation', async () => {
    const c = await Client.connect(`ws://127.0.0.1:${port}/cdp/${TOKEN}`);
    await c.send('Target.setAutoAttach', { autoAttach: true, flatten: true });
    const root = (c.events[0] as { params: { sessionId: string } }).params.sessionId;

    // Chrome announces an OOPIF child session on the tab's root session → we remember its owner.
    link.emit('cdp.event', { t: 'cdp.event', tab: 't1', method: 'Target.attachedToTarget', params: { sessionId: 'CHILD1', targetInfo: { type: 'iframe' } } });
    await new Promise((r) => setTimeout(r, 10));
    expect(c.events.at(-1)).toMatchObject({ method: 'Target.attachedToTarget', sessionId: root, params: { sessionId: 'CHILD1' } });
    await c.send('Runtime.enable', {}, 'CHILD1');
    expect(link.commands.at(-1)).toMatchObject({ tab: 't1', sessionId: 'CHILD1', method: 'Runtime.enable' });
    // Events from the child keep Chrome's id.
    link.emit('cdp.event', { t: 'cdp.event', tab: 't1', sessionId: 'CHILD1', method: 'Runtime.executionContextCreated', params: {} });
    await new Promise((r) => setTimeout(r, 10));
    expect(c.events.at(-1)).toMatchObject({ method: 'Runtime.executionContextCreated', sessionId: 'CHILD1' });

    // A newly attached Agent Debug MCP tab is announced automatically.
    link.tabList.push({ tab: 't9' });
    link.emit('tabs');
    await new Promise((r) => setTimeout(r, 20));
    expect(c.events.filter((e) => e.method === 'Target.attachedToTarget' && !e.sessionId)).toHaveLength(2);

    // createTarget → extension opens a tab, attachedToTarget precedes the reply.
    const created = (await c.send('Target.createTarget', { url: 'about:blank' })).result as { targetId: string };
    expect(created.targetId).toBe('TARGET-t2');
    expect(link.requests.at(-1)).toMatchObject({ op: 'create', opts: { url: 'about:blank' } });
    expect((await c.send('Target.closeTarget', { targetId: 'TARGET-t2' })).result).toEqual({ success: true });
    expect(link.requests.at(-1)).toMatchObject({ op: 'close', opts: { tab: 't2' } });

    // Chrome ends a session (tab closed) → detachedFromTarget and its child sessions are forgotten.
    link.emit('cdp.detached', { t: 'cdp.detached', tab: 't1', reason: 'target_closed' });
    await new Promise((r) => setTimeout(r, 10));
    expect(c.events.at(-1)).toMatchObject({ method: 'Target.detachedFromTarget', params: { sessionId: root, targetId: 'TARGET-t1' } });
    expect((await c.send('Runtime.enable', {}, 'CHILD1')).error).toMatchObject({ code: -32001 });

    // DevTools took over t9: do not re-grab it on the next tab-list change.
    link.emit('cdp.detached', { t: 'cdp.detached', tab: 't9', reason: 'replaced_with_devtools' });
    link.emit('tabs');
    await new Promise((r) => setTimeout(r, 20));
    expect(link.requests.filter((r) => r.op === 'attach' && r.opts?.tab === 't9')).toHaveLength(1);

    // Browser.close detaches everything and closes the socket.
    const closed = c.closed();
    await c.send('Browser.close');
    expect(await closed).toBe(1000);
    expect(bridge.connected).toBe(false);
  });

  it('drops the client when the extension disconnects and lets a new client replace an old one', async () => {
    const a = await Client.connect(`ws://127.0.0.1:${port}/cdp/${TOKEN}`);
    const aClosed = a.closed();
    const b = await Client.connect(`ws://127.0.0.1:${port}/cdp/${TOKEN}`);
    expect(await aClosed).toBe(4000);
    const bClosed = b.closed();
    link.emit('disconnected');
    expect(await bClosed).toBe(4010);
    expect(bridge.connected).toBe(false);
  });
});
