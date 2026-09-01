/**
 * Secondary exposure of the page registry:
 *  (1) WebMCP — `document.modelContext.registerTool(tool, { signal })` when Chrome ships/enables it;
 *  (2) chrome-devtools-mcp third-party developer tools — answer the `devtoolstooldiscovery` event.
 * Both are best-effort and never affect the relay path.
 */
import type { ToolDescriptor } from '@devtools-mcp/protocol';
import type { ToolRegistry } from './registry';

interface ModelContextLike {
  registerTool(tool: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown> | unknown;
  getTools?(): Promise<unknown[]>;
}

function parseInput(input: unknown): unknown {
  // Chrome's early WebMCP builds pass the JSON-stringified input object; later ones pass an object.
  if (typeof input === 'string') {
    try {
      return JSON.parse(input);
    } catch {
      return {};
    }
  }
  return input ?? {};
}

function toolsFor(registry: ToolRegistry, snapshotTools: ToolDescriptor[]) {
  return snapshotTools.map((d) => ({
    name: d.name,
    title: d.title ?? d.name,
    description: d.description,
    inputSchema: d.inputSchema,
    annotations: { readOnlyHint: !!d.annotations.readOnlyHint, untrustedContentHint: true },
    execute: async (input: unknown, options?: { signal?: AbortSignal }) => {
      const signal = options?.signal ?? new AbortController().signal;
      const { result, truncated } = await registry.execute(d.name, parseInput(input), { signal });
      const payload = truncated ? { truncated: true, result } : { result };
      // MCP-style content (what the WebMCP explainer and chrome-devtools-mcp expect).
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    },
  }));
}

/** Register (and keep re-registering on change) the registry into WebMCP if available. */
export function exposeWebMcp(registry: ToolRegistry): { supported: boolean } {
  const mc = (document as unknown as { modelContext?: ModelContextLike }).modelContext;
  if (!mc || typeof mc.registerTool !== 'function') return { supported: false };
  let controller: AbortController | null = null;
  const register = (): void => {
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    const tools = toolsFor(registry, registry.snapshot().tools).filter((t) => registry.hasCapability(registry.get(t.name)!.capability));
    for (const t of tools) {
      try {
        void Promise.resolve(mc.registerTool(t, { signal })).catch(() => undefined);
      } catch {
        /* ignore individual failures */
      }
    }
  };
  register();
  registry.onChange(register);
  window.addEventListener('pagehide', () => controller?.abort(), { once: true });
  return { supported: true };
}

/** Answer chrome-devtools-mcp's `devtoolstooldiscovery` with our tool group. */
export function exposeThirdPartyDevtools(registry: ToolRegistry): void {
  window.addEventListener('devtoolstooldiscovery', (event: Event) => {
    const e = event as Event & { respondWith?: (group: unknown) => void };
    if (typeof e.respondWith !== 'function') return;
    const tools = toolsFor(registry, registry.snapshot().tools)
      .filter((t) => registry.hasCapability(registry.get(t.name)!.capability))
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        // 3p developer tools return plain values (chrome-devtools-mcp serialises them itself).
        execute: async (input: unknown) => {
          const { result } = await registry.execute(t.name, parseInput(input), { signal: new AbortController().signal });
          return result;
        },
      }));
    e.respondWith({
      name: 'Agent Debug MCP',
      description: 'React DevTools + TanStack Query/Router runtime state of this page (component tree, props/state/hooks, profiling, query cache, router state).',
      tools,
    });
  });
}
