import './hook-first.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { act, createContext, useContext, useReducer, useRef, useState, Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createReactTools, getTree, inspectFiber, resolveElement } from '../src/index.js';
import type { Tagged } from '@devtools-mcp/protocol';

const Theme = createContext<{ mode: string }>({ mode: 'light' });
Theme.displayName = 'Theme';

function Child({ label, items, when }: { label: string; items: { id: number }[]; when: Date }) {
  const [count, setCount] = useState(3);
  const [flag, toggle] = useReducer((f: boolean) => !f, false);
  const ref = useRef({ big: { nested: { deep: 'value' } } });
  const theme = useContext(Theme);
  void count;
  void flag;
  void toggle;
  void setCount;
  void when;
  return (
    <section data-testid="child" className={theme.mode}>
      <span>{label}</span>
      <ul>
        {items.map((it) => (
          <li key={it.id} data-testid={`item-${it.id}`}>{it.id}</li>
        ))}
      </ul>
      <i>{ref.current.big.nested.deep}</i>
    </section>
  );
}

class Legacy extends Component<{ children?: ReactNode }, { open: boolean; n: number }> {
  override state = { open: true, n: 1 };
  override render() {
    return <div id="legacy">{this.props.children}</div>;
  }
}

function App() {
  return (
    <Theme.Provider value={{ mode: 'dark' }}>
      <Legacy>
        <Child label="hi" items={[{ id: 1 }, { id: 2 }]} when={new Date('2026-01-01T00:00:00Z')} />
      </Legacy>
    </Theme.Provider>
  );
}

const ac = new AbortController();
const tools = createReactTools({ docId: 'd' });
const call = async (name: string, input: unknown) => tools.find((t) => t.name === name)!.execute(input, { signal: ac.signal });

beforeAll(async () => {
  // jsdom has no layout; give every element a non-empty rect so overlay/highlight code paths run.
  Element.prototype.getBoundingClientRect = function () {
    return { x: 10, y: 20, width: 100, height: 30, top: 20, left: 10, right: 110, bottom: 50, toJSON() {} } as DOMRect;
  };
  const el = document.createElement('div');
  document.body.appendChild(el);
  await act(async () => {
    createRoot(el).render(<App />);
  });
});

describe('react_inspect_element', () => {
  it('returns props, hooks, context, owners, hostNodes and source for a function component', async () => {
    const tree = getTree({ docId: 'd' });
    const child = tree.items.find((n) => n.name === 'Child')!;
    const r = inspectFiber(resolveElement(child.id));
    expect(r.name).toBe('Child');
    expect(r.kind).toBe('function');
    expect(r.props).toMatchObject({ label: 'hi', items: [{ id: 1 }, { id: 2 }], when: { $: 'date', iso: '2026-01-01T00:00:00.000Z' } });
    expect(r.state).toBeNull();
    expect(r.hooks).not.toBeNull();
    const names = r.hooks!.map((h) => h.name);
    expect(names).toEqual(['State', 'Reducer', 'Ref', 'Theme']); // context hooks are named after the context
    expect(r.hooks![0]!.value).toBe(3);
    expect(r.hooks![0]!.isStateEditable).toBe(true);
    expect(r.hooks![2]!.value).toMatchObject({ big: { nested: { $: 'object', path: ['big', 'nested'] } } }); // ref unwrapped to .current, collapsed at depth 2
    expect(r.hooks![0]!.source).toMatchObject({ functionName: 'Child', lineNumber: expect.any(Number) });
    expect(r.context).toEqual([{ name: 'Theme', value: { mode: 'dark' } }]);
    expect(r.owners.map((o) => o.name)).toEqual(['App']);
    expect(r.hostNodes[0]).toMatchObject({ tag: 'section', selector: '[data-testid="child"]' });
    // react 19 dev: _debugStack present → raw source frame
    expect(r.source === null || typeof r.source.fileName === 'string').toBe(true);
  });

  it('expands paths into hooks and props', async () => {
    const tree = getTree({ docId: 'd' });
    const child = tree.items.find((n) => n.name === 'Child')!;
    const r = (await call('react_inspect_element', { elementId: child.id, expand: [['hooks', 2, 'big'], ['props', 'items', 1], ['nope']] })) as {
      expanded: { path: unknown[]; value: unknown }[];
      missing: unknown[][];
    };
    expect(r.missing, JSON.stringify(r)).toEqual([['nope']]);
    expect(r.expanded[0]!.value).toEqual({ nested: { deep: 'value' } });
    expect(r.expanded[1]!.value).toEqual({ id: 2 });
    expect(r.missing).toEqual([['nope']]);
  });

  it('returns class state and children props as react_element stubs', () => {
    const tree = getTree({ docId: 'd' });
    const legacy = tree.items.find((n) => n.name === 'Legacy')!;
    const r = inspectFiber(resolveElement(legacy.id));
    expect(r.kind).toBe('class');
    expect(r.state).toEqual({ open: true, n: 1 });
    expect(r.hooks).toBeNull();
    expect((r.props as { children: Tagged }).children).toMatchObject({ $: 'react_element', type: 'Child' });
  });

  it('throws STALE_ELEMENT for unknown ids', async () => {
    await expect(call('react_inspect_element', { elementId: 424242 })).rejects.toMatchObject({ code: 'STALE_ELEMENT' });
  });
});

describe('search / dom tools', () => {
  it('react_search_components by name and props substring', async () => {
    const byName = (await call('react_search_components', { nameRegex: '^child$' })) as { matches: { name: string; ancestors: { name: string }[] }[] };
    expect(byName.matches).toHaveLength(1);
    expect(byName.matches[0]!.ancestors.map((a) => a.name)).toEqual(['Legacy', 'App']);
    const byProps = (await call('react_search_components', { propsContains: '"label":"hi"' })) as { matches: { name: string }[] };
    expect(byProps.matches.map((m) => m.name)).toEqual(['Child']);
    await expect(call('react_search_components', {})).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('react_find_by_dom maps a selector to its component', async () => {
    const r = (await call('react_find_by_dom', { selector: '[data-testid="item-2"]' })) as {
      total: number;
      matches: { element: { tag: string }; component: { name: string }; ancestors: { name: string }[] }[];
    };
    expect(r.total).toBe(1);
    expect(r.matches[0]!.element.tag).toBe('li');
    expect(r.matches[0]!.component.name).toBe('Child');
    expect(r.matches[0]!.ancestors.map((a) => a.name)).toEqual(['Legacy', 'App']);
    await expect(call('react_find_by_dom', { selector: '<<<' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('react_get_dom_nodes lists host nodes', async () => {
    const tree = getTree({ docId: 'd' });
    const legacy = tree.items.find((n) => n.name === 'Legacy')!;
    const r = (await call('react_get_dom_nodes', { elementId: legacy.id })) as { nodes: { tag: string; selector: string }[] };
    expect(r.nodes).toEqual([expect.objectContaining({ tag: 'div', selector: '#legacy' })]);
  });

  it('page_highlight draws an overlay in a closed shadow root', async () => {
    const r = (await call('page_highlight', { selector: '#legacy', durationMs: 100000 })) as { highlighted: number };
    expect(r.highlighted).toBe(1);
    expect(document.querySelector('[data-dtmcp-overlay]')).toBeTruthy();
  });
});
