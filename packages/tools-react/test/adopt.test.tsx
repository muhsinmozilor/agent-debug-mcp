/**
 * Adopt mode: a hook already exists (installed by the official React DevTools extension) before we
 * initialise. We must not replace it, and tools must still work through it.
 */
import './fake-official-hook.js';
import './hook-first.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createReactTools, getReactHookState, getTree } from '../src/index.js';

function Leaf() {
  return <b>leaf</b>;
}
function App() {
  return (
    <div>
      <Leaf />
    </div>
  );
}

beforeAll(async () => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  await act(async () => {
    createRoot(el).render(<App />);
  });
});

describe('adopt mode', () => {
  it('detects the official hook and keeps it in place', () => {
    const s = getReactHookState()!;
    expect(s.mode).toBe('official-devtools');
    const hook = (globalThis as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: { __fake: boolean } }).__REACT_DEVTOOLS_GLOBAL_HOOK__;
    expect(hook.__fake).toBe(true); // not replaced
  });
  it('still lists renderers and the tree', async () => {
    const tools = createReactTools({ docId: 'd' });
    const r = (await tools.find((t) => t.name === 'react_get_renderers')!.execute({}, { signal: new AbortController().signal })) as { renderers: unknown[]; hookMode: string };
    expect(r.renderers).toHaveLength(1);
    expect(r.hookMode).toBe('official-devtools');
    expect(getTree({ docId: 'd' }).items.map((n) => n.name)).toEqual(['App', 'Leaf']);
  });
});
