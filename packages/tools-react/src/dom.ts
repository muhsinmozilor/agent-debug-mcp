import { defaultDomSelector } from '@devtools-mcp/protocol';
import { getFiber, isCompositeFiber, isHostFiber, type Fiber } from 'bippy';
import { elementIdOf } from './elements.js';
import { kindOf, nameOf } from './naming.js';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DomNodeInfo {
  tag: string;
  selector: string;
  rect: Rect | null;
  text: string | null;
}

export interface Ancestor {
  id: number;
  name: string;
}

export const OVERLAY_ATTR = 'data-dtmcp-overlay';

export function rectOf(el: Element): Rect | null {
  if (typeof (el as HTMLElement).getBoundingClientRect !== 'function') return null;
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
}

export function describeElement(el: Element): DomNodeInfo {
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  return {
    tag: el.tagName.toLowerCase(),
    selector: defaultDomSelector(el as unknown as Parameters<typeof defaultDomSelector>[0]),
    rect: rectOf(el),
    text: text ? (text.length > 80 ? `${text.slice(0, 79)}…` : text) : null,
  };
}

/** Host DOM elements rendered by a fiber (descends until it hits host fibers). */
export function hostElementsOf(fiber: Fiber, max = 20): Element[] {
  const out: Element[] = [];
  const stack: Fiber[] = [fiber];
  while (stack.length && out.length < max) {
    const f = stack.pop() as Fiber;
    if (f !== fiber && isHostFiber(f)) {
      const node = f.stateNode as unknown;
      if (node && typeof node === 'object' && (node as Element).nodeType === 1) out.push(node as Element);
      continue; // do not descend below a host node
    }
    if (f === fiber && isHostFiber(f)) {
      const node = f.stateNode as unknown;
      if (node && (node as Element).nodeType === 1) out.push(node as Element);
      break;
    }
    const children: Fiber[] = [];
    for (let c = f.child; c; c = c.sibling) children.push(c);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] as Fiber);
  }
  return out;
}

/** Nearest composite (user-land) component that owns the given fiber, inclusive. */
export function nearestComposite(fiber: Fiber | null): Fiber | null {
  let f: Fiber | null = fiber;
  while (f && !isCompositeFiber(f)) f = f.return;
  return f;
}

/** Composite ancestors from nearest to root (excluding the fiber itself). */
export function ancestorsOf(fiber: Fiber, max = 30): Ancestor[] {
  const out: Ancestor[] = [];
  let f: Fiber | null = fiber.return;
  while (f && out.length < max) {
    if (isCompositeFiber(f)) out.push({ id: elementIdOf(f), name: nameOf(f) });
    f = f.return;
  }
  return out;
}

export interface ElementComponentInfo {
  element: DomNodeInfo;
  component: { id: number; name: string; kind: string } | null;
  ancestors: Ancestor[];
}

/** Map a DOM element to the React component that rendered it. */
export function componentForElement(el: Element): ElementComponentInfo {
  const fiber = getFiber(el);
  const composite = nearestComposite(fiber);
  return {
    element: describeElement(el),
    component: composite ? { id: elementIdOf(composite), name: nameOf(composite), kind: kindOf(composite) } : null,
    ancestors: composite ? ancestorsOf(composite) : [],
  };
}

export function isOverlayNode(el: Element | null): boolean {
  let n: Element | null = el;
  while (n) {
    if (n.hasAttribute?.(OVERLAY_ATTR)) return true;
    n = n.parentElement ?? ((n.getRootNode() as ShadowRoot).host ?? null);
  }
  return false;
}

export function elementAtPoint(x: number, y: number): Element | null {
  const list = document.elementsFromPoint(x, y);
  for (const el of list) if (!isOverlayNode(el)) return el;
  return null;
}
