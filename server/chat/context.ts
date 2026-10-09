import type { DomainContext, Entry } from '../contracts/domain.js';
import { compilePrompt, createCapabilitySnapshot, PROMPT_VERSION, PromptCompileError,
  type CompileInput, type CompiledPrompt, type Evidence, type HistoryItem } from '../prompt/index.js';
import { ChatError, type ChatConfig, type ClassificationSubject } from './types.js';

export class ContextFailure extends Error {
  constructor(readonly outcome: 'input_too_large' | 'compile_failed' | 'unavailable') { super(outcome); }
}
export function classify(config: ChatConfig, subject: ClassificationSubject) {
  let value: ReturnType<ChatConfig['classify']>;
  try { value = config.classify(subject); }
  catch { throw new ChatError('unavailable'); }
  if (!value || value.ownerId !== config.store.assistantId || !['ordinary', 'private', 'sensitive'].includes(value.dataClass)) throw new ChatError('unavailable');
  return { schemaVersion: 1 as const, ownerId: value.ownerId, dataClass: value.dataClass };
}
export interface ContextTrace {
  compileInput: CompileInput; manifest: CompiledPrompt['manifest'];
  omittedHistoryCount: number; selectedHistoryIds: string[]; selectedSourceIds: string[];
  historyOmissionReason: 'compiler_budget_or_limit' | null;
}
/** Domain reads finish in one synchronous Store transaction before compilation. */
export function assemble(config: ChatConfig, sessionId: string, currentId: string, context: DomainContext) {
  const configured = new Map([['session', true], ['recall', Boolean(config.context.recall)], ['today', Boolean(config.context.today)]]);
  for (const source of config.context.sources) {
    if (!configured.has(source.id) || (source.state === 'available') !== configured.get(source.id)) throw new ContextFailure('unavailable');
  }
  const read = config.store.transaction(tx => {
    const session = config.domain.execute(tx, 'getSession', { id: sessionId }, context);
    const recall = config.context.recall ? config.domain.execute(tx, 'recall', config.context.recall, context) : null;
    const today = config.context.today ? config.domain.execute(tx, 'plan', config.context.today, context) : null;
    return { session, recall, today };
  });
  if (read.session.nextCursor !== null || read.recall?.nextCursor || read.today?.nextCursor) throw new ContextFailure('unavailable');
  classify(config, { kind: 'session', id: sessionId });
  const history: HistoryItem[] = read.session.entries.map((entry: Entry) => {
    if (entry.role === 'system') throw new ContextFailure('unavailable');
    return { ...classify(config, { kind: 'entry', id: entry.id, sourceRefs: entry.sourceRefs }), id: entry.id,
      role: entry.role === 'assistant' ? 'model' : 'user', text: entry.text };
  });
  const current = history.at(-1);
  if (!current || current.id !== currentId || current.role !== 'user') throw new ContextFailure('unavailable');
  const evidence: Evidence[] = [];
  for (const hit of read.recall?.hits ?? []) {
    const id = `recall:${hit.sessionId}:${hit.entryId ?? 'session'}`;
    evidence.push({ ...classify(config, { kind: 'recall', id, sourceRefs: hit.sourceRefs }),
      id, sourceId: hit.entryId ?? hit.sessionId, provenance: 'domain.recall', priority: 1, kind: 'source', text: JSON.stringify(hit) });
  }
  if (read.recall) evidence.push({ ...classify(config, { kind: 'recall', id: 'recall:coverage' }),
    id: 'recall:coverage', sourceId: 'domain.recall', provenance: 'domain.recall coverage', priority: 2,
    kind: 'source', text: JSON.stringify({ totalMatches: read.recall.totalMatches, truncated: read.recall.truncated }) });
  for (const item of [...(read.today?.items.map(i => i.commitment) ?? []), ...(read.today?.unscheduled ?? [])]) {
    evidence.push({ ...classify(config, { kind: 'commitment', id: item.id }), id: `today:${item.id}`,
      sourceId: item.id, provenance: `domain.plan:${read.today!.date}:${read.today!.timeZone}`, priority: 1,
      kind: 'source', text: JSON.stringify(item) });
  }
  const capabilities = createCapabilitySnapshot([], [...configured].map(([id, available]) => ({ id, state: available ? 'available' : 'missing' })));
  const base: CompileInput = { ownerId: config.store.assistantId, persona: 'didi', promptVersion: PROMPT_VERSION,
    preferences: config.preferences, capabilities, evidence, history: [current], budgets: config.context.budgets };
  let compiled: CompiledPrompt;
  try { compiled = compilePrompt(base); }
  catch (error) {
    if (current.text.length > base.budgets.historyChars) throw new ContextFailure('input_too_large');
    if (error instanceof PromptCompileError && error.code === 'budget') {
      try { compilePrompt({ ...base, budgets: { ...base.budgets, historyChars: 200000 } }); }
      catch { throw new ContextFailure('compile_failed'); }
      throw new ContextFailure('input_too_large');
    }
    throw new ContextFailure('compile_failed');
  }
  // A whole turn begins at each user entry. Keep a contiguous suffix; compiler
  // serialization (including JSON escaping/metadata and accepted item limits)
  // is the authority, not a text-length estimate or an arbitrary archive cap.
  let start = history.length - 1;
  const starts = history.flatMap((item, i) => item.role === 'user' ? [i] : []);
  for (let i = starts.length - 2; i >= 0; i--) {
    const candidate = starts[i]!;
    try { const value = compilePrompt({ ...base, history: history.slice(candidate) }); compiled = value; start = candidate; }
    catch (error) {
      if (error instanceof PromptCompileError && (error.code === 'budget' || error.code === 'schema')) break;
      throw error;
    }
  }
  const compileInput = { ...base, history: history.slice(start) };
  const trace: ContextTrace = { compileInput, manifest: compiled.manifest, omittedHistoryCount: start,
    selectedHistoryIds: compiled.manifest.historyIds, selectedSourceIds: compiled.manifest.selectedIds,
    historyOmissionReason: start ? 'compiler_budget_or_limit' : null };
  const { manifest: _private, ...request } = compiled;
  return { request, trace };
}
