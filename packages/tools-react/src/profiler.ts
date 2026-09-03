/**
 * Commit-level render profiling built on the DevTools hook's onCommitFiberRoot. For every commit we
 * record which composite components rendered, how long they took (dev/profiling builds expose
 * actualDuration), and *why*: changed props keys, changed hook indices, class state, context, first
 * mount, or "parent" (nothing of its own changed).
 */
import { AgentDebugError } from '@devtools-mcp/protocol';
import { isCompositeFiber, traverseRenderedFibers, type Fiber, type FiberRoot } from 'bippy';
import { elementIdOf } from './elements.js';
import { getAllRoots, onCommit } from './hook.js';
import { kindOf, nameOf } from './naming.js';

export type RenderCause = 'mount' | 'props' | 'hooks' | 'state' | 'context' | 'parent' | 'unmount' | 'unknown';

export interface RenderRecord {
  id: number;
  name: string;
  kind: string;
  phase: 'mount' | 'update' | 'unmount';
  causes: RenderCause[];
  changedProps: string[];
  changedHooks: number[];
  changedContexts: string[];
  /** Self render time in ms when available (dev/profiling builds). */
  selfDurationMs: number | null;
  actualDurationMs: number | null;
}

export interface CommitRecord {
  index: number;
  timestamp: number;
  rendererId: number;
  durationMs: number | null;
  renders: RenderRecord[];
}

export interface ProfileSession {
  startedAt: number;
  stoppedAt: number | null;
  recordChangeDescriptions: boolean;
  commits: CommitRecord[];
  /** Bumped per start; cursors embed it. */
  generation: number;
  truncated: boolean;
}

const MAX_COMMITS = 2000;
const MAX_RENDERS_PER_COMMIT = 2000;

let session: ProfileSession | null = null;
let unsubscribe: (() => void) | null = null;
let generation = 0;
const commitListeners = new Set<(c: CommitRecord) => void>();

function shallowChangedKeys(a: unknown, b: unknown): string[] {
  if (a === b) return [];
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return a === b ? [] : ['*'];
  const out: string[] = [];
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) if (ao[k] !== bo[k]) out.push(k);
  return out;
}

function changedHookIndices(fiber: Fiber, alt: Fiber): number[] {
  const out: number[] = [];
  let a = fiber.memoizedState as { memoizedState: unknown; queue?: unknown; next: unknown } | null;
  let b = alt.memoizedState as { memoizedState: unknown; queue?: unknown; next: unknown } | null;
  let i = 0;
  while (a && b && i < 200) {
    // Only stateful hooks (with a queue) count; effects/memos have their own semantics.
    if (a.queue !== undefined && a.queue !== null && a.memoizedState !== b.memoizedState) out.push(i);
    a = a.next as typeof a;
    b = b.next as typeof b;
    i++;
  }
  return out;
}

function changedContexts(fiber: Fiber, alt: Fiber): string[] {
  const out: string[] = [];
  let a = (fiber.dependencies as { firstContext?: unknown } | null)?.firstContext as { context: { displayName?: string }; memoizedValue: unknown; next: unknown } | null | undefined;
  let b = (alt.dependencies as { firstContext?: unknown } | null)?.firstContext as typeof a;
  let guard = 0;
  while (a && b && guard++ < 50) {
    if (a.memoizedValue !== b.memoizedValue) out.push(a.context?.displayName ?? 'Context');
    a = a.next as typeof a;
    b = b.next as typeof b;
  }
  return out;
}

function describe(fiber: Fiber, phase: 'mount' | 'update' | 'unmount', withCauses: boolean): RenderRecord {
  const kind = kindOf(fiber);
  const rec: RenderRecord = {
    id: elementIdOf(fiber),
    name: nameOf(fiber),
    kind,
    phase,
    causes: [],
    changedProps: [],
    changedHooks: [],
    changedContexts: [],
    selfDurationMs: null,
    actualDurationMs: typeof fiber.actualDuration === 'number' ? round(fiber.actualDuration) : null,
  };
  if (typeof fiber.actualDuration === 'number') {
    let children = 0;
    for (let c = fiber.child; c; c = c.sibling) children += typeof c.actualDuration === 'number' ? c.actualDuration : 0;
    rec.selfDurationMs = round(Math.max(0, fiber.actualDuration - children));
  }
  if (phase === 'unmount') {
    rec.causes = ['unmount'];
    return rec;
  }
  const alt = fiber.alternate;
  if (phase === 'mount' || !alt) {
    rec.causes = ['mount'];
    return rec;
  }
  if (!withCauses) {
    rec.causes = ['unknown'];
    return rec;
  }
  rec.changedProps = shallowChangedKeys(fiber.memoizedProps, alt.memoizedProps);
  if (rec.changedProps.length) rec.causes.push('props');
  if (kind === 'class') {
    if (fiber.memoizedState !== alt.memoizedState) rec.causes.push('state');
  } else {
    rec.changedHooks = changedHookIndices(fiber, alt);
    if (rec.changedHooks.length) rec.causes.push('hooks');
  }
  rec.changedContexts = changedContexts(fiber, alt);
  if (rec.changedContexts.length) rec.causes.push('context');
  if (rec.causes.length === 0) rec.causes.push('parent');
  return rec;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function recordCommit(rendererId: number, root: FiberRoot, withCauses: boolean): CommitRecord {
  const renders: RenderRecord[] = [];
  let truncated = false;
  try {
    traverseRenderedFibers(root, (fiber, phase) => {
      if (!isCompositeFiber(fiber)) return;
      if (renders.length >= MAX_RENDERS_PER_COMMIT) {
        truncated = true;
        return;
      }
      // bippy reports "mount" for every fiber the first time it sees a root; trust the fiber instead.
      const normalised: 'mount' | 'update' | 'unmount' = phase === 'unmount' ? 'unmount' : fiber.alternate ? 'update' : 'mount';
      renders.push(describe(fiber, normalised, withCauses));
    });
  } catch {
    /* a fiber shape we do not understand — keep what we have */
  }
  const rootDuration = typeof root.current?.actualDuration === 'number' ? round(root.current.actualDuration) : null;
  const commit: CommitRecord = { index: 0, timestamp: Date.now(), rendererId, durationMs: rootDuration, renders };
  if (truncated) (commit as CommitRecord & { truncated?: boolean }).truncated = true;
  return commit;
}

/** Prime bippy's per-root diff state so the first profiled commit is a proper update diff, not a mount. */
function primeRoots(): void {
  for (const { root } of getAllRoots()) {
    try {
      traverseRenderedFibers(root, () => undefined);
    } catch {
      /* ignore */
    }
  }
}

/** Subscribe to every commit (used by both profiling sessions and react_watch_renders). */
function ensureSubscribed(): void {
  if (unsubscribe) return;
  primeRoots();
  unsubscribe = onCommit((rendererId, root) => {
    const withCauses = session?.recordChangeDescriptions ?? true;
    const commit = recordCommit(rendererId, root, withCauses);
    if (session && session.stoppedAt === null) {
      if (session.commits.length >= MAX_COMMITS) session.truncated = true;
      else {
        commit.index = session.commits.length;
        session.commits.push(commit);
      }
    }
    for (const l of commitListeners) l(commit);
  });
}

export function startProfiling(recordChangeDescriptions = true): ProfileSession {
  if (session && session.stoppedAt === null) {
    throw new AgentDebugError('PROFILE_ALREADY_RUNNING', 'A profiling session is already running', {
      hint: 'Call react_profile_stop first (or pass keepData=false to discard).',
      data: { startedAt: session.startedAt, commits: session.commits.length },
    });
  }
  ensureSubscribed();
  session = { startedAt: Date.now(), stoppedAt: null, recordChangeDescriptions, commits: [], generation: ++generation, truncated: false };
  return session;
}

export function stopProfiling(): ProfileSession {
  if (!session || session.stoppedAt !== null) {
    throw new AgentDebugError('INVALID_INPUT', 'No profiling session is running', { hint: 'Call react_profile_start first.' });
  }
  session.stoppedAt = Date.now();
  return session;
}

export function getSession(): ProfileSession | null {
  return session;
}

export function discardSession(): void {
  session = null;
}

export function isProfiling(): boolean {
  return !!session && session.stoppedAt === null;
}

export function onAnyCommit(listener: (c: CommitRecord) => void): () => void {
  ensureSubscribed();
  commitListeners.add(listener);
  return () => commitListeners.delete(listener);
}

export interface ComponentStats {
  name: string;
  renders: number;
  mounts: number;
  unmounts: number;
  totalSelfMs: number;
  maxSelfMs: number;
  causes: Record<RenderCause, number>;
  changedProps: Record<string, number>;
  ids: number[];
}

export function summarise(commits: CommitRecord[], limit = 15): {
  commits: number;
  totalDurationMs: number | null;
  renders: number;
  causes: Record<RenderCause, number>;
  hottest: ComponentStats[];
  mostRendered: ComponentStats[];
} {
  const byName = new Map<string, ComponentStats>();
  const causes = emptyCauses();
  let renders = 0;
  let total: number | null = null;
  for (const c of commits) {
    if (c.durationMs !== null) total = (total ?? 0) + c.durationMs;
    for (const r of c.renders) {
      renders++;
      let s = byName.get(r.name);
      if (!s) {
        s = { name: r.name, renders: 0, mounts: 0, unmounts: 0, totalSelfMs: 0, maxSelfMs: 0, causes: emptyCauses(), changedProps: {}, ids: [] };
        byName.set(r.name, s);
      }
      if (r.phase === 'mount') s.mounts++;
      else if (r.phase === 'unmount') s.unmounts++;
      else s.renders++;
      if (r.selfDurationMs !== null) {
        s.totalSelfMs = round(s.totalSelfMs + r.selfDurationMs);
        s.maxSelfMs = Math.max(s.maxSelfMs, r.selfDurationMs);
      }
      for (const cause of r.causes) {
        causes[cause]++;
        s.causes[cause]++;
      }
      for (const p of r.changedProps) s.changedProps[p] = (s.changedProps[p] ?? 0) + 1;
      if (s.ids.length < 5 && !s.ids.includes(r.id)) s.ids.push(r.id);
    }
  }
  const all = [...byName.values()];
  return {
    commits: commits.length,
    totalDurationMs: total,
    renders,
    causes,
    hottest: [...all].sort((a, b) => b.totalSelfMs - a.totalSelfMs).slice(0, limit),
    mostRendered: [...all].sort((a, b) => b.renders + b.mounts - (a.renders + a.mounts)).slice(0, limit),
  };
}

function emptyCauses(): Record<RenderCause, number> {
  return { mount: 0, props: 0, hooks: 0, state: 0, context: 0, parent: 0, unmount: 0, unknown: 0 };
}
