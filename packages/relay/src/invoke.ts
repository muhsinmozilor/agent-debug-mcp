import { AgentDebugError, type Frame, type ToolError } from '@devtools-mcp/protocol';

export interface ProgressUpdate {
  progress?: number;
  total?: number;
  message?: string;
  data?: unknown;
}

export interface PendingCall {
  callId: string;
  tab: string;
  tool: string;
  startedAt: number;
  deadlineAt: number;
  resolve: (v: { result: unknown; doc: string; truncated: boolean }) => void;
  reject: (e: AgentDebugError) => void;
  onProgress?: (u: ProgressUpdate) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Tracks in-flight invocations to the extension and matches results/errors/progress by callId. */
export class InvokeTracker {
  private pending = new Map<string, PendingCall>();
  private counter = 0;

  nextCallId(): string {
    this.counter = (this.counter + 1) % Number.MAX_SAFE_INTEGER;
    return `c${Date.now().toString(36)}-${this.counter.toString(36)}`;
  }

  track(call: Omit<PendingCall, 'timer'>, onTimeout: (call: PendingCall) => void): PendingCall {
    const timer = setTimeout(() => {
      const p = this.pending.get(call.callId);
      if (!p) return;
      this.pending.delete(call.callId);
      onTimeout(p);
      p.reject(
        new AgentDebugError('TIMEOUT', `Tool "${p.tool}" on ${p.tab} did not respond within ${Math.round((p.deadlineAt - p.startedAt) / 1000)} s`, {
          hint: 'The page may be busy or frozen. Retry, or check the tab is foregrounded.',
        }),
      );
    }, Math.max(0, call.deadlineAt - Date.now()));
    const full: PendingCall = { ...call, timer };
    this.pending.set(call.callId, full);
    return full;
  }

  /** Route a frame from the extension; returns true if it was consumed. */
  handle(frame: Frame): boolean {
    switch (frame.t) {
      case 'invoke.result': {
        const p = this.take(frame.callId);
        if (!p) return true;
        p.resolve({ result: frame.result, doc: frame.doc, truncated: frame.truncated ?? false });
        return true;
      }
      case 'invoke.error': {
        const p = this.take(frame.callId);
        if (!p) return true;
        p.reject(AgentDebugError.from(frame.error as ToolError));
        return true;
      }
      case 'invoke.progress': {
        const p = this.pending.get(frame.callId);
        p?.onProgress?.({ progress: frame.progress, total: frame.total, message: frame.message, data: frame.data });
        return true;
      }
      default:
        return false;
    }
  }

  cancel(callId: string, error: AgentDebugError): PendingCall | undefined {
    const p = this.take(callId);
    p?.reject(error);
    return p;
  }

  /** Fail every pending call (e.g. extension disconnected). */
  failAll(error: AgentDebugError, predicate: (p: PendingCall) => boolean = () => true): void {
    for (const p of [...this.pending.values()]) {
      if (!predicate(p)) continue;
      this.take(p.callId);
      p.reject(error);
    }
  }

  size(): number {
    return this.pending.size;
  }

  private take(callId: string): PendingCall | undefined {
    const p = this.pending.get(callId);
    if (!p) return undefined;
    clearTimeout(p.timer);
    this.pending.delete(callId);
    return p;
  }
}
