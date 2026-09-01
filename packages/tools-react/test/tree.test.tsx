import './hook-first.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { memo, StrictMode, useState } from 'react';
import { createReactTools, hasReact, getTree } from '../src/index.js';


function Leaf({ label }: { label: string }) {
  const [n] = useState(0);
  return <span data-n={n}>{label}</span>;
}
const MemoLeaf = memo(Leaf);
function List() {
  return (
    <ul>
      {['a', 'b', 'c'].map((k) => (
        <li key={k}>
          <MemoLeaf label={k} />
        </li>
      ))}
    </ul>
  );
}
function App() {
  return (
    <StrictMode>
      <div>
        <List />
        <Leaf label="solo" />
      </div>
    </StrictMode>
  );
}

let root: Root;
beforeAll(async () => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => {
    root.render(<App />);
  });
});

describe('react_get_renderers', () => {
  it('reports a development renderer with one root', async () => {
    expect(hasReact()).toBe(true);
    const tools = createReactTools({ docId: 'doc1' });
    const renderers = tools.find((t) => t.name === 'react_get_renderers')!;
    const r = (await renderers.execute({}, { signal: new AbortController().signal })) as {
      renderers: { version: string | null; buildType: string; rootCount: number; supports: { overrideProps: boolean } }[];
      hookMode: string;
    };
    expect(r.renderers).toHaveLength(1);
    expect(r.renderers[0]!.version).toMatch(/^19\./);
    expect(r.renderers[0]!.buildType).toBe('development');
    expect(r.renderers[0]!.rootCount).toBe(1);
    expect(r.renderers[0]!.supports.overrideProps).toBe(true);
    expect(['Agent Debug MCP', 'other']).toContain(r.hookMode);
  });
});

describe('react_get_tree', () => {
  it('lists composite components, hiding hosts and wrappers', () => {
    const page = getTree({ docId: 'doc1' });
    const names = page.items.map((n) => `${n.depth}:${n.name}`);
    expect(names).toEqual(['0:App', '1:List', '2:Leaf', '2:Leaf', '2:Leaf', '1:Leaf']);
    expect(page.items[1]!.parentId).toBe(page.items[0]!.id);
    expect(page.items[1]!.childCount).toBe(3);
    expect(page.items[2]!.kind).toBe('memo');
    expect(page.items[2]!.key).toBeNull(); // key sits on the <li> host, not the memo
    expect(page.truncated).toBe(false);
  });

  it('shows hosts when asked and respects maxDepth', () => {
    const page = getTree({ docId: 'doc1', filter: { hideHost: false }, maxDepth: 1 });
    expect(page.items.map((n) => n.name)).toEqual(['App', 'div']);
  });

  it('paginates with a cursor', () => {
    const p1 = getTree({ docId: 'doc1', maxNodes: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.truncated).toBe(true);
    expect(p1.total).toBe(6);
    const p2 = getTree({ docId: 'doc1', maxNodes: 10, cursor: p1.nextCursor });
    expect(p2.items.map((n) => n.name)).toEqual(['Leaf', 'Leaf', 'Leaf', 'Leaf']);
    expect(p2.truncated).toBe(false);
    expect(() => getTree({ docId: 'other', cursor: p1.nextCursor })).toThrow(/previous document/);
  });

  it('filters by name and keeps ancestors', () => {
    const page = getTree({ docId: 'doc1', filter: { nameRegex: '^list$' } });
    expect(page.items.map((n) => n.name)).toEqual(['App', 'List']);
  });

  it('walks a subtree by rootId', () => {
    const all = getTree({ docId: 'doc1' });
    const list = all.items.find((n) => n.name === 'List')!;
    const sub = getTree({ docId: 'doc1', rootId: list.id });
    expect(sub.items.map((n) => `${n.depth}:${n.name}`)).toEqual(['0:List', '1:Leaf', '1:Leaf', '1:Leaf']);
    expect(() => getTree({ docId: 'doc1', rootId: 999999 })).toThrow(/No mounted component/);
  });
});
