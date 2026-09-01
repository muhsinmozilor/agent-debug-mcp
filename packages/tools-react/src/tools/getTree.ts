import { defineTool } from '@devtools-mcp/protocol';
import { reactGetTreeMeta } from '../descriptors.js';
import { getTree, type TreeFilter, type TreeNode } from '../tree.js';
import type { Page } from '@devtools-mcp/protocol';

export interface GetTreeInput {
  rootId?: number;
  maxDepth?: number;
  maxNodes?: number;
  cursor?: string;
  filter?: TreeFilter;
}

export interface ToolContext {
  docId: string;
}

export function createReactGetTree(ctx: ToolContext) {
  return defineTool<GetTreeInput, Page<TreeNode> & { generation: number; treeChanged: boolean }>({
    ...reactGetTreeMeta,
    execute: (input) => getTree({ ...input, docId: ctx.docId }),
  });
}
