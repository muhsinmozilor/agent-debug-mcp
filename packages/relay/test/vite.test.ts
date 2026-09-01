import { describe, expect, it } from 'vitest';
import type { Plugin } from 'vite';
import { devtoolsMcp, QUERY_MODULE, ROUTER_MODULE } from '../src/vite.js';

type Hook<K extends keyof Plugin> = Extract<Plugin[K], (...a: never[]) => unknown>;
const call = <K extends keyof Plugin>(p: Plugin, k: K, ...args: unknown[]) => {
  const h = p[k] as unknown as Hook<K> | { handler: Hook<K> };
  const fn = typeof h === 'function' ? h : (h as { handler: Hook<K> }).handler;
  return (fn as unknown as (...a: unknown[]) => unknown).call({}, ...args);
};

describe('agent-debug-mcp/vite', () => {
  it('aliases the TanStack entry points to wrappers that register instances on window, dev only', () => {
    const p = devtoolsMcp();
    expect(p.apply).toBe('serve');
    expect(p.enforce).toBe('pre');
    // Pretend both packages are installed (the demo app has them).
    const cfg = call(p, 'config', { root: `${process.cwd()}/../demo-app` }, { command: 'serve', mode: 'development' }) as { optimizeDeps: { include: string[] } };
    expect(cfg.optimizeDeps.include.sort()).toEqual([QUERY_MODULE, ROUTER_MODULE]);

    const vq = call(p, 'resolveId', QUERY_MODULE, '/src/main.tsx') as string;
    expect(vq).toMatch(/^\0devtools-mcp\/tanstack-query$/);
    // The wrapper's own import of the real package passes through.
    expect(call(p, 'resolveId', QUERY_MODULE, vq)).toBeNull();
    expect(call(p, 'resolveId', 'react', '/src/main.tsx')).toBeNull();

    const code = call(p, 'load', vq) as string;
    expect(code).toContain(`export * from "${QUERY_MODULE}"`);
    expect(code).toContain('export class QueryClient extends');
    expect(code).toContain('window.__TANSTACK_QUERY_CLIENT__ = this');
    const vr = call(p, 'resolveId', ROUTER_MODULE, '/src/main.tsx') as string;
    expect(call(p, 'load', vr) as string).toContain('window.__TANSTACK_ROUTER__ = router');
  });

  it('can be limited to one library and stays inert for packages that are not installed', () => {
    const p = devtoolsMcp({ router: false });
    call(p, 'config', { root: `${process.cwd()}/../demo-app` }, { command: 'serve', mode: 'development' });
    expect(call(p, 'resolveId', ROUTER_MODULE, '/src/main.tsx')).toBeNull();
    expect(call(p, 'resolveId', QUERY_MODULE, '/src/main.tsx')).not.toBeNull();

    const none = devtoolsMcp();
    expect(call(none, 'config', { root: '/definitely/not/a/project' }, { command: 'serve', mode: 'development' })).toBeUndefined();
    expect(call(none, 'resolveId', QUERY_MODULE, '/src/main.tsx')).toBeNull();
  });
});
