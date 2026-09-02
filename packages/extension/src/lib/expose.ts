/**
 * Secondary exposure of the page registry: chrome-devtools-mcp third-party developer tools —
 * answer the `devtoolstooldiscovery` event. Best-effort and never affects the relay path.
 */
import type { ToolRegistry } from './registry';

function parseInput(input: unknown): unknown {
  // Some hosts pass the JSON-stringified input object; others pass an object.
  if (typeof input === 'string') {
    try {
      return JSON.parse(input);
    } catch {
      return {};
    }
  }
  return input ?? {};
}

/** Answer chrome-devtools-mcp's `devtoolstooldiscovery` with our tool group. */
export function exposeThirdPartyDevtools(registry: ToolRegistry): void {
  window.addEventListener('devtoolstooldiscovery', (event: Event) => {
    const e = event as Event & { respondWith?: (group: unknown) => void };
    if (typeof e.respondWith !== 'function') return;
    const tools = registry
      .snapshot()
      .tools.filter((d) => registry.hasCapability(registry.get(d.name)!.capability))
      .map((d) => ({
        name: d.name,
        description: d.description,
        inputSchema: d.inputSchema,
        // 3p developer tools return plain values (chrome-devtools-mcp serialises them itself).
        execute: async (input: unknown) => {
          const { result } = await registry.execute(d.name, parseInput(input), { signal: new AbortController().signal });
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
