import type { DataClass, ExecutionContext, JsonObject, ToolCallIntent, ToolDefinition, ToolOutcome, ToolResultRef } from '../adapters/model/types.js';
import { intentDeclarations, planIntent, intentResponse, type IntentDeclaration, type IntentSubResult } from '../tools/intent.js';
import type { ChatStepEvent } from './types.js';

/** One chat tool call never holds a run longer than this; the connector call is aborted. */
export const CHAT_TOOL_TIMEOUT_MS = 15_000;

/** Short human phrases for the step list. The end event carries counts only, never content. */
const LABELS: Record<string, string> = {
  search: 'searched everything', search_knowledge: 'searched the knowledge base', mail: 'searched mail', calendar: 'checked the calendar', drive: 'searched Drive',
  contacts: 'checked contacts', memory: 'read saved memory',
  gmail_list: 'listed mail', gmail_read: 'read a message', gmail_search: 'searched mail',
  gcal_list: 'listed calendar events', gcal_read: 'read an event', gcal_search: 'searched the calendar',
  gdrive_list: 'listed files', gdrive_read: 'read a file', gdrive_search: 'searched Drive',
  mattermost_search: 'searched Mattermost', mattermost_read: 'read a channel',
};

export function toolLabel(tool: string): string {
  return LABELS[tool] ?? (tool.replace(/[._-]+/g, ' ').trim() || 'used a tool');
}

/** One settled call, before its count is known: the caller owns the count and the end event. */
export interface ChatCallRecord { stepId: string; tool: string; label: string; ok: boolean; ms: number }

export interface ChatStepHooks {
  runId: string;
  onStep(event: ChatStepEvent): void;
  /** Called once per settled call, in call order; the caller publishes the end event with its count. */
  onFinished?(record: ChatCallRecord): void;
  timeoutMs?: number;
  now?(): number;
}

type Raced<T> = { value: T } | { aborted: true } | { error: unknown };

/** Settle with the work, or as soon as the signal aborts, so a slow call never holds the run. */
function race<T>(signal: AbortSignal, work: Promise<T>): Promise<Raced<T>> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (outcome: Raced<T>) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const onAbort = () => finish({ aborted: true });
    if (signal.aborted) { finish({ aborted: true }); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(value => finish({ value }), error => finish({ error }));
  });
}

/**
 * The chat tool surface: the same definitions, each call bounded by its own timeout with an
 * abort signal routed into the connector call, and each call reported as a pair of step events.
 * A timed-out call returns a structured failure and never hangs the round.
 */
export function chatToolRegistry(tools: readonly ToolDefinition[], hooks: ChatStepHooks): ToolDefinition[] {
  const timeoutMs = hooks.timeoutMs ?? CHAT_TOOL_TIMEOUT_MS;
  const now = hooks.now ?? (() => Date.now());
  let counter = 0;
  return tools.map(tool => ({
    ...tool,
    execute: async (args: JsonObject, context: ExecutionContext): Promise<ToolOutcome> => {
      const stepId = `${hooks.runId}:${++counter}`;
      const label = toolLabel(tool.name);
      const startedAt = now();
      const end = (ok: boolean) => hooks.onFinished?.({ stepId, tool: tool.name, label, ok, ms: now() - startedAt });
      hooks.onStep({ type: 'chat_step', runId: hooks.runId, stepId, tool: tool.name, phase: 'start', label });
      const abort = new AbortController();
      let timedOut = false;
      const cancel = () => abort.abort();
      if (context.signal.aborted) abort.abort();
      else context.signal.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => { timedOut = true; abort.abort(); }, timeoutMs);
      try {
        const raced = await race(abort.signal, tool.execute(args, { ...context, signal: abort.signal }));
        if ('error' in raced) { end(false); throw raced.error; }
        if ('aborted' in raced) {
          // The fence cut this call, or its own timeout did: report which, never hang.
          end(false);
          return timedOut ? { status: 'failed', code: 'timeout' } : { status: 'failed', code: 'cancelled' };
        }
        end(raced.value.status === 'completed');
        return raced.value;
      } finally {
        clearTimeout(timer);
        context.signal.removeEventListener('abort', cancel);
      }
    },
  }));
}

/** Labels of the calls still running when the fence cut acquisition, for the partial answer. */
export function notReachedLabels(events: readonly ChatStepEvent[]): string[] {
  const started = new Map<string, string>();
  for (const event of events) {
    if (event.phase === 'start') started.set(event.stepId, event.label);
    else started.delete(event.stepId);
  }
  return [...started.values()];
}

/** Frozen evidence for the answer phase; content already sanitized for the owner. */
export interface FrozenEvidence { readonly name: string; readonly markdown: string }

/** Bounded so the answer call cannot run out of its own budget on evidence size. */
const EVIDENCE_CHARS = 12_000;

const list = (items: readonly string[]): string =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}` : items[0] ?? '';

/** One tool-free call answers from this: never a tool call, and say plainly what was not reached. */
export function answerInstruction(evidence: readonly FrozenEvidence[], notReached: readonly string[]): string {
  const blocks: string[] = [];
  let used = 0;
  for (const item of evidence) {
    const block = `${toolLabel(item.name)}:\n${item.markdown}`;
    if (used + block.length > EVIDENCE_CHARS) break;
    used += block.length;
    blocks.push(block);
  }
  return ['Answer the owner now from what was gathered this turn. Do not call any tool.',
    'If it does not cover every part of the request, say plainly what you could not reach and what to retry.',
    notReached.length ? `Still running when the search stopped: ${list(notReached)}.` : '',
    blocks.length ? `Evidence gathered this turn:\n\n${blocks.join('\n\n')}` : 'No evidence was gathered this turn.',
  ].filter(part => part.length > 0).join('\n\n');
}

/** The answer the server writes itself when the answer call fails: same evidence, no model. */
export function deterministicAnswer(evidence: readonly FrozenEvidence[], notReached: readonly string[]): string {
  const searched = [...new Set(evidence.map(item => toolLabel(item.name)))];
  const parts = [searched.length ? `I searched ${list(searched)}` : 'I could not search any source',
    `found ${evidence.length} item${evidence.length === 1 ? '' : 's'}`];
  if (notReached.length) parts.push(`${list(notReached)} did not answer in time`);
  return `${parts.join('; ')}.`;
}


/** One sub read the plan ran, already materialized through the result gate. */
export interface ChatSubResult { name: string; ok: boolean; response: JsonObject }

export interface ChatIntentOptions {
  /** Runs the planned connector calls; the caller owns the loop, the journal and the result gate. */
  runSubs(calls: readonly { name: string; args: JsonObject }[], signal: AbortSignal): Promise<readonly ChatSubResult[]>;
  /** The intent journaled for this execution, so the shaped digest completes under it. */
  callOf(executionId: string): ToolCallIntent | undefined;
  complete(call: ToolCallIntent, response: JsonObject, dataClasses: readonly DataClass[]): ToolResultRef;
  declarations?: readonly IntentDeclaration[];
}

const textOf = (response: JsonObject): string => typeof response.text === 'string' ? response.text
  : typeof response.markdown === 'string' ? response.markdown : '';

/**
 * The chat intent surface: the same coarse tools the Live session declares, so one model call both
 * searches and shapes instead of spending rounds on discovery reads. Each call runs its plan through
 * the caller's sub runner and returns the combined digest as its own completed result.
 */
export function chatIntentTools(options: ChatIntentOptions): ToolDefinition[] {
  const declarations = options.declarations ?? intentDeclarations();
  return declarations.map(declaration => ({
    name: declaration.name, description: declaration.description, guidance: declaration.guidance,
    parameters: declaration.parameters, validate: declaration.validate,
    effect: 'read' as const, accountId: 'gateway:chat-voice-parity', resourceId: 'intent',
    execute: async (args: JsonObject, context: ExecutionContext): Promise<ToolOutcome> => {
      const call = options.callOf(context.executionId);
      // No journaled intent means the shaped digest has nothing to complete under: fail closed.
      if (!call) return { status: 'failed', code: 'handler_outcome' };
      let plan: ReturnType<typeof planIntent>;
      try { plan = planIntent(declaration.name, args); } catch { return { status: 'failed', code: 'handler_outcome' }; }
      const shape = (planned: readonly { name: string; args: JsonObject }[], results: readonly ChatSubResult[]): IntentSubResult[] =>
        planned.map((entry, index) => {
          const result = results[index];
          const ok = result !== undefined && result.name === entry.name && result.ok;
          const text = ok ? textOf(result.response) : '';
          return { key: String(index), name: entry.name, ok, text, originalCharacters: text.length,
            omittedCharacters: 0, ...(ok ? {} : { code: 'connector_error' }) };
        });
      const results = shape(plan.calls, await options.runSubs(plan.calls.map(entry => ({ name: entry.name, args: entry.args })), context.signal));
      if (plan.follow) {
        const extra = plan.follow(results);
        if (extra.length) results.push(...shape(extra, await options.runSubs(extra, context.signal)));
      }
      // One model-visible digest under the intent's own journaled call, shaped by the shared combiner.
      return { status: 'completed', result: options.complete(call, intentResponse(plan.combine(results), declaration.name), []) };
    },
  }));
}
