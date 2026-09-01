import './hook-first.js';
import { ErrorLog } from '@devtools-mcp/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { act, Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createReactTools, formatConsoleArgs, installErrorCapture } from '../src/index.js';

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <p>fallback</p> : this.props.children;
  }
}
function Broken(): ReactNode {
  throw new Error('render exploded');
}

describe('error capture', () => {
  let uninstall: (() => void) | null = null;
  afterEach(() => uninstall?.());

  it('formats console arguments like the console does', () => {
    expect(formatConsoleArgs(['Failed %s after %d ms', 'fetch', 12]).message).toBe('Failed fetch after 12 ms');
    const err = new Error('bad');
    const f = formatConsoleArgs(['Request failed', err, { status: 500 }]);
    expect(f.error).toBe(err);
    expect(f.message).toContain('Request failed');
    expect(f.message).toContain('Error: bad');
    expect(f.message).toContain('500');
    const stack = '\n    at Counter (http://localhost/App.tsx:12:5)\n    at App (http://localhost/App.tsx:3:1)';
    expect(formatConsoleArgs(['An error occurred in the <Counter> component.', stack]).componentStack).toBe(stack.trim());
  });

  it('records console.error/warn, window errors, rejections and React boundary catches; page_get_errors pages by seq', async () => {
    const log = new ErrorLog();
    const original = console.error;
    uninstall = installErrorCapture(log);
    expect(console.error).not.toBe(original);

    console.error('plain failure', { code: 7 });
    console.error('plain failure', { code: 7 }); // duplicate → count 2
    console.warn('deprecated thing');
    window.dispatchEvent(new ErrorEvent('error', { error: new RangeError('out of range'), message: 'out of range', filename: 'http://localhost/x.js', lineno: 4, colno: 2 }));
    const rejection = new Event('unhandledrejection') as Event & { reason?: unknown };
    rejection.reason = new Error('nobody caught me');
    window.dispatchEvent(rejection);

    // React error boundary: React 19 logs the caught error through console.error with a component stack.
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const silence = console.error; // keep the patched one (records) but avoid noisy test output
    console.error = (...args: unknown[]) => (silence as (...a: unknown[]) => void).call(console, ...args);
    await act(async () => {
      root.render(
        <Boundary>
          <Broken />
        </Boundary>,
      );
    });
    expect(host.textContent).toBe('fallback');

    const entries = log.all();
    expect(entries.find((e) => e.kind === 'console.error')).toMatchObject({ message: expect.stringContaining('plain failure'), count: 2 });
    expect(entries.find((e) => e.kind === 'console.warn')).toMatchObject({ message: 'deprecated thing' });
    expect(entries.find((e) => e.kind === 'exception')).toMatchObject({ message: 'RangeError: out of range', data: { file: 'http://localhost/x.js', line: 4, column: 2 } });
    expect(entries.find((e) => e.kind === 'unhandledrejection')).toMatchObject({ message: 'Unhandled promise rejection: nobody caught me' });
    const react = entries.find((e) => e.kind === 'react');
    expect(react, JSON.stringify(entries.map((e) => [e.kind, e.message.slice(0, 60)]))).toBeDefined();
    expect(react!.message).toContain('render exploded');
    expect(react!.componentStack).toMatch(/Broken/);

    // The tool: default excludes warnings; `since` returns only newer entries.
    const tools = createReactTools({ docId: 'd', errors: log });
    const tool = tools.find((t) => t.name === 'page_get_errors')!;
    const ac = new AbortController();
    const all = (await tool.execute({}, { signal: ac.signal })) as { errors: { kind: string; seq: number }[]; latestSeq: number; total: number };
    expect(all.errors.some((e) => e.kind === 'console.warn')).toBe(false);
    expect(all.total).toBe(all.errors.length);
    const withWarn = (await tool.execute({ includeWarnings: true }, { signal: ac.signal })) as { errors: { kind: string }[] };
    expect(withWarn.errors.some((e) => e.kind === 'console.warn')).toBe(true);
    const nothingNew = (await tool.execute({ since: all.latestSeq }, { signal: ac.signal })) as { errors: unknown[]; hint: string };
    expect(nothingNew.errors).toEqual([]);
    expect(nothingNew.hint).toContain(`since=${all.latestSeq}`);
    console.error('later');
    const newer = (await tool.execute({ since: all.latestSeq, kinds: ['console.error'] }, { signal: ac.signal })) as { errors: { message: string }[] };
    expect(newer.errors.map((e) => e.message)).toEqual(['later']);

    await act(async () => root.unmount());
    uninstall();
    uninstall = null;
    expect(console.error).toBe(original);
  });
});
