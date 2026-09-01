import { z } from 'zod';
import { ERROR_CODES } from './errors.js';
import { CapabilitySchema, ToolDescriptorSchema } from './tool.js';

export const PROTOCOL_VERSION = 1 as const;

export const TabHandleSchema = z.string().regex(/^t\d+$/);
export type TabHandle = `t${number}`;

export const DocIdSchema = z.string().min(8).max(64);
export type DocId = string;

export const ToolErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  hint: z.string().optional(),
  data: z.unknown().optional(),
  retryable: z.boolean(),
});

export const TabInfoSchema = z.object({
  tab: TabHandleSchema,
  doc: DocIdSchema,
  url: z.string(),
  title: z.string(),
  active: z.boolean(),
  windowId: z.number().int(),
  capabilities: z.array(CapabilitySchema),
  mutationsAllowed: z.boolean(),
  state: z.enum(['attached', 'frozen']),
  registryGen: z.number().int().nonnegative(),
});
export type TabInfo = z.infer<typeof TabInfoSchema>;

const base = { v: z.literal(PROTOCOL_VERSION), id: z.string().min(1), ts: z.number() };

const tabDoc = { tab: TabHandleSchema, doc: DocIdSchema };

export const FrameSchema = z.discriminatedUnion('t', [
  // ---- handshake ----
  z.object({
    ...base,
    t: z.literal('hello'),
    role: z.enum(['extension', 'page']),
    token: z.string().optional(),
    extVersion: z.string(),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    resumeId: z.string().optional(),
  }),
  z.object({
    ...base,
    t: z.literal('hello_ack'),
    relayVersion: z.string(),
    serverTime: z.number(),
    heartbeatMs: z.number().int().positive(),
    maxFrameBytes: z.number().int().positive(),
  }),
  z.object({
    ...base,
    t: z.literal('hello_reject'),
    code: z.enum(['UNAUTHORIZED', 'VERSION_MISMATCH']),
    message: z.string(),
  }),
  // ---- tab lifecycle ----
  z.object({
    ...base,
    t: z.literal('tab.attached'),
    ...tabDoc,
    url: z.string(),
    title: z.string(),
    mutationsAllowed: z.boolean(),
  }),
  z.object({
    ...base,
    t: z.literal('tab.navigated'),
    ...tabDoc,
    prevDoc: DocIdSchema,
    url: z.string(),
    title: z.string(),
  }),
  z.object({ ...base, t: z.literal('tab.frozen'), ...tabDoc }),
  z.object({ ...base, t: z.literal('tab.resumed'), ...tabDoc }),
  z.object({
    ...base,
    t: z.literal('tab.detached'),
    ...tabDoc,
    reason: z.enum(['closed', 'unload', 'port_lost', 'sw_restart', 'standby']),
  }),
  z.object({ ...base, t: z.literal('tabs.snapshot'), tabs: z.array(TabInfoSchema) }),
  // relay → extension: open a new tab (allowlisted origins only)
  z.object({ ...base, t: z.literal('tab.open'), requestId: z.string(), url: z.string().url() }),
  z.object({
    ...base,
    t: z.literal('tab.open_result'),
    requestId: z.string(),
    tab: TabHandleSchema.optional(),
    error: ToolErrorSchema.optional(),
  }),
  // ---- CDP bridge (relay ⇄ SW) ----
  // A CDP client (Playwright) connects to the relay; the relay synthesises the Target domain and the service
  // worker owns the chrome.debugger sessions. Everything else is forwarded verbatim, child sessions included.
  z.object({
    ...base,
    t: z.literal('cdp.request'),
    requestId: z.string(),
    op: z.enum(['attach', 'detach', 'create', 'close', 'activate', 'version']),
    tab: TabHandleSchema.optional(),
    /** `create` only: initial URL (allowlisted origins or about:blank). */
    url: z.string().optional(),
  }),
  z.object({
    ...base,
    t: z.literal('cdp.response'),
    requestId: z.string(),
    tab: TabHandleSchema.optional(),
    /** CDP `TargetInfo` of the tab (from `Target.getTargetInfo`) for attach/create. */
    targetInfo: z.record(z.string(), z.unknown()).optional(),
    /** `version` only. */
    userAgent: z.string().optional(),
    error: ToolErrorSchema.optional(),
  }),
  z.object({
    ...base,
    t: z.literal('cdp.command'),
    cmdId: z.number().int(),
    tab: TabHandleSchema,
    /** Child session (OOPIF / worker) within the tab's root debugger session. */
    sessionId: z.string().optional(),
    method: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    ...base,
    t: z.literal('cdp.result'),
    cmdId: z.number().int(),
    result: z.unknown().optional(),
    error: z.object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() }).optional(),
  }),
  z.object({ ...base, t: z.literal('cdp.event'), tab: TabHandleSchema, sessionId: z.string().optional(), method: z.string(), params: z.unknown().optional() }),
  /** Chrome ended the debugger session (tab closed, DevTools opened, user cancelled). */
  z.object({ ...base, t: z.literal('cdp.detached'), tab: TabHandleSchema, reason: z.string() }),
  // ---- registry ----
  z.object({
    ...base,
    t: z.literal('registry.snapshot'),
    ...tabDoc,
    gen: z.number().int().nonnegative(),
    capabilities: z.array(CapabilitySchema),
    tools: z.array(ToolDescriptorSchema),
  }),
  z.object({
    ...base,
    t: z.literal('registry.diff'),
    ...tabDoc,
    gen: z.number().int().positive(),
    capabilities: z.array(CapabilitySchema),
    added: z.array(ToolDescriptorSchema),
    removed: z.array(z.string()),
  }),
  z.object({ ...base, t: z.literal('registry.request_snapshot'), tab: TabHandleSchema }),
  // ---- invoke ----
  z.object({
    ...base,
    t: z.literal('invoke'),
    callId: z.string().min(1),
    tab: TabHandleSchema,
    doc: DocIdSchema.optional(),
    tool: z.string(),
    input: z.unknown(),
    deadlineAt: z.number(),
    progressToken: z.string().optional(),
  }),
  z.object({
    ...base,
    t: z.literal('invoke.progress'),
    callId: z.string(),
    seq: z.number().int().nonnegative(),
    progress: z.number().optional(),
    total: z.number().optional(),
    message: z.string().optional(),
    data: z.unknown().optional(),
  }),
  z.object({
    ...base,
    t: z.literal('invoke.result'),
    callId: z.string(),
    doc: DocIdSchema,
    result: z.unknown(),
    truncated: z.boolean().optional(),
  }),
  z.object({ ...base, t: z.literal('invoke.error'), callId: z.string(), error: ToolErrorSchema }),
  z.object({
    ...base,
    t: z.literal('invoke.cancel'),
    callId: z.string(),
    tab: TabHandleSchema,
    reason: z.enum(['client', 'timeout', 'tab_gone']),
  }),
  // ---- liveness ----
  z.object({ ...base, t: z.literal('ping'), n: z.number().int() }),
  z.object({ ...base, t: z.literal('pong'), n: z.number().int() }),
]);

export type Frame = z.infer<typeof FrameSchema>;
export type FrameType = Frame['t'];
export type FrameOf<T extends FrameType> = Extract<Frame, { t: T }>;

/** Payload of a frame without the envelope fields (`v`, `id`, `ts`). */
export type FrameBody<T extends FrameType = FrameType> = Omit<FrameOf<T>, 'v' | 'id' | 'ts'>;

let counter = 0;
export function frameId(): string {
  counter = (counter + 1) % 0xffffff;
  const rand = Math.floor(Math.random() * 0xffffff).toString(36);
  return `${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

/** Build a frame with the envelope filled in. */
export function makeFrame<T extends FrameType>(body: { t: T } & FrameBody<T>): FrameOf<T> {
  return { v: PROTOCOL_VERSION, id: frameId(), ts: Date.now(), ...body } as unknown as FrameOf<T>;
}

export function parseFrame(raw: unknown): Frame | null {
  const parsed = FrameSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Marker used for the MAIN⇄ISOLATED window.postMessage handshake (before the MessageChannel exists). */
export const HANDSHAKE_KEY = '__dtmcp' as const;
export const HandshakeSchema = z.union([
  z.object({ [HANDSHAKE_KEY]: z.literal('ready'), doc: DocIdSchema }),
  z.object({ [HANDSHAKE_KEY]: z.literal('hs'), nonce: z.string().min(16) }),
]);
export type Handshake = z.infer<typeof HandshakeSchema>;

export const DEFAULTS = {
  relayPort: 9333,
  heartbeatMs: 20_000,
  heartbeatTimeoutMs: 10_000,
  maxFrameBytes: 10 * 1024 * 1024,
  invokeTimeoutMs: 60_000,
  longInvokeTimeoutMs: 5 * 60_000,
} as const;
