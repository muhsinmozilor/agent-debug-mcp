import type { ToolDefinition } from '@devtools-mcp/protocol';
import { reactGetRenderers } from './tools/getRenderers.js';
import { createReactGetTree, type ToolContext } from './tools/getTree.js';
import {
  pageElementAtPoint,
  pageHighlight,
  pagePickElement,
  reactFindByDom,
  reactGetDomNodes,
  reactGetSource,
  reactInspectElement,
  reactSearchComponents,
} from './tools/inspectTools.js';
import { reactForceRerender, reactOverrideValue } from './tools/mutateTools.js';
import { createPageTools, type PageToolContext } from './tools/pageTools.js';
import { createProfileTools } from './tools/profileTools.js';

export * from './hook.js';
export * from './elements.js';
export * from './naming.js';
export * from './tree.js';
export * from './dom.js';
export * from './inspect.js';
export { highlightElements, clearHighlight } from './overlay.js';
export * from './profiler.js';
export * from './errors.js';
export * from './snapshot.js';
export type { PageToolContext } from './tools/pageTools.js';
export { reactToolMetas } from './descriptors.js';

/**
 * Build the React + page tool set bound to a document context. Call initReactHook() first (at document_start) and
 * pass the ErrorLog that installErrorCapture() feeds so page_get_errors has something to read.
 */
export function createReactTools(ctx: ToolContext & PageToolContext): ToolDefinition<unknown, unknown>[] {
  return [
    ...createPageTools(ctx),
    reactGetRenderers,
    createReactGetTree(ctx),
    reactInspectElement,
    reactSearchComponents,
    reactFindByDom,
    reactGetDomNodes,
    reactGetSource,
    pageHighlight,
    pageElementAtPoint,
    pagePickElement,
    reactOverrideValue,
    reactForceRerender,
    ...createProfileTools(ctx),
  ] as unknown as ToolDefinition<unknown, unknown>[];
}
