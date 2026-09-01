import { z } from 'zod';

export const CAPABILITIES = ['page', 'react', 'tanstack_query', 'tanstack_router'] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const CapabilitySchema = z.enum(CAPABILITIES);

/** JSON Schema (draft 2020-12 subset) used for tool input schemas. Kept loose on purpose. */
export type JsonSchema = Record<string, unknown>;

/** WebMCP `ToolAnnotations` plus MCP's `openWorldHint`. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolExecuteOptions {
  signal: AbortSignal;
  /** Report progress for long-running tools. Forwarded as MCP `notifications/progress`. */
  progress?: (update: { progress?: number; total?: number; message?: string; data?: unknown }) => void;
}

/**
 * The single source of truth for a tool. Shape follows the WebMCP `ModelContextTool` dictionary
 * (`name`, `title`, `description`, `inputSchema`, `execute`, `annotations`) plus Agent Debug MCP metadata
 * that the relay uses for routing and gating.
 */
export interface ToolDefinition<Input = unknown, Output = unknown> {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ToolAnnotations;
  /** Which page capability must be present on the tab for this tool to run. */
  capability: Capability;
  /** True when the tool changes page state; gated by the per-origin mutation toggle. */
  mutation: boolean;
  /** Relay-side deadline. Defaults to 60 s; long-running tools override. */
  timeoutMs?: number;
  execute: (input: Input, options: ToolExecuteOptions) => Promise<Output> | Output;
}

/** Serialisable subset of a ToolDefinition — what travels in `registry.snapshot`. */
export const ToolDescriptorSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
  title: z.string().optional(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: z
    .object({
      readOnlyHint: z.boolean().optional(),
      untrustedContentHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    })
    .default({}),
  capability: CapabilitySchema,
  mutation: z.boolean(),
  timeoutMs: z.number().int().positive().optional(),
  schemaHash: z.string(),
});
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;

/** Deterministic JSON stringify (sorted keys) so hashes match across realms. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

/** FNV-1a 32-bit over the stable JSON of a schema — cheap, sync, identical in page and Node. */
export function hashSchema(schema: JsonSchema): string {
  const s = stableStringify(schema);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function toDescriptor(def: ToolDefinition<unknown, unknown>): ToolDescriptor {
  const d: ToolDescriptor = {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    annotations: def.annotations,
    capability: def.capability,
    mutation: def.mutation,
    schemaHash: hashSchema(def.inputSchema),
  };
  if (def.title !== undefined) d.title = def.title;
  if (def.timeoutMs !== undefined) d.timeoutMs = def.timeoutMs;
  return d;
}

/** Helper for authoring tools with typed input without repeating the generic dance. */
export function defineTool<Input, Output>(def: ToolDefinition<Input, Output>): ToolDefinition<Input, Output> {
  return def;
}

/** A ToolDefinition minus `execute` — the pure metadata authored in each tools package's descriptors.ts. */
export type ToolMeta = Omit<ToolDefinition, 'execute'> & { title: string };

/** Shared JSON Schema fragment for the per-call serialisation `budget` input. */
export const budgetSchema: JsonSchema = {
  type: 'object',
  description: 'Override the serialisation budget for this call.',
  properties: {
    depth: { type: 'integer', minimum: 0, maximum: 8, description: 'Nesting depth before collapsing (default 2)' },
    maxKeys: { type: 'integer', minimum: 1, maximum: 500, description: 'Max keys/items per object (default 50)' },
    maxString: { type: 'integer', minimum: 16, maximum: 20000, description: 'Max string length (default 200)' },
    maxBytes: { type: 'integer', minimum: 1024, maximum: 8388608, description: 'Approximate byte budget (default 32768)' },
  },
  additionalProperties: false,
};

/** Shared JSON Schema fragment for `expand` paths into an encoded value. */
export const pathSchema: JsonSchema = {
  type: 'array',
  items: { type: ['string', 'integer'] },
  description: 'Path into the inspected value, e.g. ["data","items",0,"id"].',
};

/** Actionable hint for a missing page capability — shared wording for the page registry and the relay. */
export function capabilityHint(cap: Capability | string): string {
  switch (cap) {
    case 'react':
      return 'No React renderer registered on this tab. Make sure it is a React app in development mode and reload the tab (the DevTools hook must exist before React loads).';
    case 'tanstack_query':
      return 'Expose the QueryClient in the app entry: `if (import.meta.env.DEV) window.__TANSTACK_QUERY_CLIENT__ = queryClient`.';
    case 'tanstack_router':
      return 'Expose the router in the app entry: `if (import.meta.env.DEV) window.__TANSTACK_ROUTER__ = router`.';
    default:
      return 'Capability not available on this tab.';
  }
}
