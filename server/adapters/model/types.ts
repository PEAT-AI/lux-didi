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
export type ToolOutcome = { status: 'completed'; value: unknown } | { status: 'failed' | 'unknown' };
export interface ToolDefinition extends FunctionDeclaration {
  validate(args: unknown): boolean;
  effect: 'read' | 'write'; accountId: string; resourceId: string;
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
}
