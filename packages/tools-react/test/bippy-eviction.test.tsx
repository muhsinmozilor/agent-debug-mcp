/**
 * Regression: the extension bundle imports the `bippy` main entry, whose import side effect
 * auto-installs bippy's minimal hook on globalThis BEFORE initReactHook runs. That hook has no
 * backends/rendererInterfaces/sub, so the official React DevTools backendManager crashes on
 * `hook.backends.has(...)`. initReactHook must evict an untouched bippy auto-hook and put the
 * cooperative official-shaped hook in the slot. This file intentionally does NOT pre-install any
 * hook: it replays the real page flow (bippy import → initReactHook on globalThis).
 */
import './hook-first.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { getReactHookState } from '../src/index.js';

function App() {
  return <i>x</i>;
}

type AnyHook = {
  _installedBy?: string;
  _isBippyHook?: boolean;
  backends?: Map<string, unknown>;
  rendererInterfaces?: Map<number, unknown>;
  sub?: (ev: string, fn: (d: unknown) => void) => () => void;
  renderers: Map<number, { version?: string; reconcilerVersion?: string }>;
};
const hook = (): AnyHook => (globalThis as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: AnyHook }).__REACT_DEVTOOLS_GLOBAL_HOOK__;

beforeAll(async () => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  await act(async () => {
    createRoot(el).render(<App />);
  });
});

describe('bippy auto-hook eviction (real globalThis flow)', () => {
  it('replaces the bippy import-side-effect hook with the cooperative official-shaped one', () => {
    const h = hook();
    expect(h._isBippyHook).not.toBe(true);
    expect(h._installedBy).toBe('agent-debug-mcp');
    expect(h.backends).toBeInstanceOf(Map);
    expect(h.rendererInterfaces).toBeInstanceOf(Map);
    expect(typeof h.sub).toBe('function');
  });
  it('leaves no own hasOwnProperty trap behind', () => {
    // jsdom documents are not "loading", so our diplomacy never arms here; bippy's trap must be gone too.
    expect(Object.getOwnPropertyDescriptor(globalThis, 'hasOwnProperty')).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(globalThis.window ?? globalThis, 'hasOwnProperty')).toBeUndefined();
  });
  it('survives the official backendManager registerRenderer/welcome sequence', () => {
    const h = hook();
    // What backendManager.js does on welcome: renderers.forEach → hook.backends.has(version),
    // hook.backends.forEach, then hook.sub('renderer' | 'devtools-backend-installed' | 'shutdown').
    expect(h.renderers.size).toBeGreaterThan(0);
    expect(() => {
      h.renderers.forEach((r) => h.backends!.has(r.reconcilerVersion || r.version || 'compact'));
      h.backends!.forEach(() => {});
      const u1 = h.sub!('renderer', () => {});
      const u2 = h.sub!('devtools-backend-installed', () => {});
      const u3 = h.sub!('shutdown', () => {});
      u1();
      u2();
      u3();
    }).not.toThrow();
  });
  it('still tracks the renderer through the cooperative hook', () => {
    const s = getReactHookState()!;
    expect(s.renderers.size).toBe(1);
    expect(s.mode).toBe('Agent Debug MCP');
  });
});
