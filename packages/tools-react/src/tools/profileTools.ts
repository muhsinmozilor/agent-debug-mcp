import { AgentDebugError, decodeCursor, defineTool, encodeCursor, type Page } from '@devtools-mcp/protocol';
import { reactProfileGetCommitsMeta, reactProfileStartMeta, reactProfileStopMeta, reactWatchRendersMeta } from '../descriptors.js';
import { discardSession, getSession, isProfiling, onAnyCommit, startProfiling, stopProfiling, summarise, type CommitRecord } from '../profiler.js';
import type { ToolContext } from './getTree.js';

export function createProfileTools(ctx: ToolContext) {
  const start = defineTool<{ recordChangeDescriptions?: boolean }, unknown>({
    ...reactProfileStartMeta,
    execute: ({ recordChangeDescriptions }) => {
      const s = startProfiling(recordChangeDescriptions ?? true);
      return { started: true, startedAt: s.startedAt, recordChangeDescriptions: s.recordChangeDescriptions, note: 'Interact with the app, then call react_profile_stop.' };
    },
  });

  const stop = defineTool<{ keepData?: boolean }, unknown>({
    ...reactProfileStopMeta,
    execute: ({ keepData }) => {
      const s = stopProfiling();
      const summary = summarise(s.commits);
      const out = {
        stopped: true,
        durationMs: (s.stoppedAt as number) - s.startedAt,
        truncated: s.truncated,
        ...summary,
        hint:
          summary.commits === 0
            ? 'No commits were recorded. Interact with the app between start and stop.'
            : 'Use react_profile_get_commits to page through individual commits and per-component render reasons.',
      };
      if (keepData === false) discardSession();
      return out;
    },
  });

  const getCommits = defineTool<{ cursor?: string; minDurationMs?: number; component?: string; limit?: number }, Page<CommitRecord> & { profiling: boolean }>({
    ...reactProfileGetCommitsMeta,
    execute: ({ cursor, minDurationMs, component, limit }) => {
      const s = getSession();
      if (!s) throw new AgentDebugError('INVALID_INPUT', 'No profile data. Call react_profile_start, interact, then react_profile_stop.');
      let commits = s.commits;
      if (minDurationMs !== undefined) commits = commits.filter((c) => (c.durationMs ?? 0) >= minDurationMs);
      let re: RegExp | null = null;
      if (component) {
        try {
          re = new RegExp(component, 'i');
        } catch (e) {
          throw new AgentDebugError('INVALID_INPUT', `Invalid component regex: ${(e as Error).message}`);
        }
        commits = commits.filter((c) => c.renders.some((r) => re!.test(r.name)));
      }
      const max = Math.min(Math.max(limit ?? 20, 1), 200);
      let startPos = 0;
      if (cursor) {
        const c = decodeCursor(cursor);
        if (!c || c.kind !== 'commits' || c.doc !== ctx.docId || c.gen !== s.generation) throw new AgentDebugError('STALE_CURSOR', 'Cursor is stale (new profile or document)');
        startPos = Number(c.pos);
      }
      const slice = commits.slice(startPos, startPos + max).map((c) => (re ? { ...c, renders: c.renders.filter((r) => re!.test(r.name)) } : c));
      const page: Page<CommitRecord> & { profiling: boolean } = { items: slice, total: commits.length, truncated: startPos + max < commits.length, profiling: isProfiling() };
      if (page.truncated) page.nextCursor = encodeCursor({ doc: ctx.docId, kind: 'commits', gen: s.generation, pos: startPos + max });
      return page;
    },
  });

  const watch = defineTool<{ durationMs?: number; filter?: { nameRegex?: string }; maxEvents?: number }, unknown>({
    ...reactWatchRendersMeta,
    execute: ({ durationMs, filter, maxEvents }, { signal, progress }) => {
      const total = Math.min(Math.max(durationMs ?? 10_000, 100), 300_000);
      const cap = Math.min(Math.max(maxEvents ?? 500, 1), 5000);
      let re: RegExp | null = null;
      if (filter?.nameRegex) {
        try {
          re = new RegExp(filter.nameRegex, 'i');
        } catch (e) {
          throw new AgentDebugError('INVALID_INPUT', `Invalid nameRegex: ${(e as Error).message}`);
        }
      }
      return new Promise((resolve, reject) => {
        const collected: CommitRecord[] = [];
        let events = 0;
        const startedAt = Date.now();
        const off = onAnyCommit((c) => {
          const renders = re ? c.renders.filter((r) => re!.test(r.name)) : c.renders;
          if (renders.length === 0) return;
          events += renders.length;
          collected.push({ ...c, renders });
          if (events >= cap) finish();
        });
        const tick = setInterval(() => {
          progress?.({ progress: Date.now() - startedAt, total, message: `${collected.length} commits, ${events} renders so far` });
        }, 1000);
        const timer = setTimeout(finish, total);
        const onAbort = (): void => {
          cleanup();
          reject(new AgentDebugError('CANCELLED', 'react_watch_renders cancelled by the client'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        function cleanup(): void {
          off();
          clearInterval(tick);
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
        }
        function finish(): void {
          cleanup();
          const summary = summarise(collected);
          const timeline = collected.slice(-50).map((c) => ({
            t: c.timestamp - startedAt,
            durationMs: c.durationMs,
            renders: c.renders.map((r) => `${r.name}${r.causes.includes('mount') ? '+' : ''}(${r.causes.filter((x) => x !== 'parent').join(',') || 'parent'})`),
          }));
          resolve({ watchedMs: Date.now() - startedAt, capped: events >= cap, ...summary, timeline });
        }
      });
    },
  });

  return [start, stop, getCommits, watch];
}
