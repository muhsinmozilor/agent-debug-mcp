/** Feed failed queries / mutations into the page ErrorLog (for `page_get_errors`). Idempotent per client. */
import { describeThrown, preview, type ErrorLog } from '@devtools-mcp/protocol';
import type { QueryClientLike } from './client.js';

const attached = new WeakSet<object>();

export function captureQueryErrors(log: ErrorLog, client: QueryClientLike): () => void {
  if (attached.has(client)) return () => undefined;
  attached.add(client);
  const unsubQueries = client.getQueryCache().subscribe((event) => {
    const e = event as { type?: string; action?: { type?: string; error?: unknown }; query?: { queryHash: string; queryKey: readonly unknown[] } };
    if (e.type !== 'updated' || e.action?.type !== 'error' || !e.query) return;
    const thrown = describeThrown(e.action.error);
    const entry: Parameters<ErrorLog['push']>[0] = {
      kind: 'query',
      message: `Query ${preview(e.query.queryKey, 120)} failed: ${thrown.message}`,
      source: `query:${e.query.queryHash}`,
      data: { queryHash: e.query.queryHash },
    };
    if (thrown.stack) entry.stack = thrown.stack;
    log.push(entry);
  });
  const unsubMutations = client.getMutationCache().subscribe((event) => {
    const e = event as { type?: string; action?: { type?: string; error?: unknown }; mutation?: { mutationId: number; options: { mutationKey?: unknown } } };
    if (e.type !== 'updated' || e.action?.type !== 'error' || !e.mutation) return;
    const thrown = describeThrown(e.action.error);
    const key = e.mutation.options.mutationKey;
    const entry: Parameters<ErrorLog['push']>[0] = {
      kind: 'mutation',
      message: `Mutation ${key !== undefined ? preview(key, 80) : `#${e.mutation.mutationId}`} failed: ${thrown.message}`,
      source: `mutation:${e.mutation.mutationId}`,
      data: { mutationId: e.mutation.mutationId },
    };
    if (thrown.stack) entry.stack = thrown.stack;
    log.push(entry);
  });
  return () => {
    unsubQueries();
    unsubMutations();
    attached.delete(client);
  };
}
