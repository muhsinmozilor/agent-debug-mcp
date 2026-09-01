/**
 * ISOLATED-world content script: the trust boundary between the page (MAIN world) and the
 * extension. Validates every frame from the page, stamps tab lifecycle, enforces the mutation gate
 * and relays to the service worker over a long-lived Port.
 */
import { defineContentScript } from 'wxt/utils/define-content-script';
import { HANDSHAKE_KEY, HandshakeSchema, makeFrame, parseFrame, type Frame } from '@devtools-mcp/protocol';
import { reactToolMetas } from '@devtools-mcp/tools-react/descriptors';
import { tanstackQueryToolMetas } from '@devtools-mcp/tools-tanstack-query/descriptors';
import { tanstackRouterToolMetas } from '@devtools-mcp/tools-tanstack-router/descriptors';
import { DEV_MATCHES, PORT_NAME } from '../lib/constants';
import { getSettings } from '../lib/storage';

/** Built-in knowledge of which tools mutate — never trust the page's own descriptor for gating. */
const MUTATION_TOOLS = new Set<string>([...reactToolMetas, ...tanstackQueryToolMetas, ...tanstackRouterToolMetas].filter((m) => m.mutation).map((m) => m.name));

export default defineContentScript({
  matches: DEV_MATCHES,
  runAt: 'document_start',
  allFrames: false,
  main() {
    let docId: string | null = null;
    let pagePort: MessagePort | null = null;
    const pending = new Map<string, MessagePort>(); // nonce -> port1 awaiting the page's hello
    let swPort: chrome.runtime.Port | null = null;
    let swBackoff = 500;
    const toSwQueue: Frame[] = [];
    let mutationsAllowed = true;
    const refreshMutationGate = async (): Promise<void> => {
      try {
        const s = await getSettings();
        const next = !s.mutationDeniedOrigins.includes(location.origin);
        if (next !== mutationsAllowed) {
          mutationsAllowed = next;
          announce();
        }
      } catch {
        /* storage unavailable (context invalidated) */
      }
    };
    void refreshMutationGate();
    chrome.storage.onChanged.addListener((_changes, area) => {
      if (area === 'local') void refreshMutationGate();
    });

    // ---------- SW port ----------
    const connectSw = (): void => {
      try {
        swPort = chrome.runtime.connect({ name: PORT_NAME });
      } catch {
        swPort = null;
        scheduleReconnect();
        return;
      }
      swBackoff = 500;
      swPort.onMessage.addListener((msg: unknown) => {
        const f = parseFrame(msg);
        if (!f) return;
        if (f.t === 'invoke' && MUTATION_TOOLS.has(f.tool) && !mutationsAllowed) {
          toSw(
            makeFrame({
              t: 'invoke.error',
              callId: f.callId,
              error: {
                code: 'MUTATIONS_DISABLED',
                message: `Mutation tools are disabled for ${location.origin}`,
                hint: 'Enable "Allow mutations" for this origin in the Agent Debug MCP popup.',
                retryable: false,
              },
            }),
          );
          return;
        }
        // frames destined for the page
        pagePort?.postMessage(f);
      });
      swPort.onDisconnect.addListener(() => {
        swPort = null;
        scheduleReconnect();
      });
      if (docId) {
        announce();
        // Ask the page for a fresh registry so the (possibly restarted) SW re-syncs the relay.
        pagePort?.postMessage(makeFrame({ t: 'registry.request_snapshot', tab: 't0' }));
      }
      flushQueue();
    };
    const scheduleReconnect = (): void => {
      if (!chrome.runtime?.id) return; // extension context invalidated (reloaded/uninstalled)
      setTimeout(connectSw, swBackoff);
      swBackoff = Math.min(swBackoff * 2, 10_000);
    };
    const toSw = (f: Frame): void => {
      if (swPort) {
        try {
          swPort.postMessage(f);
          return;
        } catch {
          swPort = null;
        }
      }
      toSwQueue.push(f);
      if (toSwQueue.length > 200) toSwQueue.shift();
    };
    const flushQueue = (): void => {
      while (swPort && toSwQueue.length) {
        const f = toSwQueue.shift() as Frame;
        try {
          swPort.postMessage(f);
        } catch {
          swPort = null;
          toSwQueue.unshift(f);
          return;
        }
      }
    };
    const announce = (): void => {
      if (!docId) return;
      toSw(
        makeFrame({
          t: 'tab.attached',
          tab: 't0',
          doc: docId,
          url: location.href,
          title: document.title,
          mutationsAllowed,
        }),
      );
    };

    // ---------- page handshake ----------
    const offerChannel = (): void => {
      const channel = new MessageChannel();
      const nonce = crypto.randomUUID() + crypto.randomUUID();
      pending.set(nonce, channel.port1);
      channel.port1.onmessage = (m: MessageEvent) => onPageFrame(nonce, channel.port1, m.data);
      channel.port1.start();
      window.postMessage({ [HANDSHAKE_KEY]: 'hs', nonce }, location.origin, [channel.port2]);
    };

    const onPageFrame = (nonce: string, p: MessagePort, data: unknown): void => {
      const f = parseFrame(data);
      if (!f) return;
      if (!pagePort) {
        // Adopt the channel the page answered on.
        if (f.t !== 'hello' || f.role !== 'page' || f.token !== nonce || !pending.has(nonce)) return;
        pagePort = p;
        for (const [n, other] of pending) if (n !== nonce) other.close();
        pending.clear();
        docId = f.resumeId ?? crypto.randomUUID();
        announce();
        return;
      }
      if (p !== pagePort) return;
      // Frames from the page → SW (allow-list of frame types the page may emit).
      switch (f.t) {
        case 'registry.snapshot':
        case 'registry.diff':
        case 'invoke.result':
        case 'invoke.error':
        case 'invoke.progress':
        case 'pong':
          toSw(f);
          return;
        default:
          return;
      }
    };

    // Re-offer when the page announces readiness (it may have loaded after our first offer).
    window.addEventListener('message', (ev: MessageEvent) => {
      if (ev.source !== window || pagePort) return;
      const hs = HandshakeSchema.safeParse(ev.data);
      if (hs.success && hs.data[HANDSHAKE_KEY] === 'ready') offerChannel();
    });
    offerChannel();

    // ---------- lifecycle ----------
    window.addEventListener('pagehide', (ev: PageTransitionEvent) => {
      if (!docId) return;
      toSw(
        ev.persisted
          ? makeFrame({ t: 'tab.frozen', tab: 't0', doc: docId })
          : makeFrame({ t: 'tab.detached', tab: 't0', doc: docId, reason: 'unload' }),
      );
    });
    window.addEventListener('pageshow', (ev: PageTransitionEvent) => {
      if (ev.persisted && docId) toSw(makeFrame({ t: 'tab.resumed', tab: 't0', doc: docId }));
    });
    document.addEventListener('DOMContentLoaded', () => announce(), { once: true });
    // Title changes after load (SPAs) — keep the relay's tab list fresh.
    new MutationObserver(() => announce()).observe(document.documentElement, { childList: true, subtree: false });

    // ---------- pairing page (relay's /pair) ----------
    const tryPair = (): void => {
      const token = document.querySelector('meta[name="dtmcp-pair"]')?.getAttribute('content');
      const relayUrl = document.querySelector('meta[name="dtmcp-relay"]')?.getAttribute('content');
      if (token && relayUrl && /^(127\.0\.0\.1|localhost)$/.test(location.hostname)) {
        void chrome.runtime.sendMessage({ kind: 'pair', relayUrl, token, auto: true }).catch(() => undefined);
      }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tryPair, { once: true });
    else tryPair();

    connectSw();
  },
});
