import { getDisplayName, getReactWorkTagsForFiber, type Fiber } from 'bippy';

export type NodeKind =
  | 'function'
  | 'class'
  | 'memo'
  | 'forwardRef'
  | 'host'
  | 'text'
  | 'root'
  | 'fragment'
  | 'mode'
  | 'profiler'
  | 'suspense'
  | 'suspenseList'
  | 'context.provider'
  | 'context.consumer'
  | 'lazy'
  | 'portal'
  | 'offscreen'
  | 'activity'
  | 'other';

export function kindOf(fiber: Fiber): NodeKind {
  const t = getReactWorkTagsForFiber(fiber);
  switch (fiber.tag) {
    case t.FunctionComponent:
    case t.IndeterminateComponent:
    case t.IncompleteFunctionComponent:
      return 'function';
    case t.ClassComponent:
    case t.IncompleteClassComponent:
      return 'class';
    case t.MemoComponent:
    case t.SimpleMemoComponent:
      return 'memo';
    case t.ForwardRef:
      return 'forwardRef';
    case t.HostComponent:
    case t.HostHoistable:
    case t.HostSingleton:
      return 'host';
    case t.HostText:
      return 'text';
    case t.HostRoot:
      return 'root';
    case t.Fragment:
      return 'fragment';
    case t.Mode:
      return 'mode';
    case t.Profiler:
      return 'profiler';
    case t.SuspenseComponent:
    case t.DehydratedSuspenseComponent:
      return 'suspense';
    case t.SuspenseListComponent:
      return 'suspenseList';
    case t.ContextProvider:
      return 'context.provider';
    case t.ContextConsumer:
      return 'context.consumer';
    case t.LazyComponent:
      return 'lazy';
    case t.HostPortal:
      return 'portal';
    case t.OffscreenComponent:
    case t.LegacyHiddenComponent:
      return 'offscreen';
    case t.ActivityComponent:
      return 'activity';
    default:
      return 'other';
  }
}

export const WRAPPER_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'fragment',
  'mode',
  'profiler',
  'offscreen',
  'activity',
  'suspenseList',
  'other',
]);

function contextName(ctx: unknown): string {
  if (typeof ctx !== 'object' || ctx === null) return 'Context';
  const c = ctx as { displayName?: string; _context?: { displayName?: string } };
  return c.displayName ?? c._context?.displayName ?? 'Context';
}

/** Human-readable display name for any fiber. */
export function nameOf(fiber: Fiber): string {
  const kind = kindOf(fiber);
  switch (kind) {
    case 'host':
      return typeof fiber.type === 'string' ? fiber.type : 'host';
    case 'text':
      return '#text';
    case 'root':
      return 'Root';
    case 'fragment':
      return 'Fragment';
    case 'mode':
      return 'StrictMode';
    case 'profiler':
      return 'Profiler';
    case 'suspense':
      return 'Suspense';
    case 'suspenseList':
      return 'SuspenseList';
    case 'offscreen':
      return 'Offscreen';
    case 'activity':
      return 'Activity';
    case 'portal':
      return 'Portal';
    case 'context.provider':
      return `${contextName(fiber.type)}.Provider`;
    case 'context.consumer':
      return `${contextName(fiber.type)}.Consumer`;
    case 'lazy':
      return 'Lazy';
    default: {
      const name = getDisplayName(fiber.type) ?? getDisplayName(fiber.elementType);
      if (name) return kind === 'memo' && !name.startsWith('Memo(') ? name : name;
      return 'Anonymous';
    }
  }
}

export function keyOf(fiber: Fiber): string | null {
  return fiber.key == null ? null : String(fiber.key);
}
