/**
 * Cooperative React DevTools hook installation.
 *
 * When no hook exists at document_start we must install one before React loads — but the official
 * React DevTools extension may be about to run its own installer in the same document_start batch,
 * and its panel only works with the hook its installer creates (in DevTools 7 the renderer attach
 * happens inside its own inject()). Its installer probes `window.hasOwnProperty('__REACT_DEVTOOLS_
 * GLOBAL_HOOK__')` twice (an outer and an inner guard) and silently aborts when a hook exists —
 * which is how a first-run bippy hook used to blank the official panel ("This page doesn't appear
 * to be using React") and crash backendManager on `hook.backends.has`.
 *
 * Two measures fix both failure modes:
 *
 *  1. The hook we install has the full official v5–v7 shape (`backends`, `rendererInterfaces`,
 *     `sub`/`on`/`off`/`emit`, commit dispatch), so any DevTools backend that finds it attaches
 *     without crashing.
 *  2. hasOwnProperty diplomacy: the first probe for the hook key removes our hook, restores
 *     `hasOwnProperty`, and answers "no hook here", letting the official installer claim the slot
 *     (both of its guards pass — the property really is gone). A microtask, which runs after the
 *     prober's synchronous install but before any page script, then either adopts the hook that
 *     was installed (`onTakeover`) or, on a false alarm, puts ours back.
 *
 * The diplomacy disarms itself on the first renderer inject (React has loaded, so the
 * document_start race is over and stepping aside would orphan the registered renderer) and at
 * DOMContentLoaded.
 */

const HOOK_KEY = '__REACT_DEVTOOLS_GLOBAL_HOOK__';

interface RendererInterfaceLike {
  handleCommitFiberRoot(root: unknown, priorityLevel?: unknown): void;
  handleCommitFiberUnmount(fiber: unknown): void;
  handlePostCommitFiberRoot(root: unknown): void;
}

interface FiberRootLike {
  current: { memoizedState: { element: unknown } | null | undefined };
}

export interface OfficialShapedHook {
  _installedBy: 'agent-debug-mcp';
  renderers: Map<number, unknown>;
  rendererInterfaces: Map<number, RendererInterfaceLike>;
  backends: Map<string, unknown>;
  listeners: Record<string, ((data: unknown) => void)[]>;
  settings: Record<string, boolean>;
  hasUnsupportedRendererAttached: boolean;
  supportsFiber: boolean;
  supportsFlight: boolean;
  checkDCE(fn: unknown): void;
  on(event: string, fn: (data: unknown) => void): void;
  off(event: string, fn: (data: unknown) => void): void;
  sub(event: string, fn: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
  inject(renderer: unknown): number;
  getFiberRoots(rendererId: number): Set<unknown>;
  onCommitFiberRoot(rendererId: number, root: FiberRootLike, priorityLevel?: unknown): void;
  onCommitFiberUnmount(rendererId: number, fiber: unknown): void;
  onPostCommitFiberRoot(rendererId: number, root: unknown): void;
  setStrictMode(rendererId: number, isStrict: boolean): void;
  getInternalModuleRanges(): unknown[];
  registerInternalModuleStart(error: unknown): void;
  registerInternalModuleStop(error: unknown): void;
}

export interface CooperativeHookOptions {
  /** Called when another installer (the official DevTools extension) claimed the hook slot. */
  onTakeover?: (hook: unknown) => void;
  /** Force-arm the hasOwnProperty diplomacy even outside document_start (tests). */
  armDiplomacy?: boolean;
}

const detectBuildType = (renderer: unknown): string => {
  try {
    const r = renderer as { version?: unknown; bundleType?: number };
    if (typeof r.version === 'string') return (r.bundleType ?? 0) > 0 ? 'development' : 'production';
  } catch {
    /* ignore */
  }
  return 'production';
};

export function createOfficialShapedHook(): OfficialShapedHook {
  const fiberRoots = new Map<number, Set<unknown>>();
  const listeners: Record<string, ((data: unknown) => void)[]> = {};
  let uid = 0;
  const hook: OfficialShapedHook = {
    _installedBy: 'agent-debug-mcp',
    renderers: new Map(),
    rendererInterfaces: new Map(),
    backends: new Map(),
    listeners,
    // Read by the DevTools agent via getHookSettings; we never patch the console ourselves.
    settings: { appendComponentStack: true, breakOnConsoleErrors: false, showInlineWarningsAndErrors: true, hideConsoleLogsInStrictMode: false },
    hasUnsupportedRendererAttached: false,
    supportsFiber: true,
    supportsFlight: true,
    checkDCE() {},
    on(event, fn) {
      (listeners[event] ??= []).push(fn);
    },
    off(event, fn) {
      const list = listeners[event];
      if (!list) return;
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
      if (list.length === 0) delete listeners[event];
    },
    sub(event, fn) {
      hook.on(event, fn);
      return () => hook.off(event, fn);
    },
    emit(event, data) {
      for (const fn of [...(listeners[event] ?? [])]) fn(data);
    },
    inject(renderer) {
      const id = ++uid;
      hook.renderers.set(id, renderer);
      hook.emit('renderer', { id, renderer, reactBuildType: detectBuildType(renderer) });
      return id;
    },
    getFiberRoots(rendererId) {
      let roots = fiberRoots.get(rendererId);
      if (!roots) fiberRoots.set(rendererId, (roots = new Set()));
      return roots;
    },
    onCommitFiberRoot(rendererId, root, priorityLevel) {
      // Mounted-root bookkeeping with the official hook's semantics.
      const roots = hook.getFiberRoots(rendererId);
      const current = root.current;
      const known = roots.has(root);
      const unmounted = current.memoizedState == null || current.memoizedState.element == null;
      if (!known && !unmounted) roots.add(root);
      else if (known && unmounted) roots.delete(root);
      hook.rendererInterfaces.get(rendererId)?.handleCommitFiberRoot(root, priorityLevel);
    },
    onCommitFiberUnmount(rendererId, fiber) {
      hook.rendererInterfaces.get(rendererId)?.handleCommitFiberUnmount(fiber);
    },
    onPostCommitFiberRoot(rendererId, root) {
      hook.rendererInterfaces.get(rendererId)?.handlePostCommitFiberRoot(root);
    },
    setStrictMode() {},
    getInternalModuleRanges() {
      return [];
    },
    registerInternalModuleStart() {},
    registerInternalModuleStop() {},
  };
  return hook;
}

/**
 * Install an official-shaped hook on `target` with hasOwnProperty diplomacy (see module docblock).
 * The caller must have checked that no hook own-property exists yet.
 */
export function installCooperativeHook(target: typeof globalThis, opts: CooperativeHookOptions = {}): OfficialShapedHook {
  const win = target as typeof globalThis & Record<string, unknown>;
  const hook = createOfficialShapedHook();
  let boxed: unknown = hook;
  let takenOver = false;

  const takeover = (next: unknown): void => {
    if (takenOver) return;
    takenOver = true;
    disarm();
    opts.onTakeover?.(next);
  };

  const define = (): boolean => {
    try {
      Object.defineProperty(win, HOOK_KEY, {
        configurable: true,
        enumerable: false,
        get: () => boxed,
        set: (next) => {
          // Something assigned a whole hook over ours (bippy-style wholesale takeover): honour it.
          if (next && typeof next === 'object' && typeof (next as { inject?: unknown }).inject === 'function' && next !== boxed) {
            boxed = next;
            takeover(next);
          }
        },
      });
      return true;
    } catch {
      return false;
    }
  };

  // ---- hasOwnProperty diplomacy ----
  const priorDesc = Object.getOwnPropertyDescriptor(win, 'hasOwnProperty');
  let armed = false;
  const disarm = (): void => {
    if (!armed) return;
    armed = false;
    if (priorDesc) Object.defineProperty(win, 'hasOwnProperty', priorDesc);
    else Reflect.deleteProperty(win, 'hasOwnProperty');
  };
  const arm = (): void => {
    try {
      Object.defineProperty(win, 'hasOwnProperty', {
        configurable: true,
        writable: true,
        value: function hasOwnProperty(key: PropertyKey): boolean {
          if (!armed || key !== HOOK_KEY) return Object.prototype.hasOwnProperty.call(win, key);
          // An installer is probing for an existing hook. Step aside: both its outer and inner
          // guard must see a clean slot, and its install runs synchronously right after.
          disarm();
          Reflect.deleteProperty(win, HOOK_KEY);
          queueMicrotask(() => {
            if (Object.getOwnPropertyDescriptor(win, HOOK_KEY)) takeover(win[HOOK_KEY]);
            else define(); // false alarm — restore ours before any page script runs
          });
          return false;
        },
      });
      armed = true;
    } catch {
      /* hasOwnProperty not patchable — keep our hook unconditionally */
    }
  };

  // Disarm once React arrives (stepping aside now would orphan the renderer) or the DOM is ready.
  const originalInject = hook.inject.bind(hook);
  hook.inject = (renderer) => {
    disarm();
    return originalInject(renderer);
  };
  const doc = (win as { document?: Document }).document;
  doc?.addEventListener?.('DOMContentLoaded', disarm, { once: true });

  if (define() && (opts.armDiplomacy || doc?.readyState === 'loading')) arm();
  return hook;
}
