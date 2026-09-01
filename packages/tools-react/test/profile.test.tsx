import './hook-first.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { act, createContext, memo, useContext, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createReactTools } from '../src/index.js';

const Theme = createContext('light');
Theme.displayName = 'Theme';

let setCount: (n: number) => void = () => undefined;
let setTheme: (t: string) => void = () => undefined;

function Counter({ count }: { count: number }) {
  return <b>{count}</b>;
}
const Static = memo(function Static() {
  return <i>static</i>;
});
function Themed() {
  const t = useContext(Theme);
  return <u>{t}</u>;
}
function App() {
  const [count, _setCount] = useState(0);
  const [theme, _setTheme] = useState('light');
  setCount = _setCount;
  setTheme = _setTheme;
  return (
    <Theme.Provider value={theme}>
      <Counter count={count} />
      <Static />
      <Themed />
    </Theme.Provider>
  );
}

const tools = createReactTools({ docId: 'd' });
const call = async (name: string, input: unknown, signal = new AbortController().signal, progress?: (u: unknown) => void) =>
  tools.find((t) => t.name === name)!.execute(input, { signal, progress: progress as never });

beforeAll(async () => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  await act(async () => {
    createRoot(el).render(<App />);
  });
});

describe('profiling', () => {
  it('records commits with render causes and summarises', async () => {
    await call('react_profile_start', {});
    await expect(call('react_profile_start', {})).rejects.toMatchObject({ code: 'PROFILE_ALREADY_RUNNING' });
    await act(async () => setCount(1));
    await act(async () => setTheme('dark'));
    const summary = (await call('react_profile_stop', {})) as {
      commits: number;
      renders: number;
      causes: Record<string, number>;
      mostRendered: { name: string; renders: number; causes: Record<string, number>; changedProps: Record<string, number> }[];
    };
    expect(summary.commits).toBe(2);
    const app = summary.mostRendered.find((c) => c.name === 'App')!;
    expect(app.renders).toBe(2);
    expect(app.causes.hooks).toBe(2);
    const counter = summary.mostRendered.find((c) => c.name === 'Counter')!;
    expect(counter.causes.props).toBe(1); // count changed
    expect(counter.causes.parent).toBe(1); // theme change: same props, parent re-render
    expect(counter.changedProps).toEqual({ count: 1 });
    const themed = summary.mostRendered.find((c) => c.name === 'Themed')!;
    expect(themed.causes.context).toBe(1);
    expect(summary.mostRendered.find((c) => c.name === 'Static')).toBeUndefined(); // memo skipped
    expect(summary.causes.hooks).toBe(2);

    const commits = (await call('react_profile_get_commits', { limit: 1 })) as { items: { renders: { name: string; causes: string[] }[] }[]; nextCursor?: string; total: number };
    expect(commits.total).toBe(2);
    expect(commits.items[0]!.renders.map((r) => `${r.name}:${r.causes.join('+')}`)).toEqual(expect.arrayContaining(['App:hooks', 'Counter:props', 'Themed:parent']));
    const page2 = (await call('react_profile_get_commits', { limit: 1, cursor: commits.nextCursor })) as { items: { renders: { name: string; causes: string[] }[] }[] };
    expect(page2.items[0]!.renders.find((r) => r.name === 'Themed')!.causes).toEqual(['context']);
    const filtered = (await call('react_profile_get_commits', { component: '^counter$' })) as { items: { renders: { name: string }[] }[] };
    expect(filtered.items.every((c) => c.renders.every((r) => r.name === 'Counter'))).toBe(true);
  });

  it('watch_renders streams progress, returns a digest, and cancels', async () => {
    const progressEvents: unknown[] = [];
    const watching = call('react_watch_renders', { durationMs: 1500 }, undefined, (u) => progressEvents.push(u));
    await new Promise((r) => setTimeout(r, 100));
    await act(async () => setCount(5));
    const digest = (await watching) as { commits: number; timeline: { renders: string[] }[]; watchedMs: number };
    expect(digest.commits).toBe(1);
    expect(digest.timeline[0]!.renders).toEqual(expect.arrayContaining(['App(hooks)', 'Counter(props)', 'Themed(parent)']));
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);

    const ac = new AbortController();
    const pending = call('react_watch_renders', { durationMs: 60_000 }, ac.signal);
    setTimeout(() => ac.abort(), 50);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
