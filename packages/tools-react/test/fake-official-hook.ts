// Minimal stand-in for the hook installed by the official React DevTools extension (v6+ shape).
const renderers = new Map<number, unknown>();
const fiberRoots: Record<number, Set<unknown>> = {};
const listeners: Record<string, ((data: unknown) => void)[]> = {};
let uid = 0;
const hook = {
  __fake: true,
  renderers,
  rendererInterfaces: new Map(),
  listeners,
  backends: new Map(),
  supportsFiber: true,
  supportsFlight: true,
  hasUnsupportedRendererAttached: false,
  checkDCE() {},
  inject(renderer: unknown) {
    const id = ++uid;
    renderers.set(id, renderer);
    fiberRoots[id] = new Set();
    hook.emit('renderer', { id, renderer });
    return id;
  },
  getFiberRoots(id: number) {
    return (fiberRoots[id] ??= new Set());
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
  onCommitFiberRoot(id: number, root: { current: { memoizedState: { element: unknown } | null } }) {
    const set = (fiberRoots[id] ??= new Set());
    const st = root.current.memoizedState;
    if (st && st.element != null) set.add(root);
    else set.delete(root);
  },
  onCommitFiberUnmount() {},
  onPostCommitFiberRoot() {},
  setStrictMode() {},
};
Object.defineProperty(globalThis, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { configurable: false, enumerable: false, get: () => hook });
