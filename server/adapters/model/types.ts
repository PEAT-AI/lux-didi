export type DataClass = 'ordinary' | 'private' | 'sensitive';
export type JsonObject = Record<string, unknown>;
/** Internal provider continuation only. Never serialize parts to UI. */
export interface Part extends JsonObject {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args: JsonObject };
  functionResponse?: { id?: string; name: string; response: JsonObject };
}
export interface Content { role: 'user' | 'model'; parts: Part[] }
export interface ContextSelection {
  items: { id: string; text: string; dataClass: DataClass }[];
  selectedIds: string[];
  maxChars: number;
}
export interface FunctionDeclaration { name: string; description: string; parameters: JsonObject }
export interface ModelRequest {
  system: string;
  promptVersion: string;
  contents: Content[];
  dataClasses: DataClass[];
  context: ContextSelection;
  declarations?: FunctionDeclaration[];
  /** Optional generation controls for a plain text call (session distillation). */
  temperature?: number;
  responseMimeType?: string;
}
export interface PromptMetadata { version: string; hash: string; omittedContextIds: string[] }
export interface Timings { kind: 'measured' | 'synthetic'; totalMs: number; firstTextMs: number | null }
export type ModelStatus = 'complete' | 'denied' | 'blocked' | 'error' | 'empty' | 'truncated' | 'cancelled' | 'deadline';
export interface ModelResult {
  status: ModelStatus;
  /** Provisional text is retained on non-complete outcomes, not a completed answer. */
  text: string;
  providerContent: Content;
  reason: string;
  prompt: PromptMetadata;
  timings: Timings;
}
export type ModelEvent = { type: 'text'; text: string; provisional: true } | { type: 'outcome'; status: ModelStatus };
/**
 * Absolute wall-clock milliseconds (a `Date.now()` epoch). A relative budget is
 * deliberately not assignable, so a timeout expressed in milliseconds-since-now
 * can never be passed where an epoch is expected. Build one with `deadlineAt`.
 */
export type DeadlineAtMs = number & { readonly __deadlineAtMs: unique symbol };
/** The only producer of a `DeadlineAtMs`: an absolute epoch from a relative budget. */
export function deadlineAt(nowMs: number, budgetMs: number): DeadlineAtMs { return (nowMs + budgetMs) as DeadlineAtMs; }
export interface ModelControl { signal: AbortSignal; deadlineMs: number; onEvent?: (event: ModelEvent) => void }
export interface ModelPort { generate(request: ModelRequest, control: ModelControl): Promise<ModelResult> }
export type Transport = (url: string, init: RequestInit) => Promise<Response>;
export interface Credentials { resolve(reference: string): Promise<string | undefined> }
export interface Route { enabled: boolean; provider: 'gemini'; modelId: string; dataClasses: DataClass[] }
export interface HostContext {
  runId: string; actorId: string; authorityEpoch: string; revision: number;
  grants: { tool: string; effect: 'read' | 'write'; accountId: string; resourceId: string }[];
}
export interface ExecutionContext {
  runId: string; actorId: string; authorityEpoch: string; revision: number;
  accountId: string; resourceId: string; executionId: string; signal: AbortSignal;
}
export type ToolResultRef = { id: string; sha256: string };
export type ToolCallIntent = Omit<ExecutionContext, 'signal'> & {
  toolName: string; argumentsHash: string; callId?: string;
};
export type ToolCallRefusal = Omit<ToolCallIntent, 'accountId' | 'resourceId'> & {
  accountId?: string; resourceId?: string;
};
/** Closed, privacy-safe stage for a dispatched MCP call that failed. */
export const MCP_FAILURE_STAGES = ['timeout', 'cancelled', 'child_exited', 'pipe_closed', 'sdk_protocol_rejected', 'invalid_result'] as const;
export type McpFailureStage = (typeof MCP_FAILURE_STAGES)[number];
export const TOOL_FAILURE_CODES = [...MCP_FAILURE_STAGES, 'connector_error', 'handler_outcome',
  // #637: the ask named a channel the chat connector does not know, so no read was made.
  'channel_not_found',
  // TR-R8: the tool door refused a read the connection does not cover, so no read was dispatched.
  'not_granted'] as const;
export type ToolFailureCode = (typeof TOOL_FAILURE_CODES)[number];
export function isMcpFailureStage(value: string): value is McpFailureStage {
  return (MCP_FAILURE_STAGES as readonly string[]).includes(value);
}
export function isToolFailureCode(value: string): value is ToolFailureCode {
  return (TOOL_FAILURE_CODES as readonly string[]).includes(value);
}
export type ToolOutcome = { status: 'completed'; result: ToolResultRef } | { status: 'failed' | 'unknown'; code?: ToolFailureCode };
export interface ToolCallJournal {
  intent(call: ToolCallIntent, validatedArguments?: unknown): 'fresh' | 'existing';
  refuse(call: ToolCallRefusal, reason: string): ToolResultRef;
  fail(call: ToolCallIntent, status: 'failed' | 'unknown', reason: string): ToolResultRef;
}
export interface ToolResultBinding {
  executionId: string; name: string; callId?: string;
  contentIndex: number; partIndex: number; result: ToolResultRef;
}
export interface ToolResultGate {
  authorize(host: HostContext, bindings: readonly ToolResultBinding[],
    baseClasses: readonly DataClass[], signal: AbortSignal): Promise<
      | { state: 'allowed'; results: readonly {
          binding: ToolResultBinding; response: JsonObject; dataClasses: readonly DataClass[];
        }[] }
      | { state: 'refused'; reason: string }>;
}
export interface ToolDefinition extends FunctionDeclaration {
  validate(args: unknown): boolean;
  /** One-try guidance shown to the model when it sends an unusable argument shape. */
  guidance?: string;
  effect: 'read' | 'write'; accountId: string; resourceId: string; endpointId?: string;
  execute(args: JsonObject, context: ExecutionContext): Promise<ToolOutcome>;
}
export interface Authority { isCurrent(host: HostContext, tool: ToolDefinition, signal: AbortSignal): Promise<boolean> }
export interface ToolRecord {
  callId?: string; name: string; executionId: string;
  status: 'completed' | 'failed' | 'unknown' | 'refused'; reason: string;
}
export interface LoopResult {
  status: ModelStatus | 'limit' | 'uncertain'; text: string; tools: ToolRecord[];
  steps: number; reason: string; modelResult?: ModelResult;
  /** Host-only history, including opaque signatures. Never serialize to UI. */
  continuation: Content[];
  resultBindings: ToolResultBinding[];
}
