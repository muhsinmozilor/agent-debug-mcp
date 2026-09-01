import './hook-first.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createReactTools } from '../src/index.js';

function Counter() {
  const [n, setN] = useState(3);
  return (
    <button data-testid="inc" onClick={() => setN(n + 1)}>
      count is {n}
    </button>
  );
}
function Search() {
  return (
    <form aria-label="Search">
      <label htmlFor="q">Query</label>
      <input id="q" placeholder="type…" defaultValue="react" />
      <input type="checkbox" id="c" defaultChecked /> <label htmlFor="c">Exact</label>
      <button type="submit" disabled>
        Go
      </button>
    </form>
  );
}
function App() {
  return (
    <main>
      <h1>Demo</h1>
      <nav>
        <a href="/users">Users</a>
        <a href="/settings" aria-current="page">Settings</a>
      </nav>
      <Counter />
      <Search />
      <ul>
        <li>one</li>
        <li>
          two <span>hidden text?</span>
        </li>
      </ul>
      <p hidden>invisible</p>
      <div data-testid="plain">just a div</div>
      <div>ignored generic</div>
    </main>
  );
}

const ac = new AbortController();
const tools = createReactTools({ docId: 'd' });
const call = async (name: string, input: unknown) => tools.find((t) => t.name === name)!.execute(input, { signal: ac.signal });

beforeAll(async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => createRoot(host).render(<App />));
});

describe('page_snapshot', () => {
  it('outlines roles, names, attributes, selectors and owning components', async () => {
    const res = (await call('page_snapshot', {})) as { tree: string; nodeCount: number; truncated: boolean };
    expect(res.truncated).toBe(false);
    const t = res.tree;
    expect(t).toMatch(/^- main \{/m);
    expect(t).toContain('- heading "Demo" [level=1]');
    expect(t).toContain('- navigation');
    expect(t).toContain('- link "Users" [href="/users"]');
    expect(t).toContain('- link "Settings" [href="/settings"] [current="page"]');
    expect(t).toMatch(/- button "count is 3" \{\[data-testid="inc"\]\} → Counter#\d+/);
    expect(t).toContain('- form "Search"');
    expect(t).toContain('- textbox "Query" [value="react"] {#q}');
    expect(t).toContain('- checkbox "Exact" [checked] {#c}');
    expect(t).toContain('- button "Go" [disabled]');
    expect(t).toContain('- list {');
    expect(t).toContain('- listitem "two hidden text?"');
    expect(t).not.toContain('invisible');
    expect(t).toContain('- generic "just a div"'.replace(' "just a div"', '')); // generic has no text name
    expect(t).toContain('{[data-testid="plain"]}');
    expect(t).not.toContain('ignored generic');
    // Owner printed once for the subtree: App owns main; Counter's button changes owner.
    expect(t.match(/→ App#\d+/g)!.length).toBe(1);
  });

  it('supports interactiveOnly, a root selector, json format and truncation', async () => {
    const only = (await call('page_snapshot', { interactiveOnly: true })) as { tree: string };
    expect(only.tree).not.toContain('heading');
    expect(only.tree).toContain('- link "Users"');
    expect(only.tree).toContain('- button "count is 3"');
    const scoped = (await call('page_snapshot', { selector: 'form', format: 'json' })) as { nodes: { role: string; depth: number; component: { name: string } | null }[]; root: string };
    expect(scoped.root).toBe('form');
    expect(scoped.nodes[0]).toMatchObject({ role: 'form', depth: 0, component: { name: 'Search' } });
    const cut = (await call('page_snapshot', { maxNodes: 3 })) as { nodeCount: number; truncated: boolean };
    expect(cut).toMatchObject({ nodeCount: 3, truncated: true });
    await expect(call('page_snapshot', { selector: '#nope' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('react_explain', () => {
  it('aggregates component, props/hooks, DOM nodes, ancestors and source for a selector', async () => {
    const res = (await call('react_explain', { selector: '[data-testid="inc"]' })) as {
      component: { name: string; id: number };
      matchedElement: { selector: string };
      matches: number;
      hooks: { name: string }[] | null;
      domNodes: { tag: string }[];
      ancestors: { name: string }[];
      ownerStack: unknown[];
      next: string;
    };
    expect(res.component.name).toBe('Counter');
    expect(res.matches).toBe(1);
    expect(res.matchedElement.selector).toBe('[data-testid="inc"]');
    expect(res.hooks?.[0]?.name).toBe('State');
    expect(res.domNodes[0]).toMatchObject({ tag: 'button' });
    expect(res.ancestors.map((a) => a.name)).toContain('App');
    expect(res.next).toContain('react_profile_start');
    const byId = (await call('react_explain', { elementId: res.component.id })) as { component: { name: string }; matches: undefined };
    expect(byId.component.name).toBe('Counter');
    expect(byId.matches).toBeUndefined();
    await expect(call('react_explain', {})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(call('react_explain', { selector: 'body' })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('not rendered by React') });
  });
});
