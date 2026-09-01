import { describe, expect, it } from 'vitest';
import { makeFrame, parseFrame } from '../src/frame.js';
import { decodeCursor, encodeCursor } from '../src/cursor.js';
import { hashSchema, toDescriptor, defineTool } from '../src/tool.js';
import { DevtoolsError } from '../src/errors.js';

describe('frames', () => {
  it('round-trips through the schema', () => {
    const f = makeFrame({ t: 'invoke', callId: 'c1', tab: 't12', tool: 'react_get_tree', input: { maxDepth: 2 }, deadlineAt: 1 });
    const parsed = parseFrame(JSON.parse(JSON.stringify(f)));
    expect(parsed).toEqual(f);
  });
  it('round-trips CDP bridge frames', () => {
    const req = makeFrame({ t: 'cdp.request', requestId: 'r1', op: 'attach', tab: 't7' });
    expect(parseFrame(JSON.parse(JSON.stringify(req)))).toEqual(req);
    const res = makeFrame({ t: 'cdp.response', requestId: 'r1', tab: 't7', targetInfo: { targetId: 'ABC', type: 'page', url: 'http://localhost/' } });
    expect(parseFrame(JSON.parse(JSON.stringify(res)))).toEqual(res);
    const cmd = makeFrame({ t: 'cdp.command', cmdId: 3, tab: 't7', sessionId: 'child', method: 'Page.navigate', params: { url: 'http://localhost/' } });
    expect(parseFrame(JSON.parse(JSON.stringify(cmd)))).toEqual(cmd);
    const err = makeFrame({ t: 'cdp.result', cmdId: 3, error: { code: -32601, message: 'nope' } });
    expect(parseFrame(JSON.parse(JSON.stringify(err)))).toEqual(err);
    expect(parseFrame({ ...req, op: 'explode' })).toBeNull();
    expect(parseFrame({ ...cmd, cmdId: 'x' })).toBeNull();
  });
  it('rejects bad tab handles and unknown types', () => {
    expect(parseFrame({ v: 1, id: 'x', ts: 0, t: 'invoke', callId: 'c', tab: 'tab-1', tool: 'a', input: {}, deadlineAt: 0 })).toBeNull();
    expect(parseFrame({ v: 1, id: 'x', ts: 0, t: 'nope' })).toBeNull();
  });
});

describe('cursor', () => {
  it('round-trips', () => {
    const c = { doc: 'd1', kind: 'tree' as const, gen: 3, pos: 42 };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor('garbage')).toBeNull();
  });
});

describe('tool descriptors', () => {
  it('hashes schemas stably regardless of key order', () => {
    expect(hashSchema({ type: 'object', properties: { a: { type: 'string' } } })).toBe(
      hashSchema({ properties: { a: { type: 'string' } }, type: 'object' }),
    );
  });
  it('produces a descriptor without execute', () => {
    const t = defineTool<{ x: number }, number>({
      name: 'demo_tool',
      description: 'd',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true },
      capability: 'page',
      mutation: false,
      execute: ({ x }) => x,
    });
    const d = toDescriptor(t as never);
    expect(d).not.toHaveProperty('execute');
    expect(d.schemaHash).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('DevtoolsError', () => {
  it('serialises and infers retryable', () => {
    const e = new DevtoolsError('TIMEOUT', 'slow', { hint: 'retry' });
    expect(e.toJSON()).toEqual({ code: 'TIMEOUT', message: 'slow', hint: 'retry', retryable: true });
    expect(DevtoolsError.from(new Error('x')).code).toBe('PAGE_ERROR');
    expect(DevtoolsError.from({ code: 'TAB_NOT_FOUND', message: 'm', retryable: false }).code).toBe('TAB_NOT_FOUND');
  });
});
