import { AgentDebugError } from '@devtools-mcp/protocol';
import { getFiberById, getFiberId, type Fiber } from 'bippy';

/** Stable numeric id for a fiber (shared with its alternate). */
export function elementIdOf(fiber: Fiber): number {
  return getFiberId(fiber);
}

/** Resolve an element id to its current fiber or throw STALE_ELEMENT. */
export function resolveElement(elementId: number): Fiber {
  const fiber = getFiberById(elementId);
  if (!fiber) {
    throw new AgentDebugError('STALE_ELEMENT', `No mounted component with id ${elementId}`, {
      hint: 'The component unmounted or the page navigated. Re-run react_get_tree or react_search_components to get fresh ids.',
    });
  }
  return fiber;
}
