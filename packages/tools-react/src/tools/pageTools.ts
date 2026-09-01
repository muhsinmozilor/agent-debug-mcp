import { DevtoolsError, defineTool, type ErrorLog, type PageErrorKind, type Path } from '@devtools-mcp/protocol';
import { getOwnerStack, getSource } from 'bippy/source';
import { pageGetErrorsMeta, pageSnapshotMeta, reactExplainMeta } from '../descriptors.js';
import { ancestorsOf, componentForElement, describeElement, hostElementsOf, nearestComposite } from '../dom.js';
import { getFiber } from 'bippy';
import { resolveElement } from '../elements.js';
import { inspectFiber } from '../inspect.js';
import { renderSnapshot, snapshot } from '../snapshot.js';

export interface PageToolContext {
  docId: string;
  errors?: ErrorLog;
}

const KINDS: PageErrorKind[] = ['exception', 'unhandledrejection', 'console.error', 'console.warn', 'react', 'query', 'mutation', 'router'];

export function createPageTools(ctx: PageToolContext) {
  const pageGetErrors = defineTool<{ since?: number; kinds?: PageErrorKind[]; limit?: number; includeWarnings?: boolean }, unknown>({
    ...pageGetErrorsMeta,
    execute: ({ since, kinds, limit, includeWarnings }) => {
      const log = ctx.errors;
      if (!log) throw new DevtoolsError('CAPABILITY_UNAVAILABLE', 'Error capture is not installed on this page', { hint: 'The extension installs it at document_start; reload the tab.' });
      const wanted = new Set<PageErrorKind>(kinds && kinds.length ? kinds : KINDS.filter((k) => includeWarnings || k !== 'console.warn'));
      const all = log.since(since ?? 0).filter((e) => wanted.has(e.kind));
      const max = Math.min(Math.max(limit ?? 50, 1), 500);
      const errors = all.slice(-max);
      return {
        doc: ctx.docId,
        errors,
        total: all.length,
        truncated: all.length > errors.length,
        latestSeq: log.latestSeq,
        evicted: log.evictedCount,
        hint: errors.length === 0 ? `No ${since ? 'new ' : ''}errors recorded${since ? ` since seq ${since}` : ''}. Pass since=${log.latestSeq} next time to get only newer entries.` : `Pass since=${log.latestSeq} on the next call to see only what happens after this point.`,
      };
    },
  });

  const pageSnapshot = defineTool<{ selector?: string; maxNodes?: number; interactiveOnly?: boolean; format?: 'text' | 'json' }, unknown>({
    ...pageSnapshotMeta,
    execute: ({ selector, maxNodes, interactiveOnly, format }) => {
      let root: Element = document.body;
      if (selector) {
        let found: Element | null;
        try {
          found = document.querySelector(selector);
        } catch (e) {
          throw new DevtoolsError('INVALID_INPUT', `Invalid selector: ${(e as Error).message}`);
        }
        if (!found) throw new DevtoolsError('INVALID_INPUT', `No element matches ${selector}`);
        root = found;
      }
      const res = snapshot({ root, maxNodes, interactiveOnly });
      const base = { doc: ctx.docId, url: location.href, title: document.title, root: selector ?? 'body', nodeCount: res.nodes.length, truncated: res.truncated };
      if (format === 'json') return { ...base, nodes: res.nodes };
      return { ...base, tree: renderSnapshot(res.nodes), legend: '- role "name" [attrs] {css selector} → OwningComponent#elementId (printed where it changes)' };
    },
  });

  const reactExplain = defineTool<{ selector?: string; elementId?: number; nth?: number; expand?: Path[] }, unknown>({
    ...reactExplainMeta,
    execute: async ({ selector, elementId, nth, expand }, { signal }) => {
      let fiber;
      let matched: ReturnType<typeof describeElement> | null = null;
      let matches = 0;
      if (elementId !== undefined) {
        fiber = resolveElement(elementId);
      } else if (selector) {
        let nodes: Element[];
        try {
          nodes = Array.from(document.querySelectorAll(selector));
        } catch (e) {
          throw new DevtoolsError('INVALID_INPUT', `Invalid selector: ${(e as Error).message}`);
        }
        matches = nodes.length;
        const el = nodes[nth ?? 0];
        if (!el) throw new DevtoolsError('INVALID_INPUT', matches === 0 ? `No element matches ${selector}` : `nth=${nth} out of range (matches: ${matches})`);
        const composite = nearestComposite(getFiber(el));
        if (!composite) {
          throw new DevtoolsError('INVALID_INPUT', `${selector} is not rendered by React`, { hint: 'The element has no fiber; it may be static HTML or belong to another renderer.', data: componentForElement(el) });
        }
        fiber = composite;
        matched = describeElement(el);
      } else {
        throw new DevtoolsError('INVALID_INPUT', 'Provide selector or elementId');
      }
      const inspected = inspectFiber(fiber, { expand, budget: { depth: 2, maxKeys: 30, maxString: 120 } });
      const fetchFn: typeof fetch = (url, init) => fetch(url, { ...init, signal });
      const [source, ownerStack] = await Promise.all([
        getSource(fiber, true, fetchFn as never).catch((e: Error) => ({ error: e.message })),
        getOwnerStack(fiber, true, fetchFn as never).catch(() => []),
      ]);
      const isErr = source && 'error' in (source as object);
      return {
        component: { id: inspected.id, name: inspected.name, kind: inspected.kind, key: inspected.key },
        matchedElement: matched,
        matches: selector ? matches : undefined,
        props: inspected.props,
        state: inspected.state,
        hooks: inspected.hooks,
        hooksError: inspected.hooksError,
        context: inspected.context,
        owners: inspected.owners,
        ancestors: ancestorsOf(fiber, 12),
        domNodes: hostElementsOf(fiber, 10).map(describeElement),
        source: isErr ? null : source,
        sourceError: isErr ? (source as { error: string }).error : undefined,
        rawSource: inspected.source,
        ownerStack: (ownerStack as { fileName?: string; lineNumber?: number; columnNumber?: number; functionName?: string }[])
          .slice(0, 8)
          .map((f) => ({ file: f.fileName ?? null, line: f.lineNumber ?? null, column: f.columnNumber ?? null, fn: f.functionName ?? null })),
        expanded: inspected.expanded,
        missing: inspected.missing,
        truncated: inspected.truncated,
        next: 'react_profile_start + trigger + react_profile_get_commits { component } to see why it renders; tanstack_query_list_queries for the data it shows; react_override_value to try a value.',
      };
    },
  });

  return [pageGetErrors, pageSnapshot, reactExplain];
}
