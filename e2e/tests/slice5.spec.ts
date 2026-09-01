import { expect, parseResult, test } from './fixtures.js';

test.describe('slice 5 — profiling', () => {
  test('profile start/stop/get_commits attribute re-renders to props, hooks and context', async ({ context, mcp, waitForTabs }) => {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByTestId('app')).toBeVisible();
    await waitForTabs(1);

    const start = parseResult(await mcp.callTool({ name: 'react_profile_start', arguments: {} }));
    expect(start.isError, JSON.stringify(start.data)).toBe(false);
    const again = parseResult(await mcp.callTool({ name: 'react_profile_start', arguments: {} }));
    expect((again.data.error as { code: string }).code).toBe('PROFILE_ALREADY_RUNNING');

    await page.getByTestId('increment').click();
    await page.getByTestId('increment').click();
    await page.getByTestId('toggle-theme').click();
    await expect(page.getByTestId('increment')).toHaveText('count is 2');

    const stop = parseResult(await mcp.callTool({ name: 'react_profile_stop', arguments: {} }));
    expect(stop.isError, JSON.stringify(stop.data)).toBe(false);
    const s = stop.data.result as {
      commits: number;
      causes: Record<string, number>;
      mostRendered: { name: string; renders: number; causes: Record<string, number>; changedProps: Record<string, number>; totalSelfMs: number }[];
      hottest: { name: string }[];
    };
    expect(s.commits).toBeGreaterThanOrEqual(3);
    const counter = s.mostRendered.find((c) => c.name === 'Counter')!;
    expect(counter.causes.props).toBeGreaterThanOrEqual(2);
    expect(counter.changedProps.count).toBeGreaterThanOrEqual(2);
    const app = s.mostRendered.find((c) => c.name === 'App')!;
    expect(app.causes.hooks).toBeGreaterThanOrEqual(3);
    const themed = s.mostRendered.find((c) => c.name === 'Themed')!;
    expect(themed.causes.context).toBeGreaterThanOrEqual(1);
    expect(s.mostRendered.find((c) => c.name === 'MemoList')).toBeUndefined(); // memo() with stable props never re-rendered
    expect(s.hottest.length).toBeGreaterThan(0);

    const commits = parseResult(await mcp.callTool({ name: 'react_profile_get_commits', arguments: { limit: 2 } }));
    const c = commits.data.result as { items: { renders: { name: string; causes: string[]; selfDurationMs: number | null }[] }[]; nextCursor?: string; truncated: boolean; total: number };
    expect(c.items).toHaveLength(2);
    expect(c.truncated).toBe(true);
    expect(c.items[0]!.renders.some((r) => r.name === 'Counter' && r.causes.includes('props'))).toBe(true);
    expect(c.items[0]!.renders.some((r) => typeof r.selfDurationMs === 'number')).toBe(true); // dev build exposes durations
    const rest = parseResult(await mcp.callTool({ name: 'react_profile_get_commits', arguments: { limit: 50, cursor: c.nextCursor } }));
    expect((rest.data.result as { items: unknown[]; truncated: boolean }).truncated).toBe(false);
  });

  test('watch_renders returns a digest after the duration and aborts within a second when the client cancels', async ({ context, mcp, waitForTabs, relay }) => {
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByTestId('app')).toBeVisible();
    await waitForTabs(1);

    const watching = mcp.callTool({ name: 'react_watch_renders', arguments: { durationMs: 2500 } });
    await page.waitForTimeout(300);
    await page.getByTestId('increment').click();
    await page.getByTestId('toggle-theme').click();
    const digest = parseResult(await watching);
    expect(digest.isError, JSON.stringify(digest.data)).toBe(false);
    const d = digest.data.result as { commits: number; timeline: { renders: string[] }[] };
    expect(d.commits).toBeGreaterThanOrEqual(2);
    expect(d.timeline.flatMap((t) => t.renders)).toEqual(expect.arrayContaining([expect.stringMatching(/^Counter\(props\)/), expect.stringMatching(/^App\(hooks\)/)]));

    // cancel: abort the HTTP request; the relay must cancel the page call and free everything
    const ac = new AbortController();
    const pending = mcp.callTool({ name: 'react_watch_renders', arguments: { durationMs: 60_000 } }, undefined, { signal: ac.signal });
    await page.waitForTimeout(500);
    const t0 = Date.now();
    ac.abort();
    await expect(pending).rejects.toBeTruthy();
    await expect.poll(() => relay.link.calls.size(), { timeout: 1000 }).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1500);
    // a new profile can start immediately (watch released the hook subscription cleanly)
    const start = parseResult(await mcp.callTool({ name: 'react_profile_start', arguments: {} }));
    expect(start.isError).toBe(false);
    await mcp.callTool({ name: 'react_profile_stop', arguments: { keepData: false } });
  });
});
