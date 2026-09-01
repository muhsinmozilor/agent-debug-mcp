/**
 * Install-then-takeover: we install first (no official hook), then the official DevTools installer
 * claims the slot before React loads. State must rebind to the official hook and keep tracking.
 */
import { describe, expect, it } from 'vitest';
import { getReactHookState, initReactHook, onReactCapabilityChange } from '../src/hook.js';

const HOOK = '__REACT_DEVTOOLS_GLOBAL_HOOK__';

function makeOfficialHook() {
  const renderers = new Map<number, unknown>();
  const fiberRoots = new Map<number, Set<unknown>>();
  const listeners: Record<string, ((d: unknown) => void)[]> = {};
  let uid = 0;
  const hook = {
    renderers,
    rendererInterfaces: new Map(),
    backends: new Map(),
    listeners,
    supportsFiber: true,
    checkDCE() {},
    inject(renderer: unknown) {
      const id = ++uid;
      renderers.set(id, renderer);
      hook.emit('renderer', { id, renderer });
      return id;
    },
    getFiberRoots(id: number) {
      let s = fiberRoots.get(id);
      if (!s) fiberRoots.set(id, (s = new Set()));
      return s;
    },
    on(ev: string, fn: (d: unknown) => void) {
      (listeners[ev] ??= []).push(fn);
    },
    off(ev: string, fn: (d: unknown) => void) {
      listeners[ev] = (listeners[ev] ?? []).filter((f) => f !== fn);
    },
    sub(ev: string, fn: (d: unknown) => void) {
      hook.on(ev, fn);
      return () => hook.off(ev, fn);
    },
    emit(ev: string, data: unknown) {
      for (const fn of listeners[ev] ?? []) fn(data);
    },
    onCommitFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
  };
  return hook;
}

describe('hook takeover rebind', () => {
  it('rebinds state when the official hook replaces ours before React loads', () => {
    const target = {} as typeof globalThis;
    const first = initReactHook(target);
    expect(first.mode).toBe('Agent Debug MCP');
    expect((first.hook as { _installedBy?: string })._installedBy).toBe('agent-debug-mcp');

    const capabilityEvents: boolean[] = [];
    onReactCapabilityChange((has) => capabilityEvents.push(has));

    // Official DevTools takes over the slot (wholesale assignment goes through our setter).
    const official = makeOfficialHook();
    (target as Record<string, unknown>)[HOOK] = official;

    const s = getReactHookState()!;
    expect(s).not.toBe(first);
    expect(s.hook as unknown).toBe(official);
    expect(s.mode).toBe('official-devtools');

    // A renderer registering with the official hook is tracked by the rebound state.
    const id = official.inject({ version: '19.0.0', bundleType: 1 });
    expect(s.renderers.has(id)).toBe(true);
    expect(capabilityEvents).toContain(true);
  });
});
