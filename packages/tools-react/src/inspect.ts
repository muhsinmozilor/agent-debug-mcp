import { encode, expandPaths, type Enc, type EncodeBudget, type EncodeHooks, type Path } from '@devtools-mcp/protocol';
import { isCompositeFiber, isFiber, type Fiber } from 'bippy';
import { getFiberHooks, getRawSource, type FiberSource, type HooksNode } from 'bippy/source';
import { describeElement, hostElementsOf, type DomNodeInfo } from './dom.js';
import { elementIdOf } from './elements.js';
import { kindOf, keyOf, nameOf, type NodeKind } from './naming.js';

export interface HookInfo {
  index: number;
  id: number | null;
  name: string;
  value: Enc;
  isStateEditable: boolean;
  subHooks?: HookInfo[];
  source?: { fileName: string | null; lineNumber: number | null; columnNumber: number | null; functionName: string | null };
}

export interface ContextInfo {
  name: string;
  value: Enc;
}

export interface OwnerInfo {
  id: number | null;
  name: string;
}

export interface InspectedElement {
  id: number;
  name: string;
  kind: NodeKind;
  key: string | null;
  props: Enc;
  state: Enc | null;
  hooks: HookInfo[] | null;
  hooksError?: string;
  context: ContextInfo[];
  owners: OwnerInfo[];
  source: FiberSource | null;
  hostNodes: DomNodeInfo[];
  rendersCount?: number;
  expanded?: { path: Path; value: Enc }[];
  missing?: Path[];
  truncated: boolean;
}

/** Encoder hook: fibers and React component types show as compact stubs instead of huge graphs. */
export const fiberEncodeHooks: EncodeHooks = {
  special(value) {
    if (isFiber(value)) {
      const f = value as Fiber;
      return { $: 'fiber', elementId: elementIdOf(f), name: nameOf(f) };
    }
    return undefined;
  },
};

function contextName(ctx: unknown): string {
  if (typeof ctx !== 'object' || ctx === null) return 'Context';
  const c = ctx as { displayName?: string; _context?: { displayName?: string } };
  return c.displayName ?? c._context?.displayName ?? 'Context';
}

function contextsOf(fiber: Fiber, budget: Partial<EncodeBudget>): ContextInfo[] {
  const out: ContextInfo[] = [];
  let dep = (fiber.dependencies as { firstContext?: unknown } | null | undefined)?.firstContext as
    | { context: unknown; memoizedValue: unknown; next: unknown }
    | null
    | undefined;
  let guard = 0;
  while (dep && guard++ < 50) {
    out.push({ name: contextName(dep.context), value: encode(dep.memoizedValue, { ...budget, depth: VALUE_DEPTH }, fiberEncodeHooks).value });
    dep = dep.next as typeof dep;
  }
  return out;
}

function ownersOf(fiber: Fiber, max = 20): OwnerInfo[] {
  const out: OwnerInfo[] = [];
  let owner = fiber._debugOwner as unknown;
  let guard = 0;
  while (owner && guard++ < max) {
    if (isFiber(owner)) {
      out.push({ id: elementIdOf(owner as Fiber), name: nameOf(owner as Fiber) });
      owner = (owner as Fiber)._debugOwner;
    } else {
      const info = owner as { name?: string; owner?: unknown };
      out.push({ id: null, name: info.name ?? 'ServerComponent' });
      owner = info.owner;
    }
  }
  return out;
}

function mapHooks(tree: HooksNode[], budget: Partial<EncodeBudget>, counter: { i: number }): HookInfo[] {
  return tree.map((h) => {
    const info: HookInfo = {
      index: counter.i++,
      id: h.id,
      name: h.name,
      value: encode(h.value, { ...budget, depth: VALUE_DEPTH }, fiberEncodeHooks).value,
      isStateEditable: h.isStateEditable,
    };
    if (h.subHooks.length) info.subHooks = mapHooks(h.subHooks, budget, counter);
    if (h.hookSource) info.source = h.hookSource;
    return info;
  });
}

function flattenHookValues(tree: HooksNode[], out: unknown[] = []): unknown[] {
  for (const h of tree) {
    out.push(h.value);
    if (h.subHooks.length) flattenHookValues(h.subHooks, out);
  }
  return out;
}

export function hooksOf(fiber: Fiber): { tree: HooksNode[] | null; error?: string } {
  if (!isCompositeFiber(fiber) || kindOf(fiber) === 'class') return { tree: null };
  try {
    return { tree: getFiberHooks(fiber) };
  } catch (e) {
    return { tree: null, error: (e as Error).message };
  }
}

/** Props get one extra level by default (`items: [{ id }]` stays readable); hooks/context values one less. */
const INSPECT_DEPTH = 3;
const VALUE_DEPTH = 2;

export function inspectFiber(
  fiber: Fiber,
  opts: { expand?: Path[]; budget?: Partial<EncodeBudget> } = {},
): InspectedElement {
  const budget: Partial<EncodeBudget> = { depth: INSPECT_DEPTH, ...(opts.budget ?? {}) };
  const kind = kindOf(fiber);
  const props = fiber.memoizedProps as unknown;
  const classState = kind === 'class' ? (fiber.memoizedState as unknown) : null;
  const hooks = hooksOf(fiber);
  const context = contextsOf(fiber, budget);

  const propsEnc = encode(props, budget, fiberEncodeHooks);
  const stateEnc = classState === null ? null : encode(classState, budget, fiberEncodeHooks);
  let truncated = propsEnc.truncated || (stateEnc?.truncated ?? false);

  const result: InspectedElement = {
    id: elementIdOf(fiber),
    name: nameOf(fiber),
    kind,
    key: keyOf(fiber),
    props: propsEnc.value,
    state: stateEnc ? stateEnc.value : null,
    hooks: hooks.tree ? mapHooks(hooks.tree, budget, { i: 0 }) : null,
    context,
    owners: ownersOf(fiber),
    source: safeRawSource(fiber),
    hostNodes: hostElementsOf(fiber, 10).map(describeElement),
    truncated,
  };
  if (hooks.error) result.hooksError = hooks.error;

  if (opts.expand && opts.expand.length) {
    const root = {
      props,
      state: classState,
      hooks: hooks.tree ? flattenHookValues(hooks.tree) : null,
      context: context.map((c, i) => contextValueAt(fiber, i)),
    };
    const ex = expandPaths(root, opts.expand, budget, fiberEncodeHooks);
    result.expanded = ex.expanded;
    result.missing = ex.missing;
    truncated ||= ex.truncated;
    result.truncated = truncated;
  }
  return result;
}

function contextValueAt(fiber: Fiber, index: number): unknown {
  let dep = (fiber.dependencies as { firstContext?: unknown } | null | undefined)?.firstContext as
    | { memoizedValue: unknown; next: unknown }
    | null
    | undefined;
  for (let i = 0; dep && i < index; i++) dep = dep.next as typeof dep;
  return dep?.memoizedValue;
}

function safeRawSource(fiber: Fiber): FiberSource | null {
  try {
    return getRawSource(fiber);
  } catch {
    return null;
  }
}

/** Compact one-line preview of props used by react_search_components. */
export function propsPreview(fiber: Fiber): string {
  const enc = encode(fiber.memoizedProps, { depth: 1, maxKeys: 30, maxString: 60, maxBytes: 2048 }, fiberEncodeHooks);
  try {
    return JSON.stringify(enc.value);
  } catch {
    return '';
  }
}
