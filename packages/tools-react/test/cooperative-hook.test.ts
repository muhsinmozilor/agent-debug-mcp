/**
 * Cooperative hook installation: our first-run hook must have the official shape (so the React
 * DevTools backendManager doesn't crash on it) and must step aside when the official DevTools
 * installer probes for an existing hook after us — DevTools 7 guards with
 * `window.hasOwnProperty('__REACT_DEVTOOLS_GLOBAL_HOOK__')` twice and aborts silently otherwise.
 */
import { describe, expect, it, vi } from 'vitest';
import { createOfficialShapedHook, installCooperativeHook } from '../src/cooperative-hook.js';

const HOOK = '__REACT_DEVTOOLS_GLOBAL_HOOK__';

type Target = typeof globalThis & Record<string, unknown>;
const makeTarget = (): Target => ({}) as Target;

/** Replays the exact guard + install sequence of React DevTools 7's installHook.js. */
function officialDevtools7Installer(target: Target): { installed: boolean; hook: { official: true } | null } {
  const officialHook = { official: true as const, renderers: new Map(), inject: () => 1, getFiberRoots: () => new Set() };
  // Outer guard.
  if (target.hasOwnProperty(HOOK)) return { installed: false, hook: null };
  // Inner guard (inside the installer function).
  if (target.hasOwnProperty(HOOK)) return { installed: false, hook: null };
  Object.defineProperty(target, HOOK, { configurable: false, enumerable: false, get: () => officialHook });
  return { installed: true, hook: officialHook };
}

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
};

describe('createOfficialShapedHook', () => {
  it('survives the DevTools 7 backendManager welcome sequence', () => {
    const hook = createOfficialShapedHook();
    hook.inject({ version: '19.0.0', bundleType: 1, rendererPackageName: 'react-dom' });
    // backendManager: hook.renderers.forEach(r => registerRenderer(r, hook)) — reads hook.backends.has(version).
    const seen: string[] = [];
    hook.renderers.forEach((renderer) => {
      const version = (renderer as { reconcilerVersion?: string; version: string }).reconcilerVersion || (renderer as { version: string }).version;
      expect(hook.backends.has(version)).toBe(false); // used to throw: backends was undefined on the bippy hook
      seen.push(version);
    });
    expect(seen).toEqual(['19.0.0']);
    // backendManager also subscribes to these; sub must return an unsubscribe.
    const rendererEvents: unknown[] = [];
    const unsub = hook.sub('renderer', (d) => rendererEvents.push(d));
    hook.inject({ version: '19.0.0', bundleType: 1 });
    expect(rendererEvents).toEqual([{ id: 2, renderer: { version: '19.0.0', bundleType: 1 }, reactBuildType: 'development' }]);
    unsub();
    hook.inject({ version: '19.0.0', bundleType: 0 });
    expect(rendererEvents).toHaveLength(1);
  });

  it('dispatches commits to attached renderer interfaces and tracks mounted roots', () => {
    const hook = createOfficialShapedHook();
    const id = hook.inject({ version: '19.0.0', bundleType: 1 });
    const iface = { handleCommitFiberRoot: vi.fn(), handleCommitFiberUnmount: vi.fn(), handlePostCommitFiberRoot: vi.fn() };
    hook.rendererInterfaces.set(id, iface);
    const mounted = { current: { memoizedState: { element: {} } } };
    hook.onCommitFiberRoot(id, mounted, 16);
    expect(hook.getFiberRoots(id).has(mounted)).toBe(true);
    expect(iface.handleCommitFiberRoot).toHaveBeenCalledWith(mounted, 16);
    const unmounted = { current: { memoizedState: null } };
    hook.onCommitFiberRoot(id, unmounted);
    expect(hook.getFiberRoots(id).has(unmounted)).toBe(false);
    hook.onCommitFiberUnmount(id, 'fiber');
    hook.onPostCommitFiberRoot(id, mounted);
    expect(iface.handleCommitFiberUnmount).toHaveBeenCalledWith('fiber');
    expect(iface.handlePostCommitFiberRoot).toHaveBeenCalledWith(mounted);
  });
});

describe('installCooperativeHook diplomacy', () => {
  it('yields the slot to the official DevTools 7 installer and reports the takeover', async () => {
    const target = makeTarget();
    const onTakeover = vi.fn();
    installCooperativeHook(target, { armDiplomacy: true, onTakeover });
    const result = officialDevtools7Installer(target);
    expect(result.installed).toBe(true); // both hasOwnProperty guards saw a clean slot
    await flushMicrotasks();
    expect(onTakeover).toHaveBeenCalledWith(result.hook);
    expect(target[HOOK]).toBe(result.hook);
    // hasOwnProperty is restored to the native one and answers honestly again.
    expect(Object.getOwnPropertyDescriptor(target, 'hasOwnProperty')).toBeUndefined();
    expect(target.hasOwnProperty(HOOK)).toBe(true);
  });

  it('restores our hook after a false-alarm probe', async () => {
    const target = makeTarget();
    const onTakeover = vi.fn();
    const hook = installCooperativeHook(target, { armDiplomacy: true, onTakeover });
    expect(target.hasOwnProperty(HOOK)).toBe(false); // the probe consumes the diplomacy
    expect(target[HOOK]).toBeUndefined(); // we stepped aside...
    await flushMicrotasks();
    expect(target[HOOK]).toBe(hook); // ...and reclaimed the slot before any page script
    expect(onTakeover).not.toHaveBeenCalled();
    expect(target.hasOwnProperty(HOOK)).toBe(true);
  });

  it('disarms once React has injected — too late to step aside', () => {
    const target = makeTarget();
    const hook = installCooperativeHook(target, { armDiplomacy: true });
    hook.inject({ version: '19.0.0', bundleType: 1 });
    expect(target.hasOwnProperty(HOOK)).toBe(true); // honest answer: DevTools correctly backs off
    expect(target[HOOK]).toBe(hook);
    expect(Object.getOwnPropertyDescriptor(target, 'hasOwnProperty')).toBeUndefined();
  });

  it('honours a wholesale hook assignment (bippy-style takeover) via the setter', () => {
    const target = makeTarget();
    const onTakeover = vi.fn();
    installCooperativeHook(target, { onTakeover });
    const replacement = { inject: () => 1, renderers: new Map(), getFiberRoots: () => new Set() };
    (target as Record<string, unknown>)[HOOK] = replacement;
    expect(onTakeover).toHaveBeenCalledWith(replacement);
    expect(target[HOOK]).toBe(replacement);
  });
});
