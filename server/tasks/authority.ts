import type { ToolResult } from './results.js';
export interface Identity { task_id: string; task_revision: number; operation_id: string; connection_generation: number }
export type Effect = 'none' | 'local' | 'external' | 'destructive';
export interface AuthorizationRequest extends Identity { tool: string; effect: Exclude<Effect, 'none'>; args: Record<string, unknown>; outside_text: boolean }
/** C-AUTH implements this port. Admission and commit belong there, never in the model. */
export interface Authority {
  authorize(request: AuthorizationRequest, execute: () => Promise<ToolResult>, signal: AbortSignal): Promise<ToolResult>;
}
/** Explicit synthetic fixture only. Production must supply C-AUTH. */
export class FakeAuthority implements Authority {
  readonly requests: AuthorizationRequest[] = [];
  async authorize(request: AuthorizationRequest, execute: () => Promise<ToolResult>, signal: AbortSignal): Promise<ToolResult> {
    if (signal.aborted) return { status: 'failed', text: '', references: [], next_cursor: null, coverage: 'Not admitted.', repair: 'Use the current revision.' };
    this.requests.push(request);
    return execute();
  }
}
