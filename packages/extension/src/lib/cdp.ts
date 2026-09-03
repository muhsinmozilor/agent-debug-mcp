/**
 * CDP bridge, extension half. A CDP client (typically Playwright / `@playwright/mcp --cdp-endpoint`) connects to
 * the relay; the relay synthesises the browser-level Target domain and asks us to attach `chrome.debugger` to the
 * tabs Agent Debug MCP already knows about. Every other CDP command/event is forwarded verbatim — child sessions
 * (OOPIFs, workers; Chrome ≥125 `DebuggerSession.sessionId`) included — so Playwright sees a normal Chrome.
 *
 * Why `chrome.debugger` rather than `--remote-debugging-port`: no Chrome flags, no restart, and the exposed
 * surface is exactly the set of attached dev tabs, not the whole browser. Chrome shows its
 * "Agent Debug MCP started debugging this browser" bar while a client is connected
 * (`--silent-debugger-extension-api` hides it). Opening DevTools on a tab ends our session for that tab
 * (`replaced_with_devtools`) — the relay reports it to the client as a closed page.
 */
import { AgentDebugError, makeFrame, type Frame, type FrameOf, type TabHandle } from '@devtools-mcp/protocol';

const CDP_VERSION = '1.3';

export type CdpTargetInfo = Record<string, unknown> & { targetId: string };

export class CdpSessions {
  /** tabId → handle for every tab whose debugger session we own. */
  private attached = new Map<number, TabHandle>();

  constructor(
    private readonly send: (f: Frame) => void,
    private readonly isAllowedUrl: (url: string) => Promise<boolean>,
  ) {
    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (source.tabId === undefined) return;
      const tab = this.attached.get(source.tabId);
      if (!tab) return;
      const f = makeFrame({ t: 'cdp.event', tab, method });
      if (source.sessionId) f.sessionId = source.sessionId;
      if (params !== undefined) f.params = params;
      this.send(f);
    });
    chrome.debugger.onDetach.addListener((source, reason) => {
      if (source.tabId === undefined) return;
      const tab = this.attached.get(source.tabId);
      if (!tab) return;
      this.attached.delete(source.tabId);
      this.send(makeFrame({ t: 'cdp.detached', tab, reason }));
    });
  }

  get size(): number {
    return this.attached.size;
  }

  async handleRequest(f: FrameOf<'cdp.request'>): Promise<void> {
    const reply = (body: Omit<FrameOf<'cdp.response'>, 'v' | 'id' | 'ts' | 't' | 'requestId'>): void =>
      this.send(makeFrame({ t: 'cdp.response', requestId: f.requestId, ...body }));
    try {
      switch (f.op) {
        case 'version':
          reply({ userAgent: navigator.userAgent });
          return;
        case 'attach': {
          const tabId = tabIdOf(f);
          reply({ tab: f.tab, targetInfo: await this.attach(tabId) });
          return;
        }
        case 'detach': {
          const tabId = tabIdOf(f);
          await this.detach(tabId);
          reply({ tab: f.tab });
          return;
        }
        case 'create': {
          const url = f.url ?? 'about:blank';
          if (url !== 'about:blank' && !(await this.isAllowedUrl(url))) {
            throw new AgentDebugError('INVALID_INPUT', `URL not in the activation allowlist: ${url}`, {
              hint: 'Only localhost/127.0.0.1/*.local, allowlisted origins and about:blank can be opened.',
            });
          }
          const created = await chrome.tabs.create({ url, active: true });
          if (created.id === undefined) throw new AgentDebugError('PAGE_ERROR', 'Chrome did not return a tab id');
          reply({ tab: `t${created.id}`, targetInfo: await this.attach(created.id) });
          return;
        }
        case 'close': {
          const tabId = tabIdOf(f);
          await chrome.tabs.remove(tabId);
          reply({ tab: f.tab });
          return;
        }
        case 'activate': {
          const tabId = tabIdOf(f);
          await chrome.tabs.update(tabId, { active: true });
          reply({ tab: f.tab });
          return;
        }
      }
    } catch (e) {
      reply({ tab: f.tab, error: AgentDebugError.from(e).toJSON() });
    }
  }

  async handleCommand(f: FrameOf<'cdp.command'>): Promise<void> {
    const tabId = Number(f.tab.slice(1));
    const reply = (body: Omit<FrameOf<'cdp.result'>, 'v' | 'id' | 'ts' | 't' | 'cmdId'>): void =>
      this.send(makeFrame({ t: 'cdp.result', cmdId: f.cmdId, ...body }));
    if (!this.attached.has(tabId)) {
      reply({ error: { code: -32001, message: `Session with given id not found (tab ${f.tab} is not attached)` } });
      return;
    }
    const target: chrome.debugger.DebuggerSession = f.sessionId ? { tabId, sessionId: f.sessionId } : { tabId };
    try {
      const result = await chrome.debugger.sendCommand(target, f.method, f.params);
      reply({ result: result ?? {} });
    } catch (e) {
      reply({ error: toCdpError(e) });
    }
  }

  /** Drop every session (relay gone). Chrome hides its debugging bar once the last one is detached. */
  async detachAll(): Promise<void> {
    const ids = [...this.attached.keys()];
    this.attached.clear();
    await Promise.all(ids.map((tabId) => chrome.debugger.detach({ tabId }).catch(() => undefined)));
  }

  private async attach(tabId: number): Promise<CdpTargetInfo> {
    const found = await chrome.tabs.get(tabId).catch(() => null);
    if (!found) throw new AgentDebugError('TAB_NOT_FOUND', `Tab t${tabId} no longer exists`, { hint: 'Call tabs_list to see attached tabs.' });
    if (!this.attached.has(tabId)) {
      try {
        await chrome.debugger.attach({ tabId }, CDP_VERSION);
      } catch (e) {
        const message = (e as Error).message ?? String(e);
        throw new AgentDebugError('PAGE_ERROR', `Could not attach the debugger to tab t${tabId}: ${message}`, {
          hint: /already attached/i.test(message)
            ? 'Another debugger (Chrome DevTools or another extension) is attached to this tab. Close it and reconnect the CDP client.'
            : /not allowed|cannot|restricted|policy/i.test(message)
              ? 'Chrome does not allow debugging this page (Chrome-internal pages, the Web Store and policy-blocked URLs).'
              : 'Reload the tab and reconnect the CDP client.',
          retryable: true,
        });
      }
      this.attached.set(tabId, `t${tabId}`);
    }
    const res = (await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo')) as { targetInfo?: CdpTargetInfo } | undefined;
    if (!res?.targetInfo?.targetId) {
      await this.detach(tabId);
      throw new AgentDebugError('PAGE_ERROR', `Target.getTargetInfo returned nothing for tab t${tabId}`);
    }
    return res.targetInfo;
  }

  private async detach(tabId: number): Promise<void> {
    if (!this.attached.delete(tabId)) return;
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
  }
}

function tabIdOf(f: FrameOf<'cdp.request'>): number {
  if (!f.tab) throw new AgentDebugError('INVALID_INPUT', `cdp.request ${f.op} needs a tab`);
  return Number(f.tab.slice(1));
}

/** chrome.debugger surfaces protocol errors as an Error whose message is the JSON `{code, message}` object. */
function toCdpError(e: unknown): { code: number; message: string; data?: unknown } {
  const message = (e as Error)?.message ?? String(e);
  try {
    const parsed = JSON.parse(message) as { code?: unknown; message?: unknown; data?: unknown };
    if (typeof parsed.code === 'number' && typeof parsed.message === 'string') {
      return parsed.data === undefined ? { code: parsed.code, message: parsed.message } : { code: parsed.code, message: parsed.message, data: parsed.data };
    }
  } catch {
    /* plain message */
  }
  return { code: -32000, message };
}
