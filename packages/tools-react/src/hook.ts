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
import { installCooperativeHook } from './cooperative-hook.js';

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
  /** Tears down this state's bippy subscriptions (used when rebinding after a hook takeover). */
  dispose: () => void;
}

let state: ReactHookState | null = null;
const capabilityListeners = new Set<(hasReact: boolean) => void>();
const commitListeners = new Set<(rendererId: number, root: FiberRoot) => void>();

function detectMode(hook: ReactDevToolsGlobalHook, weInstalled: boolean): HookMode {
  // Our cooperative hook is official-shaped, so check our marker before isRealReactDevtools.
  if ((hook as { _installedBy?: string })._installedBy === 'agent-debug-mcp') return 'Agent Debug MCP';
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

/** Bind tracking state to whatever hook currently owns the slot, replacing any previous state. */
function buildState(target: typeof globalThis, weInstalled: boolean): ReactHookState {
  state?.dispose();
  const hook = getRDTHook(undefined, target);
  const disposers: (() => void)[] = [];
  const s: ReactHookState = {
    hook,
    mode: detectMode(hook, weInstalled),
    renderers: new Map(),
    generation: state ? state.generation + 1 : 0,
    installedAt: Date.now(),
    dispose: () => {
      for (const d of disposers) d();
    },
  };
  state = s;

  for (const [id, renderer] of hook.renderers) ensureRecord(s, id, renderer);

  disposers.push(
    onRendererInject((renderer) => {
      if (state !== s) return;
      const id = rendererIdOf(hook, renderer);
      if (id !== null) ensureRecord(s, id, renderer);
      for (const l of capabilityListeners) l(true);
    }, target),
  );

  disposers.push(
    instrument({
      name: 'Agent Debug MCP',
      target,
      onCommitFiberRoot(rendererId, root) {
        if (state !== s) return;
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
    }),
  );

  return s;
}

/**
 * Obtain (adopt or install) the React DevTools hook and start tracking renderers/roots/commits.
 * Must run before React loads (content script at document_start, MAIN world). Idempotent.
 *
 * When no hook exists yet we install a cooperative official-shaped hook (see cooperative-hook.ts):
 * if the official React DevTools installer runs after us in the same document_start batch, it gets
 * the slot and we rebind to its hook, so both the DevTools panel and our tools work.
 */
export function initReactHook(target: typeof globalThis = globalThis): ReactHookState {
  if (state) return state;
  // bippy's main entry auto-installs its minimal hook on globalThis as an import side effect — it
  // runs before this function ever can, so "a hook exists" does not mean someone else owns the
  // slot. An untouched bippy auto-hook (bippy's marker, zero renderers, still configurable) is our
  // own artifact: evict it — and the one-shot hasOwnProperty trap bippy arms alongside it, which
  // would otherwise shadow our diplomacy — so the cooperative official-shaped hook takes the slot.
  const desc = Object.getOwnPropertyDescriptor(target, '__REACT_DEVTOOLS_GLOBAL_HOOK__');
  const existing = desc ? (target as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: ReactDevToolsGlobalHook }).__REACT_DEVTOOLS_GLOBAL_HOOK__ : undefined;
  let hadHook = !!desc;
  if (hadHook && desc?.configurable && existing?._isBippyHook === true && existing.renderers.size === 0) {
    Reflect.deleteProperty(target, '__REACT_DEVTOOLS_GLOBAL_HOOK__');
    const trap = Object.getOwnPropertyDescriptor(target, 'hasOwnProperty');
    if (trap?.configurable) Reflect.deleteProperty(target, 'hasOwnProperty');
    hadHook = false;
  }
  if (!hadHook) {
    installCooperativeHook(target, {
      onTakeover: () => {
        buildState(target, false);
        for (const l of capabilityListeners) l(hasReact());
      },
    });
  }
  return buildState(target, !hadHook);
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
