import { describe, expect, it } from 'vitest';
import { describeThrown, ErrorLog } from '../src/error-log.js';

describe('ErrorLog', () => {
  it('collapses consecutive duplicates, pages by seq and evicts beyond the cap', () => {
    const log = new ErrorLog(3);
    log.push({ kind: 'console.error', message: 'a', ts: 1 });
    log.push({ kind: 'console.error', message: 'a', ts: 2 });
    expect(log.size).toBe(1);
    expect(log.all()[0]).toMatchObject({ seq: 1, count: 2, ts: 1, lastTs: 2 });
    log.push({ kind: 'exception', message: 'b' });
    log.push({ kind: 'query', message: 'c' });
    log.push({ kind: 'router', message: 'd' });
    expect(log.size).toBe(3);
    expect(log.evictedCount).toBe(1);
    expect(log.all().map((e) => e.message)).toEqual(['b', 'c', 'd']);
    expect(log.since(3).map((e) => e.message)).toEqual(['d']);
    expect(log.latestSeq).toBe(4);
    // Same message from a different source is a new entry.
    log.push({ kind: 'query', message: 'c', source: 'query:x' });
    expect(log.all().at(-1)).toMatchObject({ seq: 5, count: 1 });
  });

  it('describes thrown values', () => {
    const e = new TypeError('boom');
    expect(describeThrown(e)).toMatchObject({ message: 'TypeError: boom', name: 'TypeError' });
    expect(describeThrown(e).stack).toContain('boom');
    expect(describeThrown('plain')).toEqual({ message: 'plain' });
    expect(describeThrown({ code: 1 })).toEqual({ message: '{"code":1}' });
  });
});
