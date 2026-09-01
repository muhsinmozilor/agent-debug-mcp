/**
 * Runtime error capture for `page_get_errors`. Installed at document_start (before the app's code) so the
 * console/window hooks see everything React and the app log. Nothing is swallowed: the original console
 * methods still run and the events keep propagating.
 */
import { describeThrown, preview, type ErrorLog, type PageErrorKind } from '@devtools-mcp/protocol';
import { isCompositeFiber, type Fiber } from 'bippy';
import { getReactHookState } from './hook.js';
import { nameOf } from './naming.js';

const MAX_MESSAGE = 2000;
/** React 18/19 component stacks: "\n    at Counter (http://…)" or (older) "\n    in Counter (at App.tsx:12)". */
const COMPONENT_STACK_RE = /(?:^|\n)\s+(?:at|in) [A-Za-z_$][\w$.]*(?: \(| \n|$)/;
const REACT_BOUNDARY_RE = /error occurred in the <|The above error occurred|React will try to recreate|error boundary/i;

export interface ErrorCaptureOptions {
  target?: Window & typeof globalThis;
  /** Also record console.warn (default true). */
  warnings?: boolean;
}

/** Turn console arguments into one line, resolving %s/%o/%d style placeholders in the first argument. */
export function formatConsoleArgs(args: unknown[]): { message: string; error?: Error; componentStack?: string } {
  let error: Error | undefined;
  let componentStack: string | undefined;
  const parts: string[] = [];
  const rest = [...args];
  const first = rest[0];
  if (typeof first === 'string' && /%[sdifoOc]/.test(first)) {
    rest.shift();
    parts.push(
      first.replace(/%[sdifoOc]/g, (m) => {
        if (m === '%c') {
          rest.shift();
          return '';
        }
        const v = rest.shift();
        return stringify(v);
      }),
    );
  }
  for (const a of rest) {
    if (a instanceof Error) error ??= a;
    if (typeof a === 'string' && COMPONENT_STACK_RE.test(a) && !componentStack) {
      componentStack = a.trim().slice(0, MAX_MESSAGE);
      continue;
    }
    parts.push(stringify(a));
  }
  const message = parts
    .filter((p) => p.length)
    .join(' ')
    .replace(/\s+\n/g, '\n')
    .trim()
    .slice(0, MAX_MESSAGE);
  return { message: message || (error ? describeThrown(error).message : ''), error, componentStack };
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return `${v.name || 'Error'}: ${v.message}`;
  if (v === undefined) return 'undefined';
  if (v === null || typeof v !== 'object') return String(v);
  return preview(v, 200);
}

/**
 * Component stack of the fiber React is currently rendering/committing, if any. React (dev) logs caught errors and
 * warnings from inside `runWithFiberInDEV`, so the renderer's `getCurrentFiber()` points at the culprit while our
 * console patch runs — the same trick React DevTools uses to append component stacks.
 */
function currentComponentStack(): string | undefined {
  const s = getReactHookState();
  if (!s) return undefined;
  for (const rec of s.renderers.values()) {
    const get = (rec.renderer as unknown as { getCurrentFiber?: () => Fiber | null }).getCurrentFiber;
    if (typeof get !== 'function') continue;
    let fiber: Fiber | null = null;
    try {
      fiber = get();
    } catch {
      continue;
    }
    if (!fiber) continue;
    const names: string[] = [];
    for (let f: Fiber | null = fiber; f && names.length < 30; f = f.return) if (isCompositeFiber(f)) names.push(nameOf(f));
    if (names.length) return names.map((n) => `    at ${n}`).join('\n');
  }
  return undefined;
}

/** Patch console.error/warn and listen for window errors; returns an uninstall function. */
export function installErrorCapture(log: ErrorLog, opts: ErrorCaptureOptions = {}): () => void {
  const target = opts.target ?? (globalThis as Window & typeof globalThis);
  const con = target.console;
  const originals = { error: con.error, warn: con.warn };

  const record = (kind: 'console.error' | 'console.warn', args: unknown[]): void => {
    try {
      const formatted = formatConsoleArgs(args);
      const { message, error } = formatted;
      if (!message) return;
      const componentStack = formatted.componentStack ?? currentComponentStack();
      const react = componentStack !== undefined || REACT_BOUNDARY_RE.test(message);
      const k: PageErrorKind = react && kind === 'console.error' ? 'react' : kind;
      const entry: Parameters<ErrorLog['push']>[0] = { kind: k, message, source: 'console' };
      const thrown = error ? describeThrown(error) : null;
      if (thrown?.stack) entry.stack = thrown.stack;
      if (componentStack) entry.componentStack = componentStack;
      log.push(entry);
    } catch {
      /* never break the page's logging */
    }
  };

  con.error = function (this: unknown, ...args: unknown[]) {
    record('console.error', args);
    return originals.error.apply(this ?? con, args as []);
  } as typeof con.error;
  if (opts.warnings !== false) {
    con.warn = function (this: unknown, ...args: unknown[]) {
      record('console.warn', args);
      return originals.warn.apply(this ?? con, args as []);
    } as typeof con.warn;
  }

  const onError = (ev: ErrorEvent): void => {
    const thrown = ev.error !== undefined && ev.error !== null ? describeThrown(ev.error) : { message: ev.message || 'Script error' };
    const entry: Parameters<ErrorLog['push']>[0] = { kind: 'exception', message: thrown.message, source: 'window' };
    if (thrown.stack) entry.stack = thrown.stack;
    const where: Record<string, string | number> = {};
    if (ev.filename) where.file = ev.filename;
    if (ev.lineno) where.line = ev.lineno;
    if (ev.colno) where.column = ev.colno;
    if (Object.keys(where).length) entry.data = where;
    log.push(entry);
  };
  const onRejection = (ev: Event & { reason?: unknown }): void => {
    const thrown = describeThrown(ev.reason);
    const entry: Parameters<ErrorLog['push']>[0] = { kind: 'unhandledrejection', message: `Unhandled promise rejection: ${thrown.message}`, source: 'window' };
    if (thrown.stack) entry.stack = thrown.stack;
    log.push(entry);
  };
  target.addEventListener('error', onError as EventListener);
  target.addEventListener('unhandledrejection', onRejection as EventListener);

  return () => {
    if (con.error !== originals.error) con.error = originals.error;
    if (con.warn !== originals.warn) con.warn = originals.warn;
    target.removeEventListener('error', onError as EventListener);
    target.removeEventListener('unhandledrejection', onRejection as EventListener);
  };
}
