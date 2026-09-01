/**
 * Tagged, JSON-safe encoding of arbitrary page values with depth/size budgets.
 *
 * Design: "summary by default, expand by path". The encoder walks a value breadth-first, emitting
 * plain JSON where possible and `{ $: tag, ... }` stubs for non-JSON values or for subtrees beyond the
 * budget. Each collapsed stub carries its `path`, so a caller can re-encode that subtree on request
 * (`expandPaths`).
 */
export type Path = (string | number)[];

export interface EncodeBudget {
  /** Nesting depth before an object/array is collapsed to a stub. */
  depth: number;
  /** Max own keys / items emitted per object/array before truncation. */
  maxKeys: number;
  /** Strings longer than this are truncated to a `{ $:'string' }` stub. */
  maxString: number;
  /** Approximate serialized-bytes budget; encoding stops (marks `truncated`) when exceeded. */
  maxBytes: number;
}

export const DEFAULT_BUDGET: EncodeBudget = { depth: 2, maxKeys: 50, maxString: 200, maxBytes: 32 * 1024 };
export const HARD_MAX_BYTES = 8 * 1024 * 1024;

export type Enc =
  | null
  | boolean
  | number
  | string
  | Enc[]
  | { [k: string]: Enc }
  | Tagged;

export type Tagged =
  | { $: 'undefined' }
  | { $: 'nan' }
  | { $: 'inf'; s: 1 | -1 }
  | { $: 'bigint'; v: string }
  | { $: 'date'; iso: string }
  | { $: 'regexp'; src: string; flags: string }
  | { $: 'symbol'; d: string }
  | { $: 'fn'; name: string; arity: number }
  | { $: 'map'; size: number; entries: [Enc, Enc][]; truncated?: boolean }
  | { $: 'set'; size: number; values: Enc[]; truncated?: boolean }
  | { $: 'typed'; ctor: string; length: number; head: number[] }
  | { $: 'error'; name: string; message: string; stack?: string }
  | { $: 'promise' }
  | { $: 'react_element'; type: string; key: string | null; propsPreview: string }
  | { $: 'dom'; tag: string; selector: string; elementId?: number }
  | { $: 'fiber'; elementId: number; name: string }
  | { $: 'cycle'; path: Path }
  | { $: 'object'; ctor: string; size: number; preview: string; path: Path }
  | { $: 'array'; length: number; preview: string; path: Path }
  | { $: 'string'; length: number; head: string };

export interface EncodeResult {
  value: Enc;
  truncated: boolean;
  /** Approximate serialized bytes. */
  bytes: number;
}

/** Structural stand-in for DOM Element so this module compiles without the DOM lib (relay/Node). */
export interface ElementLike {
  nodeType: number;
  nodeName: string;
  tagName?: string;
  id?: string;
  parentElement?: ElementLike | null;
  children?: ArrayLike<ElementLike>;
  getAttribute?: (name: string) => string | null;
}

export interface EncodeHooks {
  /** Return a stub for host-specific objects (DOM nodes, fibers, React elements) or undefined to fall through. */
  special?: (value: object, path: Path) => Tagged | undefined;
  /** Optional selector generator for DOM nodes when `special` is not supplied. */
  domSelector?: (el: ElementLike) => string;
}

function ctorName(value: object): string {
  const proto = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null;
  const name = proto?.constructor?.name;
  return typeof name === 'string' && name.length > 0 ? name : 'Object';
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function preview(value: unknown, max = 80): string {
  let s: string;
  try {
    if (value === null) s = 'null';
    else if (value === undefined) s = 'undefined';
    else if (typeof value === 'string') s = JSON.stringify(value);
    else if (typeof value === 'function') s = `ƒ ${value.name || 'anonymous'}()`;
    else if (typeof value === 'bigint') s = `${value}n`;
    else if (typeof value === 'symbol') s = value.toString();
    else if (typeof value !== 'object') s = String(value);
    else if (Array.isArray(value)) {
      s = `[${value.slice(0, 5).map((v) => preview(v, 16)).join(', ')}${value.length > 5 ? ', …' : ''}]`;
    } else if (value instanceof Date) s = value.toISOString();
    else if (value instanceof Map) s = `Map(${value.size})`;
    else if (value instanceof Set) s = `Set(${value.size})`;
    else if (isDomNode(value)) s = `<${value.tagName?.toLowerCase() ?? 'node'}>`;
    else {
      const keys = Object.keys(value as object);
      const ctor = isPlainObject(value as object) ? '' : `${ctorName(value as object)} `;
      s = `${ctor}{${keys
        .slice(0, 4)
        .map((k) => `${k}: ${preview((value as Record<string, unknown>)[k], 12)}`)
        .join(', ')}${keys.length > 4 ? ', …' : ''}}`;
    }
  } catch {
    s = '[unprintable]';
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function isDomNode(value: unknown): value is ElementLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ElementLike).nodeType === 'number' &&
    typeof (value as ElementLike).nodeName === 'string'
  );
}

function isReactElement(value: object): value is { type: unknown; key: string | null; props: Record<string, unknown> } {
  const t = (value as { $$typeof?: unknown }).$$typeof;
  return typeof t === 'symbol' && String(t).startsWith('Symbol(react.');
}

function reactTypeName(type: unknown): string {
  if (typeof type === 'string') return type;
  if (typeof type === 'function') return (type as { displayName?: string; name?: string }).displayName ?? type.name ?? 'Anonymous';
  if (typeof type === 'object' && type !== null) {
    const t = type as { displayName?: string; type?: unknown; render?: unknown };
    if (t.displayName) return t.displayName;
    if (t.render) return reactTypeName(t.render);
    if (t.type) return reactTypeName(t.type);
  }
  return 'Unknown';
}

export function defaultDomSelector(el: ElementLike): string {
  if (el.id) return `#${cssEscape(el.id)}`;
  const testId = el.getAttribute?.('data-testid');
  if (testId) return `[data-testid="${testId.replace(/"/g, '\\"')}"]`;
  const parts: string[] = [];
  let node: ElementLike | null | undefined = el;
  while (node && node.nodeType === 1 && parts.length < 8) {
    const tag = (node.tagName ?? node.nodeName).toLowerCase();
    if (node.id) {
      parts.unshift(`#${cssEscape(node.id)}`);
      break;
    }
    const parent: ElementLike | null | undefined = node.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const current: ElementLike = node;
    const siblings = Array.from(parent.children ?? []).filter((c) => c.tagName === current.tagName);
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(current) + 1})` : tag);
    node = parent;
  }
  return parts.join(' > ');
}

function cssEscape(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

/**
 * Encode `value` within `budget`. `rootPath` is prefixed onto emitted stub paths so that
 * `expandPaths` results carry absolute paths.
 */
export function encode(
  value: unknown,
  budget: Partial<EncodeBudget> = {},
  hooks: EncodeHooks = {},
  rootPath: Path = [],
): EncodeResult {
  const b: EncodeBudget = { ...DEFAULT_BUDGET, ...budget };
  b.maxBytes = Math.min(b.maxBytes, HARD_MAX_BYTES);
  const seen = new Map<object, Path>();
  let bytes = 0;
  let truncated = false;

  const charge = (n: number): boolean => {
    bytes += n;
    if (bytes > b.maxBytes) {
      truncated = true;
      return false;
    }
    return true;
  };

  const stubFor = (v: object, path: Path): Tagged => {
    if (Array.isArray(v)) return { $: 'array', length: v.length, preview: preview(v), path };
    const size = v instanceof Map || v instanceof Set ? v.size : Object.keys(v).length;
    return { $: 'object', ctor: ctorName(v), size, preview: preview(v), path };
  };

  const walk = (v: unknown, depth: number, path: Path): Enc => {
    // primitives
    if (v === null) return null;
    switch (typeof v) {
      case 'boolean':
        charge(5);
        return v;
      case 'number':
        charge(8);
        if (Number.isNaN(v)) return { $: 'nan' };
        if (v === Infinity) return { $: 'inf', s: 1 };
        if (v === -Infinity) return { $: 'inf', s: -1 };
        return v;
      case 'string':
        if (v.length > b.maxString) {
          charge(b.maxString + 24);
          return { $: 'string', length: v.length, head: v.slice(0, b.maxString) };
        }
        charge(v.length + 2);
        return v;
      case 'undefined':
        charge(16);
        return { $: 'undefined' };
      case 'bigint':
        charge(24);
        return { $: 'bigint', v: v.toString() };
      case 'symbol':
        charge(24);
        return { $: 'symbol', d: v.description ?? '' };
      case 'function':
        charge(32);
        return { $: 'fn', name: v.name || 'anonymous', arity: v.length };
      default:
        break;
    }
    const obj = v as object;

    // cycles
    const prior = seen.get(obj);
    if (prior) {
      charge(24);
      return { $: 'cycle', path: prior };
    }

    // host-specific
    const special = hooks.special?.(obj, path);
    if (special) {
      charge(64);
      return special;
    }
    if (isDomNode(obj)) {
      charge(64);
      return {
        $: 'dom',
        tag: (obj.tagName ?? obj.nodeName).toLowerCase(),
        selector: obj.nodeType === 1 ? (hooks.domSelector ?? defaultDomSelector)(obj) : obj.nodeName,
      };
    }
    if (isReactElement(obj)) {
      charge(80);
      return { $: 'react_element', type: reactTypeName(obj.type), key: obj.key ?? null, propsPreview: preview(obj.props) };
    }
    if (obj instanceof Date) {
      charge(40);
      return { $: 'date', iso: Number.isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString() };
    }
    if (obj instanceof RegExp) {
      charge(40);
      return { $: 'regexp', src: obj.source, flags: obj.flags };
    }
    if (obj instanceof Error) {
      charge(120);
      const out: Tagged = { $: 'error', name: obj.name, message: obj.message };
      if (typeof obj.stack === 'string') out.stack = obj.stack.split('\n').slice(0, 5).join('\n');
      return out;
    }
    if (typeof Promise !== 'undefined' && obj instanceof Promise) {
      charge(16);
      return { $: 'promise' };
    }
    if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
      const ta = obj as unknown as ArrayLike<number> & { length: number };
      charge(64);
      return { $: 'typed', ctor: ctorName(obj), length: ta.length, head: Array.from({ length: Math.min(8, ta.length) }, (_, i) => ta[i] as number) };
    }

    // containers — depth check
    if (depth >= b.depth) {
      charge(96);
      return stubFor(obj, path);
    }
    seen.set(obj, path);

    if (obj instanceof Map) {
      const entries: [Enc, Enc][] = [];
      let i = 0;
      let cut = false;
      for (const [k, val] of obj) {
        if (i >= b.maxKeys || truncated) {
          cut = true;
          break;
        }
        entries.push([walk(k, depth + 1, [...path, i, 0]), walk(val, depth + 1, [...path, i, 1])]);
        i++;
      }
      const out: Tagged = { $: 'map', size: obj.size, entries };
      if (cut) out.truncated = true;
      return out;
    }
    if (obj instanceof Set) {
      const values: Enc[] = [];
      let i = 0;
      let cut = false;
      for (const val of obj) {
        if (i >= b.maxKeys || truncated) {
          cut = true;
          break;
        }
        values.push(walk(val, depth + 1, [...path, i]));
        i++;
      }
      const out: Tagged = { $: 'set', size: obj.size, values };
      if (cut) out.truncated = true;
      return out;
    }
    if (Array.isArray(obj)) {
      const out: Enc[] = [];
      const n = Math.min(obj.length, b.maxKeys);
      charge(2);
      for (let i = 0; i < n; i++) {
        if (truncated) break;
        out.push(walk(obj[i], depth + 1, [...path, i]));
      }
      if (obj.length > n) {
        out.push({ $: 'array', length: obj.length - n, preview: `…${obj.length - n} more`, path: [...path, n] });
      }
      return out;
    }

    // generic object (plain or class instance) — enumerable own string keys
    const out: { [k: string]: Enc } = {};
    const keys = Object.keys(obj);
    if (!isPlainObject(obj)) {
      out.$ctor = ctorName(obj);
      charge(16);
    }
    const n = Math.min(keys.length, b.maxKeys);
    for (let i = 0; i < n; i++) {
      if (truncated) break;
      const k = keys[i] as string;
      charge(k.length + 3);
      let val: unknown;
      try {
        val = (obj as Record<string, unknown>)[k];
      } catch (e) {
        val = e;
      }
      out[k] = walk(val, depth + 1, [...path, k]);
    }
    if (keys.length > n) {
      out.$more = { $: 'object', ctor: 'keys', size: keys.length - n, preview: `…${keys.length - n} more keys`, path };
    }
    return out;
  };

  const encoded = walk(value, 0, rootPath);
  return { value: encoded, truncated, bytes };
}

/** Resolve `path` inside `root` (Map/Set entries addressed by insertion index). */
export function getAtPath(root: unknown, path: Path): { found: boolean; value: unknown } {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || cur === undefined) return { found: false, value: undefined };
    if (cur instanceof Map) {
      const entries = Array.from(cur.entries());
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= entries.length) return { found: false, value: undefined };
      // Map paths are [index, 0|1]; if the next segment is missing return the entry tuple.
      cur = entries[idx];
      continue;
    }
    if (cur instanceof Set) {
      const values = Array.from(cur.values());
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= values.length) return { found: false, value: undefined };
      cur = values[idx];
      continue;
    }
    if (typeof cur !== 'object' && typeof cur !== 'function') return { found: false, value: undefined };
    if (!(seg in (cur as object))) return { found: false, value: undefined };
    try {
      cur = (cur as Record<string | number, unknown>)[seg];
    } catch (e) {
      cur = e;
    }
  }
  return { found: true, value: cur };
}

/** Encode several subtrees of `root`, each at fresh depth. Missing paths are reported. */
export function expandPaths(
  root: unknown,
  paths: Path[],
  budget: Partial<EncodeBudget> = {},
  hooks: EncodeHooks = {},
): { expanded: { path: Path; value: Enc }[]; missing: Path[]; truncated: boolean } {
  const expanded: { path: Path; value: Enc }[] = [];
  const missing: Path[] = [];
  let truncated = false;
  for (const path of paths) {
    const r = getAtPath(root, path);
    if (!r.found) {
      missing.push(path);
      continue;
    }
    const enc = encode(r.value, budget, hooks, path);
    truncated ||= enc.truncated;
    expanded.push({ path, value: enc.value });
  }
  return { expanded, missing, truncated };
}

/**
 * Decode an `Enc` value produced by an agent (tool inputs such as `set_data`) back into live values.
 * Plain JSON passes through; tagged stubs that represent real values are revived; opaque stubs
 * (`fn`, `dom`, `fiber`, `cycle`, `object`, `array`, `string`) throw.
 */
export function decode(value: Enc): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decode);
  const tagged = value as Tagged & { [k: string]: Enc };
  if (typeof tagged.$ !== 'string') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = decode(v as Enc);
    return out;
  }
  switch (tagged.$) {
    case 'undefined':
      return undefined;
    case 'nan':
      return NaN;
    case 'inf':
      return (tagged as { s: 1 | -1 }).s === 1 ? Infinity : -Infinity;
    case 'bigint':
      return BigInt((tagged as { v: string }).v);
    case 'date':
      return new Date((tagged as { iso: string }).iso);
    case 'regexp':
      return new RegExp((tagged as { src: string }).src, (tagged as { flags: string }).flags);
    case 'map':
      return new Map((tagged as { entries: [Enc, Enc][] }).entries.map(([k, v]) => [decode(k), decode(v)]));
    case 'set':
      return new Set((tagged as { values: Enc[] }).values.map(decode));
    case 'error': {
      const e = new Error((tagged as { message: string }).message);
      e.name = (tagged as { name: string }).name;
      return e;
    }
    default:
      throw new TypeError(`Cannot decode opaque value of type "${tagged.$}"`);
  }
}
