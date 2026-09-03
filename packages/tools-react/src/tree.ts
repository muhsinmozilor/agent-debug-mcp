import { AgentDebugError, decodeCursor, encodeCursor, type Page } from '@devtools-mcp/protocol';
import type { Fiber } from 'bippy';
import { elementIdOf, resolveElement } from './elements.js';
import { getAllRoots, getReactHookState } from './hook.js';
import { kindOf, keyOf, nameOf, WRAPPER_KINDS, type NodeKind } from './naming.js';

export interface TreeNode {
  id: number;
  name: string;
  kind: NodeKind;
  key: string | null;
  depth: number;
  parentId: number | null;
  childCount: number;
  /** Renderer id (only present when more than one renderer is registered). */
  rendererId?: number;
}

export interface TreeFilter {
  nameRegex?: string;
  hideHost?: boolean;
  hideWrappers?: boolean;
}

export interface TreeOptions {
  rootId?: number;
  maxDepth?: number;
  maxNodes?: number;
  cursor?: string;
  filter?: TreeFilter;
  docId: string;
}

interface Visible {
  fiber: Fiber;
  depth: number;
  parentId: number | null;
  rendererId: number;
}

function shouldShow(fiber: Fiber, filter: Required<Pick<TreeFilter, 'hideHost' | 'hideWrappers'>>): boolean {
  const kind = kindOf(fiber);
  if (kind === 'text') return false;
  if (kind === 'root') return false;
  if (filter.hideHost && kind === 'host') return false;
  if (filter.hideWrappers && WRAPPER_KINDS.has(kind)) return false;
  return true;
}

/**
 * Pre-order walk producing the *visible* node sequence (hidden nodes are skipped but their
 * children are still visited, attached to the nearest visible ancestor). Depth counts visible levels.
 */
function* visibleSequence(
  start: Fiber,
  startParentId: number | null,
  rendererId: number,
  maxDepth: number,
  filter: Required<Pick<TreeFilter, 'hideHost' | 'hideWrappers'>>,
  includeStart: boolean,
): Generator<Visible> {
  // iterative DFS to avoid recursion limits on deep trees
  type Frame = { fiber: Fiber; depth: number; parentId: number | null; isStart: boolean };
  const stack: Frame[] = [{ fiber: start, depth: 0, parentId: startParentId, isStart: true }];
  while (stack.length) {
    const { fiber, depth, parentId, isStart } = stack.pop() as Frame;
    const show = isStart ? includeStart : shouldShow(fiber, filter);
    let childDepth = depth;
    let childParent = parentId;
    if (show) {
      if (depth > maxDepth) continue;
      yield { fiber, depth, parentId, rendererId };
      childDepth = depth + 1;
      childParent = elementIdOf(fiber);
    }
    if (childDepth > maxDepth) continue;
    // push children in reverse so they pop in order
    const children: Fiber[] = [];
    for (let c = fiber.child; c; c = c.sibling) children.push(c);
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ fiber: children[i] as Fiber, depth: childDepth, parentId: childParent, isStart: false });
    }
  }
}

function countVisibleChildren(fiber: Fiber, filter: Required<Pick<TreeFilter, 'hideHost' | 'hideWrappers'>>): number {
  let n = 0;
  const stack: Fiber[] = [];
  for (let c = fiber.child; c; c = c.sibling) stack.push(c);
  while (stack.length) {
    const f = stack.pop() as Fiber;
    if (shouldShow(f, filter)) n++;
    else for (let c = f.child; c; c = c.sibling) stack.push(c);
  }
  return n;
}

export function getTree(opts: TreeOptions): Page<TreeNode> & { generation: number; treeChanged: boolean } {
  const state = getReactHookState();
  if (!state) throw new AgentDebugError('CAPABILITY_UNAVAILABLE', 'React hook not initialised');
  const maxDepth = opts.maxDepth ?? 6;
  const maxNodes = Math.max(1, Math.min(opts.maxNodes ?? 200, 2000));
  const filter = { hideHost: opts.filter?.hideHost ?? true, hideWrappers: opts.filter?.hideWrappers ?? true };
  const nameRe = opts.filter?.nameRegex ? safeRegex(opts.filter.nameRegex) : null;
  const multiRenderer = state.renderers.size > 1;

  let startPos = 0;
  let treeChanged = false;
  if (opts.cursor) {
    const c = decodeCursor(opts.cursor);
    if (!c || c.kind !== 'tree') throw new AgentDebugError('STALE_CURSOR', 'Invalid cursor');
    if (c.doc !== opts.docId) throw new AgentDebugError('STALE_CURSOR', 'Cursor belongs to a previous document', { hint: 'Start again without a cursor.' });
    startPos = Number(c.pos);
    treeChanged = c.gen !== state.generation;
  }

  const sources: { fiber: Fiber; parentId: number | null; rendererId: number; includeStart: boolean }[] = [];
  if (opts.rootId !== undefined) {
    const fiber = resolveElement(opts.rootId);
    let rendererId = 0;
    for (const r of getAllRoots()) {
      // find which renderer owns this fiber via its root
      let node: Fiber | null = fiber;
      while (node.return) node = node.return;
      if (node === r.root.current) rendererId = r.rendererId;
    }
    sources.push({ fiber, parentId: null, rendererId, includeStart: true });
  } else {
    for (const { rendererId, root } of getAllRoots()) {
      sources.push({ fiber: root.current, parentId: null, rendererId, includeStart: false });
    }
  }

  const items: TreeNode[] = [];
  let pos = 0;
  let nextCursor: string | undefined;
  let total = 0;
  const matchesName = (fiber: Fiber): boolean => !nameRe || nameRe.test(nameOf(fiber));
  // When filtering by name, keep ancestors of matches for context: two-pass on a bounded sequence.
  const seq: Visible[] = [];
  for (const src of sources) {
    for (const v of visibleSequence(src.fiber, src.parentId, src.rendererId, maxDepth, filter, src.includeStart)) {
      seq.push(v);
      if (seq.length > 50_000) break; // hard safety cap
    }
  }
  let selected: Visible[] = seq;
  if (nameRe) {
    const keep = new Set<number>();
    for (const v of seq) {
      if (matchesName(v.fiber)) {
        let f: Fiber | null = v.fiber;
        while (f) {
          keep.add(elementIdOf(f));
          f = f.return;
        }
      }
    }
    selected = seq.filter((v) => keep.has(elementIdOf(v.fiber)));
  }
  total = selected.length;
  for (const v of selected) {
    if (pos++ < startPos) continue;
    if (items.length >= maxNodes) {
      nextCursor = encodeCursor({ doc: opts.docId, kind: 'tree', gen: state.generation, pos: pos - 1 });
      break;
    }
    const node: TreeNode = {
      id: elementIdOf(v.fiber),
      name: nameOf(v.fiber),
      kind: kindOf(v.fiber),
      key: keyOf(v.fiber),
      depth: v.depth,
      parentId: v.parentId,
      childCount: countVisibleChildren(v.fiber, filter),
    };
    if (multiRenderer) node.rendererId = v.rendererId;
    items.push(node);
  }
  const page: Page<TreeNode> & { generation: number; treeChanged: boolean } = {
    items,
    total,
    truncated: nextCursor !== undefined,
    generation: state.generation,
    treeChanged,
  };
  if (nextCursor) page.nextCursor = nextCursor;
  return page;
}

function safeRegex(src: string): RegExp {
  try {
    return new RegExp(src, 'i');
  } catch (e) {
    throw new AgentDebugError('INVALID_INPUT', `Invalid nameRegex: ${(e as Error).message}`);
  }
}
