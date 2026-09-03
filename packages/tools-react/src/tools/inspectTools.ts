import { AgentDebugError, defineTool, type Path } from '@devtools-mcp/protocol';
import { isCompositeFiber, type Fiber } from 'bippy';
import { getOwnerStack, getSource } from 'bippy/source';
import {
  pageElementAtPointMeta,
  pageHighlightMeta,
  pagePickElementMeta,
  reactFindByDomMeta,
  reactGetDomNodesMeta,
  reactGetSourceMeta,
  reactInspectElementMeta,
  reactSearchComponentsMeta,
} from '../descriptors.js';
import { ancestorsOf, componentForElement, describeElement, elementAtPoint, hostElementsOf, nearestComposite } from '../dom.js';
import { elementIdOf, resolveElement } from '../elements.js';
import { getAllRoots } from '../hook.js';
import { inspectFiber, propsPreview } from '../inspect.js';
import { kindOf, nameOf } from '../naming.js';
import { highlightElements } from '../overlay.js';
import { pickElement } from '../pick.js';

export const reactInspectElement = defineTool<{ elementId: number; expand?: Path[]; budget?: Record<string, number> }, unknown>({
  ...reactInspectElementMeta,
  execute: ({ elementId, expand, budget }) => inspectFiber(resolveElement(elementId), { expand, budget }),
});

export const reactSearchComponents = defineTool<{ nameRegex?: string; propsContains?: string; limit?: number }, unknown>({
  ...reactSearchComponentsMeta,
  execute: ({ nameRegex, propsContains, limit }) => {
    if (!nameRegex && !propsContains) throw new AgentDebugError('INVALID_INPUT', 'Provide nameRegex and/or propsContains');
    let re: RegExp | null = null;
    if (nameRegex) {
      try {
        re = new RegExp(nameRegex, 'i');
      } catch (e) {
        throw new AgentDebugError('INVALID_INPUT', `Invalid nameRegex: ${(e as Error).message}`);
      }
    }
    const needle = propsContains?.toLowerCase();
    const max = Math.min(Math.max(limit ?? 25, 1), 200);
    const matches: { id: number; name: string; kind: string; depth: number; ancestors: { id: number; name: string }[]; propsPreview: string }[] = [];
    let scanned = 0;
    outer: for (const { root } of getAllRoots()) {
      const stack: { fiber: Fiber; depth: number }[] = [{ fiber: root.current, depth: 0 }];
      while (stack.length) {
        const { fiber, depth } = stack.pop() as { fiber: Fiber; depth: number };
        scanned++;
        if (scanned > 200_000) break outer;
        if (isCompositeFiber(fiber)) {
          const name = nameOf(fiber);
          const nameOk = !re || re.test(name);
          let preview = '';
          const propsOk = !needle || (preview = propsPreview(fiber)).toLowerCase().includes(needle);
          if (nameOk && propsOk) {
            matches.push({ id: elementIdOf(fiber), name, kind: kindOf(fiber), depth, ancestors: ancestorsOf(fiber, 8), propsPreview: preview || propsPreview(fiber) });
            if (matches.length >= max) break outer;
          }
        }
        const children: Fiber[] = [];
        for (let c = fiber.child; c; c = c.sibling) children.push(c);
        for (let i = children.length - 1; i >= 0; i--) stack.push({ fiber: children[i] as Fiber, depth: depth + (isCompositeFiber(fiber) ? 1 : 0) });
      }
    }
    return { matches, truncated: matches.length >= max, scanned };
  },
});

export const reactFindByDom = defineTool<{ selector: string; nth?: number }, unknown>({
  ...reactFindByDomMeta,
  execute: ({ selector, nth }) => {
    let nodes: Element[];
    try {
      nodes = Array.from(document.querySelectorAll(selector));
    } catch (e) {
      throw new AgentDebugError('INVALID_INPUT', `Invalid selector: ${(e as Error).message}`);
    }
    if (nodes.length === 0) return { total: 0, matches: [] };
    const picked = nth === undefined ? nodes.slice(0, 10) : nodes[nth] ? [nodes[nth] as Element] : [];
    if (nth !== undefined && picked.length === 0) throw new AgentDebugError('INVALID_INPUT', `nth=${nth} out of range (matches: ${nodes.length})`);
    return { total: nodes.length, matches: picked.map(componentForElement) };
  },
});

export const reactGetDomNodes = defineTool<{ elementId: number }, unknown>({
  ...reactGetDomNodesMeta,
  execute: ({ elementId }) => {
    const fiber = resolveElement(elementId);
    return { id: elementId, name: nameOf(fiber), nodes: hostElementsOf(fiber, 50).map(describeElement) };
  },
});

export const reactGetSource = defineTool<{ elementId: number }, unknown>({
  ...reactGetSourceMeta,
  execute: async ({ elementId }, { signal }) => {
    const fiber = resolveElement(elementId);
    const fetchFn: typeof fetch = (url, init) => fetch(url, { ...init, signal });
    const [source, ownerStack] = await Promise.all([
      getSource(fiber, true, fetchFn as never).catch((e: Error) => ({ error: e.message })),
      getOwnerStack(fiber, true, fetchFn as never).catch(() => []),
    ]);
    const isErr = source && 'error' in (source as object);
    return {
      id: elementId,
      name: nameOf(fiber),
      source: isErr ? null : source,
      sourceError: isErr ? (source as { error: string }).error : undefined,
      ownerStack: (ownerStack as { fileName?: string; lineNumber?: number; columnNumber?: number; functionName?: string }[])
        .slice(0, 15)
        .map((f) => ({ file: f.fileName ?? null, line: f.lineNumber ?? null, column: f.columnNumber ?? null, fn: f.functionName ?? null })),
    };
  },
});

export const pageHighlight = defineTool<{ elementId?: number; selector?: string; durationMs?: number; label?: string }, unknown>({
  ...pageHighlightMeta,
  execute: ({ elementId, selector, durationMs, label }) => {
    let els: Element[] = [];
    let caption = label;
    if (elementId !== undefined) {
      const fiber = resolveElement(elementId);
      els = hostElementsOf(fiber, 50);
      caption ??= nameOf(fiber);
    } else if (selector) {
      try {
        els = Array.from(document.querySelectorAll(selector)).slice(0, 50);
      } catch (e) {
        throw new AgentDebugError('INVALID_INPUT', `Invalid selector: ${(e as Error).message}`);
      }
      caption ??= selector;
    } else {
      throw new AgentDebugError('INVALID_INPUT', 'Provide elementId or selector');
    }
    const shown = highlightElements(els, caption, durationMs ?? 3000);
    return { highlighted: shown, durationMs: durationMs ?? 3000 };
  },
});

export const pageElementAtPoint = defineTool<{ x: number; y: number }, unknown>({
  ...pageElementAtPointMeta,
  execute: ({ x, y }) => {
    const el = elementAtPoint(x, y);
    if (!el) return { element: null, component: null, ancestors: [] };
    const info = componentForElement(el);
    void nearestComposite;
    return info;
  },
});

export const pagePickElement = defineTool<{ timeoutMs?: number }, unknown>({
  ...pagePickElementMeta,
  execute: ({ timeoutMs }, { signal }) => pickElement({ timeoutMs: timeoutMs ?? 60_000, signal }),
});
