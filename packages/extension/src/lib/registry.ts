/**
 * Page-side tool registry (MAIN world). Single source of truth for the tools available on this
 * document; exposed to (a) the relay via the ISOLATED bridge, (b) document.modelContext (WebMCP),
 * (c) chrome-devtools-mcp's `devtoolstooldiscovery` event.
 */
import {
  DevtoolsError,
  capabilityHint,
  encode,
  toDescriptor,
  type Capability,
  type ToolDefinition,
  type ToolDescriptor,
  type Enc,
} from '@devtools-mcp/protocol';

export interface RegistrySnapshot {
  gen: number;
  capabilities: Capability[];
  tools: ToolDescriptor[];
}

const MAX_RESULT_BYTES = 2 * 1024 * 1024;

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition<unknown, unknown>>();
  private capabilities = new Set<Capability>(['page']);
  private gen = 0;
  private listeners = new Set<(s: RegistrySnapshot) => void>();

  add(...defs: ToolDefinition<unknown, unknown>[]): void {
    for (const d of defs) this.tools.set(d.name, d);
    this.bump();
  }

  setCapability(cap: Capability, present: boolean): void {
    const had = this.capabilities.has(cap);
    if (had === present) return;
    if (present) this.capabilities.add(cap);
    else this.capabilities.delete(cap);
    this.bump();
  }

  hasCapability(cap: Capability): boolean {
    return this.capabilities.has(cap);
  }

  get(name: string): ToolDefinition<unknown, unknown> | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition<unknown, unknown>[] {
    return [...this.tools.values()];
  }

  snapshot(): RegistrySnapshot {
    return {
      gen: this.gen,
      capabilities: [...this.capabilities],
      tools: this.list().map(toDescriptor),
    };
  }

  onChange(l: (s: RegistrySnapshot) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private bump(): void {
    this.gen++;
    const s = this.snapshot();
    for (const l of this.listeners) l(s);
  }

  /**
   * Execute a tool by name. Throws DevtoolsError for unknown tools / missing capability;
   * wraps implementation errors as PAGE_ERROR. The result is encoded for transport.
   */
  async execute(
    name: string,
    input: unknown,
    opts: { signal: AbortSignal; progress?: (u: { progress?: number; total?: number; message?: string; data?: unknown }) => void },
  ): Promise<{ result: Enc; truncated: boolean }> {
    const tool = this.tools.get(name);
    if (!tool) throw new DevtoolsError('TOOL_NOT_FOUND', `Unknown tool "${name}"`);
    if (!this.capabilities.has(tool.capability)) {
      throw new DevtoolsError('CAPABILITY_UNAVAILABLE', `Capability "${tool.capability}" is not present on this page`, {
        hint: capabilityHint(tool.capability),
        data: { capability: tool.capability, present: [...this.capabilities] },
      });
    }
    let raw: unknown;
    try {
      raw = await tool.execute(input ?? {}, opts);
    } catch (e) {
      throw DevtoolsError.from(e);
    }
    // Tools already encode page values (props, data…) with `encode()`; their results must be JSON-safe.
    // Pass them through untouched — re-encoding would mangle nested stubs. Fall back to a tagged
    // encoding only if the result is not JSON-serialisable (defensive: a tool forgot to encode).
    let json: string;
    try {
      json = JSON.stringify(raw) ?? 'null';
    } catch {
      const enc = encode(raw, { depth: 8, maxKeys: 500, maxString: 2000, maxBytes: 512 * 1024 });
      return { result: enc.value, truncated: true };
    }
    if (json.length > MAX_RESULT_BYTES) {
      throw new DevtoolsError('PAYLOAD_TOO_LARGE', `Tool result is ${(json.length / 1024).toFixed(0)} KB (limit ${MAX_RESULT_BYTES / 1024} KB)`, {
        hint: 'Use pagination (maxNodes/limit/cursor), a tighter `budget`, or `expand` specific paths instead.',
      });
    }
    return { result: JSON.parse(json) as Enc, truncated: false };
  }
}
