import {
  getRDTHook,
  instrument,
  isFiberRootUnmounted,
  isReactRefresh,
  isRealReactDevtools,
  onRendererInject,
  type FiberRoot,
  type ReactDevToolsGlobalHook,
  type ReactRenderer,
} from 'bippy';

export type HookMode = 'official-devtools' | 'Agent Debug MCP' | 'react-refresh' | 'other';

export interface RendererRecord {
  id: number;
  renderer: ReactRenderer;
  roots: Set<FiberRoot>;
  commitCount: number;
  lastCommitAt: number | null;
}

export interface ReactHookState {
  hook: ReactDevToolsGlobalHook;
  mode: HookMode;
  renderers: Map<number, RendererRecord>;
  /** Monotonic counter bumped on every commit of any renderer — used for cursor staleness. */
  generation: number;
  installedAt: number;
}

let state: ReactHookState | null = null;
const capabilityListeners = new Set<(hasReact: boolean) => void>();
const commitListeners = new Set<(rendererId: number, root: FiberRoot) => void>();

function detectMode(hook: ReactDevToolsGlobalHook, weInstalled: boolean): HookMode {
  if (isRealReactDevtools(hook)) return 'official-devtools';
  if (isReactRefresh(hook)) return 'react-refresh';
  if (weInstalled || hook._isBippyHook) return 'Agent Debug MCP';
  return 'other';
}

function rendererIdOf(hook: ReactDevToolsGlobalHook, renderer: ReactRenderer): number | null {
  for (const [id, r] of hook.renderers) if (r === renderer) return id;
  return null;
}

function ensureRecord(s: ReactHookState, id: number, renderer: ReactRenderer): RendererRecord {
  let rec = s.renderers.get(id);
  if (!rec) {
    rec = { id, renderer, roots: new Set(), commitCount: 0, lastCommitAt: null };
    s.renderers.set(id, rec);
    // Seed roots if the hook tracks them (official DevTools hook does).
    try {
      const roots = s.hook.getFiberRoots?.(id);
      if (roots) for (const r of roots) rec.roots.add(r);
    } catch {
      /* ignore */
    }
  }
  return rec;
}

/**
 * Obtain (adopt or install) the React DevTools hook and start tracking renderers/roots/commits.
 * Must run before React loads (content script at document_start, MAIN world). Idempotent.
 */
export function initReactHook(target: typeof globalThis = globalThis): ReactHookState {
  if (state) return state;
  const hadHook = Object.prototype.hasOwnProperty.call(target, '__REACT_DEVTOOLS_GLOBAL_HOOK__');
  const hook = getRDTHook(undefined, target);
  const s: ReactHookState = {
    hook,
    mode: detectMode(hook, !hadHook),
    renderers: new Map(),
    generation: 0,
    installedAt: Date.now(),
  };
  state = s;

  for (const [id, renderer] of hook.renderers) ensureRecord(s, id, renderer);

  onRendererInject((renderer) => {
    const id = rendererIdOf(hook, renderer);
    if (id !== null) ensureRecord(s, id, renderer);
    for (const l of capabilityListeners) l(true);
  }, target);

  instrument({
    name: 'Agent Debug MCP',
    target,
    onCommitFiberRoot(rendererId, root) {
      const renderer = hook.renderers.get(rendererId);
      const rec = renderer ? ensureRecord(s, rendererId, renderer) : undefined;
      if (rec) {
        if (isFiberRootUnmounted(root)) rec.roots.delete(root);
        else rec.roots.add(root);
        rec.commitCount++;
        rec.lastCommitAt = Date.now();
      }
      s.generation++;
      for (const l of commitListeners) l(rendererId, root);
    },
  });

  return s;
}

export function getReactHookState(): ReactHookState | null {
  return state;
}

export function hasReact(): boolean {
  return !!state && state.renderers.size > 0;
}

export function onReactCapabilityChange(listener: (hasReact: boolean) => void): () => void {
  capabilityListeners.add(listener);
  return () => capabilityListeners.delete(listener);
}

export function onCommit(listener: (rendererId: number, root: FiberRoot) => void): () => void {
  commitListeners.add(listener);
  return () => commitListeners.delete(listener);
}

/** All live roots across renderers, with their renderer id. */
export function getAllRoots(): { rendererId: number; root: FiberRoot }[] {
  const out: { rendererId: number; root: FiberRoot }[] = [];
  if (!state) return out;
  for (const rec of state.renderers.values()) {
    for (const root of rec.roots) {
      if (isFiberRootUnmounted(root)) {
        rec.roots.delete(root);
        continue;
      }
      out.push({ rendererId: rec.id, root });
    }
  }
  return out;
}
