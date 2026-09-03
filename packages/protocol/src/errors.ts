export const ERROR_CODES = [
  'TAB_NOT_FOUND',
  'AMBIGUOUS_TAB',
  'TAB_FROZEN',
  'CAPABILITY_UNAVAILABLE',
  'TOOL_NOT_FOUND',
  'INVALID_INPUT',
  'STALE_ELEMENT',
  'STALE_CURSOR',
  'DOC_CHANGED',
  'MUTATIONS_DISABLED',
  'PROFILE_ALREADY_RUNNING',
  'TIMEOUT',
  'CANCELLED',
  'PAYLOAD_TOO_LARGE',
  'PAGE_ERROR',
  'EXTENSION_DISCONNECTED',
  'EXTENSION_RESTARTED',
  'UNAUTHORIZED',
  'VERSION_MISMATCH',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ToolError {
  code: ErrorCode;
  message: string;
  hint?: string;
  data?: unknown;
  retryable: boolean;
}

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'TIMEOUT',
  'EXTENSION_DISCONNECTED',
  'EXTENSION_RESTARTED',
  'TAB_FROZEN',
]);

/**
 * Error type thrown by tool implementations and relay plumbing. Serialises to a `ToolError`.
 */
export class AgentDebugError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly data: unknown;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: { hint?: string; data?: unknown; retryable?: boolean } = {}) {
    super(message);
    this.name = 'AgentDebugError';
    this.code = code;
    this.hint = options.hint;
    this.data = options.data;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
  }

  toJSON(): ToolError {
    const out: ToolError = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.hint !== undefined) out.hint = this.hint;
    if (this.data !== undefined) out.data = this.data;
    return out;
  }

  static from(err: unknown, fallback: ErrorCode = 'PAGE_ERROR'): AgentDebugError {
    if (err instanceof AgentDebugError) return err;
    if (isToolErrorLike(err)) {
      return new AgentDebugError(err.code, err.message, { hint: err.hint, data: err.data, retryable: err.retryable });
    }
    if (err instanceof Error) {
      if (err.name === 'AbortError') return new AgentDebugError('CANCELLED', 'Operation was cancelled');
      return new AgentDebugError(fallback, err.message);
    }
    return new AgentDebugError(fallback, typeof err === 'string' ? err : 'Unknown error');
  }
}

export function isToolErrorLike(value: unknown): value is ToolError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ToolError).code === 'string' &&
    (ERROR_CODES as readonly string[]).includes((value as ToolError).code) &&
    typeof (value as ToolError).message === 'string'
  );
}
