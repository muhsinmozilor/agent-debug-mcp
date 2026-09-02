/**
 * MAIN-world content script. Runs at document_start before the page's JavaScript so the React
 * DevTools hook exists when React loads. Owns the page-side ToolRegistry and talks to the ISOLATED
 * content script over a MessageChannel established with a nonce handshake.
 */
import { defineContentScript } from 'wxt/utils/define-content-script';
import {
  DevtoolsError,
  ErrorLog,
  HANDSHAKE_KEY,
  HandshakeSchema,
  makeFrame,
  parseFrame,
  type Frame,
} from '@devtools-mcp/protocol';
import { createReactTools, hasReact, initReactHook, installErrorCapture, onReactCapabilityChange } from '@devtools-mcp/tools-react';
import { captureQueryErrors, createTanstackQueryTools, findQueryClient, watchQueryClient } from '@devtools-mcp/tools-tanstack-query';
import { captureRouterErrors, createTanstackRouterTools, findRouter, watchRouter } from '@devtools-mcp/tools-tanstack-router';
import { ToolRegistry } from '../lib/registry';
import { DEV_MATCHES } from '../lib/constants';

declare const __EXT_VERSION__: string | undefined;

export default defineContentScript({
  matches: DEV_MATCHES,
  runAt: 'document_start',
  world: 'MAIN',
  allFrames: false,
  main() {
    if ((window as unknown as { __DTMCP_MAIN__?: boolean }).__DTMCP_MAIN__) return;
    (window as unknown as { __DTMCP_MAIN__?: boolean }).__DTMCP_MAIN__ = true;

    const docId = crypto.randomUUID();
    initReactHook();
    // Error capture must be in place before the app's first console.error / thrown error (we run at document_start).
    const errors = new ErrorLog(200);
    installErrorCapture(errors);

    const registry = new ToolRegistry();
    registry.add(...createReactTools({ docId, errors }), ...createTanstackQueryTools({ docId }), ...createTanstackRouterTools({ docId }));
    registry.setCapability('react', hasReact());
    onReactCapabilityChange((present) => registry.setCapability('react', present));
    // TanStack Query: the app sets window.__TANSTACK_QUERY_CLIENT__ some time after our script runs.
    const startQueryWatch = (): void => {
      watchQueryClient((present) => {
        registry.setCapability('tanstack_query', present);
        const client = present ? findQueryClient() : null;
        if (client) captureQueryErrors(errors, client);
      });
      watchRouter((present) => {
        registry.setCapability('tanstack_router', present);
        const router = present ? findRouter() : null;
        if (router) captureRouterErrors(errors, router);
      });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startQueryWatch, { once: true });
    else startQueryWatch();


    let port: MessagePort | null = null;
    const inflight = new Map<string, AbortController>();

    const send = (frame: Frame): void => {
      port?.postMessage(frame);
    };

    const sendSnapshot = (): void => {
      const s = registry.snapshot();
      send(makeFrame({ t: 'registry.snapshot', tab: 't0', doc: docId, gen: s.gen, capabilities: s.capabilities, tools: s.tools }));
    };
    registry.onChange((s) => {
      // Full snapshots are cheap (≤ a few KB); diffs are an optimisation for later.
      send(makeFrame({ t: 'registry.snapshot', tab: 't0', doc: docId, gen: s.gen, capabilities: s.capabilities, tools: s.tools }));
    });

    const onFrame = async (frame: Frame): Promise<void> => {
      switch (frame.t) {
        case 'registry.request_snapshot':
          sendSnapshot();
          return;
        case 'invoke': {
          const ac = new AbortController();
          inflight.set(frame.callId, ac);
          let seq = 0;
          const progress = (u: { progress?: number; total?: number; message?: string; data?: unknown }): void => {
            send(makeFrame({ t: 'invoke.progress', callId: frame.callId, seq: seq++, ...u }));
          };
          try {
            const { result, truncated } = await registry.execute(frame.tool, frame.input, { signal: ac.signal, progress });
            if (ac.signal.aborted) return;
            const out = makeFrame({ t: 'invoke.result', callId: frame.callId, doc: docId, result });
            if (truncated) out.truncated = true;
            send(out);
          } catch (e) {
            if (ac.signal.aborted) return;
            send(makeFrame({ t: 'invoke.error', callId: frame.callId, error: DevtoolsError.from(e).toJSON() }));
          } finally {
            inflight.delete(frame.callId);
          }
          return;
        }
        case 'invoke.cancel':
          inflight.get(frame.callId)?.abort();
          inflight.delete(frame.callId);
          return;
        case 'ping':
          send(makeFrame({ t: 'pong', n: frame.n }));
          return;
        default:
          return;
      }
    };

    // ---- handshake with the ISOLATED script ----
    const onWindowMessage = (ev: MessageEvent): void => {
      if (ev.source !== window) return;
      const hs = HandshakeSchema.safeParse(ev.data);
      if (!hs.success || hs.data[HANDSHAKE_KEY] !== 'hs') return;
      const p = ev.ports[0];
      if (!p || port) return; // accept only the first channel
      port = p;
      window.removeEventListener('message', onWindowMessage);
      port.onmessage = (m: MessageEvent) => {
        const f = parseFrame(m.data);
        if (f) void onFrame(f);
      };
      port.start();
      // Echo the nonce so the ISOLATED side can tell which channel the page adopted.
      send(
        makeFrame({
          t: 'hello',
          role: 'page',
          token: hs.data.nonce,
          extVersion: typeof __EXT_VERSION__ === 'string' ? __EXT_VERSION__ : '0.0.0',
          protocolVersion: 1,
          resumeId: docId,
        }),
      );
      sendSnapshot();
    };
    window.addEventListener('message', onWindowMessage);
    window.postMessage({ [HANDSHAKE_KEY]: 'ready', doc: docId }, location.origin);
  },
});
