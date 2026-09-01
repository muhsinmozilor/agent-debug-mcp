/**
 * Ring buffer of runtime problems seen in a document — uncaught exceptions, console.error/warn, React error
 * boundaries, failed TanStack queries/mutations, router match errors. Pure data structure (no DOM): the page
 * packages feed it, `page_get_errors` reads it with a `since` sequence so an agent can ask "what broke since my
 * last check". Consecutive identical entries collapse into one with a `count`.
 */
export type PageErrorKind = 'exception' | 'unhandledrejection' | 'console.error' | 'console.warn' | 'react' | 'query' | 'mutation' | 'router';

export interface PageErrorEntry {
  /** Monotonic per document; pass the last one you saw as `since`. */
  seq: number;
  ts: number;
  kind: PageErrorKind;
  message: string;
  stack?: string;
  /** React component stack ("at Counter (…)" lines) when the error surfaced through React. */
  componentStack?: string;
  /** Where it came from: "console", "window", "query:<hash>", "mutation:<id>", "router:<routeId>". */
  source?: string;
  /** Small JSON-safe details (queryKey, routeId, url…). */
  data?: Record<string, string | number | boolean | null>;
  /** How many identical consecutive occurrences this entry stands for. */
  count: number;
  lastTs: number;
}

export type PageErrorInput = Omit<PageErrorEntry, 'seq' | 'count' | 'lastTs' | 'ts'> & { ts?: number };

export class ErrorLog {
  private entries: PageErrorEntry[] = [];
  private seq = 0;
  /** Entries evicted because the buffer was full. */
  private evicted = 0;
  private listeners = new Set<(e: PageErrorEntry) => void>();

  constructor(private readonly cap = 200) {}

  push(input: PageErrorInput): PageErrorEntry {
    const ts = input.ts ?? Date.now();
    const last = this.entries[this.entries.length - 1];
    if (last && last.kind === input.kind && last.message === input.message && last.source === input.source) {
      last.count++;
      last.lastTs = ts;
      return last;
    }
    const entry: PageErrorEntry = { ...input, ts, seq: ++this.seq, count: 1, lastTs: ts };
    this.entries.push(entry);
    if (this.entries.length > this.cap) {
      this.entries.splice(0, this.entries.length - this.cap);
      this.evicted++;
    }
    for (const l of this.listeners) l(entry);
    return entry;
  }

  /** Entries with seq > since (oldest first). */
  since(seq = 0): PageErrorEntry[] {
    return this.entries.filter((e) => e.seq > seq);
  }

  all(): PageErrorEntry[] {
    return [...this.entries];
  }

  get latestSeq(): number {
    return this.seq;
  }

  get size(): number {
    return this.entries.length;
  }

  get evictedCount(): number {
    return this.evicted;
  }

  clear(): void {
    this.entries = [];
  }

  onEntry(listener: (e: PageErrorEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Best-effort message + stack from anything that was thrown. */
export function describeThrown(value: unknown, maxLen = 2000): { message: string; stack?: string; name?: string } {
  if (value instanceof Error || (typeof value === 'object' && value !== null && 'message' in value && typeof (value as Error).message === 'string')) {
    const e = value as Error;
    const name = typeof e.name === 'string' && e.name !== 'Error' ? e.name : undefined;
    const message = `${name ? `${name}: ` : ''}${e.message}`.slice(0, maxLen);
    const stack = typeof e.stack === 'string' ? e.stack.slice(0, maxLen) : undefined;
    return stack ? { message, stack, name } : { message, name };
  }
  if (typeof value === 'string') return { message: value.slice(0, maxLen) };
  try {
    return { message: JSON.stringify(value)?.slice(0, maxLen) ?? String(value) };
  } catch {
    return { message: String(value).slice(0, maxLen) };
  }
}
