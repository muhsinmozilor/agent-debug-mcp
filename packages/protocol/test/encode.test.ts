import { describe, expect, it } from 'vitest';
import { decode, encode, expandPaths, getAtPath, type Tagged } from '../src/encode.js';

describe('encode', () => {
  it('passes plain JSON through', () => {
    const r = encode({ a: 1, b: 'x', c: [true, null] });
    expect(r.value).toEqual({ a: 1, b: 'x', c: [true, null] });
    expect(r.truncated).toBe(false);
  });

  it('tags non-JSON primitives and objects', () => {
    const r = encode({
      u: undefined,
      n: NaN,
      i: -Infinity,
      big: 10n,
      d: new Date('2026-01-02T03:04:05.000Z'),
      re: /a+/gi,
      fn: function named(a: number, b: number) {
        return a + b;
      },
      m: new Map([['k', 1]]),
      s: new Set([1, 2]),
      err: new Error('boom'),
    }, { depth: 3 });
    const v = r.value as Record<string, Tagged>;
    expect(v.u).toEqual({ $: 'undefined' });
    expect(v.n).toEqual({ $: 'nan' });
    expect(v.i).toEqual({ $: 'inf', s: -1 });
    expect(v.big).toEqual({ $: 'bigint', v: '10' });
    expect(v.d).toEqual({ $: 'date', iso: '2026-01-02T03:04:05.000Z' });
    expect(v.re).toEqual({ $: 'regexp', src: 'a+', flags: 'gi' });
    expect(v.fn).toEqual({ $: 'fn', name: 'named', arity: 2 });
    expect(v.m).toMatchObject({ $: 'map', size: 1, entries: [['k', 1]] });
    expect(v.s).toMatchObject({ $: 'set', size: 2, values: [1, 2] });
    expect(v.err).toMatchObject({ $: 'error', name: 'Error', message: 'boom' });
  });

  it('collapses beyond depth with a path stub and expands by path', () => {
    const deep = { l1: { l2: { l3: { leaf: 42 } } } };
    const r = encode(deep, { depth: 2 });
    const stub = (r.value as { l1: { l2: Tagged } }).l1.l2;
    expect(stub).toMatchObject({ $: 'object', path: ['l1', 'l2'] });
    const ex = expandPaths(deep, [['l1', 'l2'], ['nope']]);
    expect(ex.expanded[0]?.value).toEqual({ l3: { leaf: 42 } });
    expect(ex.missing).toEqual([['nope']]);
  });

  it('detects cycles', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const r = encode(a);
    expect((r.value as Record<string, unknown>).self).toEqual({ $: 'cycle', path: [] });
  });

  it('truncates long strings and wide objects', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 100; i++) wide[`k${i}`] = i;
    const r = encode({ s: 'x'.repeat(500), wide }, { maxKeys: 10, maxString: 20 });
    const v = r.value as Record<string, unknown>;
    expect(v.s).toEqual({ $: 'string', length: 500, head: 'x'.repeat(20) });
    expect(Object.keys(v.wide as object)).toHaveLength(11); // 10 keys + $more
  });

  it('stops at the byte budget and marks truncated', () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({ i, s: 'abcdefghij' }));
    const r = encode(big, { maxKeys: 10_000, maxBytes: 2000 });
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBeGreaterThan(2000);
  });

  it('encodes class instances with $ctor and typed arrays', () => {
    class Foo {
      x = 1;
    }
    const r = encode({ f: new Foo(), t: new Uint8Array([1, 2, 3]) }, { depth: 3 });
    const v = r.value as Record<string, unknown>;
    expect(v.f).toEqual({ $ctor: 'Foo', x: 1 });
    expect(v.t).toEqual({ $: 'typed', ctor: 'Uint8Array', length: 3, head: [1, 2, 3] });
  });

  it('uses the special hook for host objects', () => {
    const fiber = { tag: 0 };
    const r = encode({ fiber }, {}, { special: (v) => (v === fiber ? { $: 'fiber', elementId: 7, name: 'App' } : undefined) });
    expect((r.value as Record<string, unknown>).fiber).toEqual({ $: 'fiber', elementId: 7, name: 'App' });
  });
});

describe('decode', () => {
  it('revives tagged values and passes JSON through', () => {
    const out = decode({
      a: 1,
      d: { $: 'date', iso: '2026-01-02T03:04:05.000Z' },
      m: { $: 'map', size: 1, entries: [['k', { $: 'bigint', v: '5' }]] },
      u: { $: 'undefined' },
    }) as Record<string, unknown>;
    expect(out.a).toBe(1);
    expect(out.d).toBeInstanceOf(Date);
    expect((out.m as Map<string, bigint>).get('k')).toBe(5n);
    expect(out.u).toBeUndefined();
  });

  it('throws on opaque stubs', () => {
    expect(() => decode({ $: 'fn', name: 'x', arity: 0 })).toThrow(/opaque/);
  });
});

describe('getAtPath', () => {
  it('walks objects, arrays, maps and sets', () => {
    const root = { arr: [new Map([['a', new Set([9])]])] };
    expect(getAtPath(root, ['arr', 0, 0, 1, 0])).toEqual({ found: true, value: 9 });
    expect(getAtPath(root, ['arr', 3]).found).toBe(false);
  });
});
