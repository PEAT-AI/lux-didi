import { sourceCards } from '../tools/source-cards.js';
import { createHash, randomUUID } from 'node:crypto';
import type { DomainContext, ResolvedEntry, RoutingLabelCorrection, RoutingSubject } from '../contracts/domain.js';
import type { SQLRow, Transaction } from '../contracts/storage.js';
import { ServiceError } from '../contracts/errors.js';
import type { DataClass, JsonObject, LoopResult, ModelResult, ModelRequest, ModelControl, ToolDefinition } from '../adapters/model/types.js';
import { publicOwnerProfile, validateOwnerProfile, PROMPT_VERSION } from '../prompt/index.js';
import { runTools } from '../adapters/model/loop.js';
import { declarationsFor } from '../tools/declarations.js';
import { definitionsInTransaction } from '../tools/index.js';
import { stripModelOnlyNotes } from '../tools/live-shape.js';
import { hostLogEvent } from '../tools/host-events.js';
import { canonicalJSON } from '../tools/canonical.js';
import type { LiveAuthority, RunAcceptance, RunSnapshot as OwnerRunSnapshot } from '../tools/types.js';
import type { ToolEvidence } from './types.js';
import { assemble, chatAllowsToolClasses, classify, ContextFailure, type ContextTrace } from './context.js';
import { Subscription } from './subscription.js';
import { answerInstruction, chatToolRegistry, deterministicAnswer, notReachedLabels, type ChatCallRecord } from './tools.js';
import { memorySelectionSnapshot, normalizeSelectedMemory, selectedEvidenceId, MAX_SERIALIZED_SELECTION_BYTES, type RunSelection } from './memorySelection.js';
import { ChatError, type AcceptInput, type ChatConfig, type ChatEvent, type ChatStepEvent, type ChatPort, type ChatRecoveryContext, type ConversationEvent, type Outcome, type RunSnapshot, type EnrollInput, type ConversationStatus, type MemorySelectionSnapshot } from './types.js';
export * from './types.js';
export { chatMigrations } from './schema.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Owner-facing evidence text. The model's own functionResponse keeps the model-only bracket notes;
 * this copy strips them, so the strip call site is exercised without a full tool run. */
export function ownerEvidenceMarkdown(response: Record<string, unknown>): string {
  const text = typeof response.markdown === 'string' ? response.markdown : typeof response.text === 'string' ? response.text : 'Tool refused or unavailable.';
  return stripModelOnlyNotes(text).slice(0, 4096);
}
/** Stable capability identity: a description or schema reword never changes it. */
export type CapabilityIdentity = { name: string; effect: string; accountId: string; resourceId: string };
/**
 * Admit a run's read registry against a session's frozen capability identity.
 * A granted tool is kept only when its identity (name, effect, accountId,
 * resourceId) is unchanged, so a description edit never drops it while a new
 * effect or account still does. Every drop is reported once per session with
 * the tool name and the changed field, metadata only.
 */
export function admitCapabilities<T extends CapabilityIdentity>(registry: readonly T[], admitted: readonly CapabilityIdentity[],
  sessionId: string, logged: Set<string>, log: (line: string) => void): T[] {
  const kept: T[] = [];
  for (const tool of registry) {
    const prior = admitted.find(candidate => candidate.name === tool.name);
    if (prior && prior.effect === tool.effect && prior.accountId === tool.accountId && prior.resourceId === tool.resourceId) { kept.push(tool); continue; }
    const field = !prior ? 'grant' : prior.effect !== tool.effect ? 'effect' : prior.accountId !== tool.accountId ? 'accountId' : 'resourceId';
    const key = `${sessionId}\u0000${tool.name}`;
    if (logged.has(key)) continue;
    logged.add(key);
    log(JSON.stringify({ event: 'chat_capability_dropped', sessionId, tool: tool.name, field }));
  }
  return kept;
}
/** Persisted policy subject: existing entry/session kinds only; revisions are authoritative. */
type SelectedLabel = { kind: 'session' | 'entry'; id: string; schemaVersion: 1; ownerId: string; dataClass: DataClass; revision: number };
/** The subset #checkPolicy reads back out of chat_run_policy.selected_labels. */
type PolicyLabel = { kind: 'session' | 'entry'; id: string; revision: number; dataClass: string };
function nullable(value: SQLRow[string] | undefined) { return value === null || value === undefined ? null : String(value); }
function snapshot(row: SQLRow, finalText: string | null = null, memorySelection: MemorySelectionSnapshot | null = null): RunSnapshot {
  return { runId: String(row.run_id), sessionId: String(row.session_id), userEntryId: String(row.user_entry_id),
    finalEntryId: nullable(row.final_entry_id), finalText, retryOf: nullable(row.retry_of), authorityEpoch: String(row.authority_epoch),
    provider: String(row.provider), model: String(row.model), promptVersion: String(row.prompt_version),
    state: row.state as RunSnapshot['state'], outcome: nullable(row.outcome) as Outcome | null,
    sequence: Number(row.sequence), partialText: String(row.partial_text), partialTruncated: Boolean(row.partial_truncated),
    acceptedAt: String(row.accepted_at), intentAt: nullable(row.intent_at), terminalAt: nullable(row.terminal_at), mayHaveBeenSent: row.intent_at !== null,
    memorySelection, toolEvidence: row.trace ? (JSON.parse(String(row.trace)) as { toolEvidence?: ToolEvidence[] }).toolEvidence ?? [] : [] };
}

/** Redact frozen selections in the caller's domain deletion transaction. */
export function redactDeletedMemoryContext(tx: Transaction, entryId: string): void {
  if (!tx.get("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_run_context'", [])) return;
  for (const row of tx.all('SELECT run_id,resolved_records FROM chat_run_context', [])) {
    const records = JSON.parse(String(row.resolved_records)) as (ResolvedEntry | { entryId: string; deleted: true })[];
    if (!records.some(record => record.entryId === entryId && !('deleted' in record))) continue;
    tx.run('UPDATE chat_run_context SET resolved_records=? WHERE run_id=?',
      [JSON.stringify(records.map(record => record.entryId === entryId ? { entryId, deleted: true } : record)), String(row.run_id)]);
  }
}

export class ChatService implements ChatPort {
  #ready = false;
  readonly #config: ChatConfig;
  readonly #now: () => number;
  readonly #workers = new Map<string, AbortController>();
  readonly #toolAuthorities = new Map<string, { context: DomainContext; authority: LiveAuthority; policyMatches: boolean }>();
  readonly #admissionLogged = new Set<string>();
  readonly #livePolicies = new Map<string, { session_id: string; selected_labels: string }>();
  readonly #subscribers = new Map<string, Set<Subscription<ChatEvent>>>();
  readonly #conversationSubscribers = new Map<string, Set<Subscription<ConversationEvent>>>();
  constructor(config: ChatConfig) {
    if (!Number.isFinite(config.deadlineMs ?? 60000) || (config.deadlineMs ?? 60000) <= 0
      || !Number.isSafeInteger(config.subscriberCapacity ?? 16) || (config.subscriberCapacity ?? 16) < 1
      || !Number.isSafeInteger(config.maxPartialChars ?? 100000) || (config.maxPartialChars ?? 100000) < 1) throw new ChatError('invalid_input');
    this.#config = { ...config, route: { ...config.route }, context: structuredClone(config.context),
      ownerProfile: validateOwnerProfile(config.ownerProfile ?? publicOwnerProfile(config.store.assistantId), config.store.assistantId) };
    this.#now = config.now ?? Date.now;
  }
  #authorizeOwner(context: ChatRecoveryContext) {
    if (context.assistantId !== this.#config.store.assistantId) throw new ChatError('unauthorized');
    if (context.authorityEpoch !== this.#config.store.authorityEpoch) throw new ChatError('epoch_mismatch');
  }
  #authorize(context: DomainContext) {
    this.#authorizeOwner(context);
    if (typeof context.clientId !== 'string' || !context.clientId.trim()) throw new ChatError('unauthorized');
  }
  #context(context: DomainContext): DomainContext { return { ...context, now: new Date(this.#now()).toISOString() }; }
  /** Only active dispatches can supply authority to the canonical tools owner. */
  lookupAuthority(runId: string): LiveAuthority | null {
    const active = this.#toolAuthorities.get(runId);
    if (!active || !active.policyMatches || this.#workers.get(runId)?.signal.aborted) return null;
    try {
      const run = this.get(runId, active.context);
      this.#checkPolicy(runId, run.sessionId, active.context);
      return run.state === 'dispatch_intent' && run.authorityEpoch === active.context.authorityEpoch
        ? structuredClone(active.authority) : null;
    } catch { return null; }
  }

  #toolRegistry(run: RunSnapshot, context: DomainContext): ToolDefinition[] {
    const tools = this.#config.tools;
    if (!tools) return [];
    const permitted = this.conversation(run.sessionId, context).permittedClasses;
    const routeIdentity = this.#identity();
    return this.#config.store.transaction(tx => {
      const frozen = tx.get('SELECT * FROM chat_capability_acceptances WHERE session_id=?', [run.sessionId]);
      if (frozen && (frozen.provider !== this.#config.route.provider || frozen.model !== this.#config.route.model
        || frozen.route_identity !== routeIdentity || frozen.permitted_classes !== canonicalJSON([...permitted].sort()))) throw new ContextFailure('unavailable');
      const ceilingIds = frozen ? JSON.parse(String(frozen.connection_ids)) as string[] : [...tools.connectionIds()];
      // Admit only connection envelopes whose classified allowsets fit this consented route.
      const connectionIds = ceilingIds.filter(id => {
        const row = tx.get('SELECT policy_json FROM tool_connections WHERE owner_id=? AND connection_id=?', [context.assistantId, id]);
        if (!row) return false;
        const policy = JSON.parse(String(row.policy_json)) as import('../tools/types.js').ConnectionPolicy;
        return chatAllowsToolClasses(permitted, policy.sourcePolicy.allowedClasses, policy.route.allowedClasses);
      });
      const consent = this.#consent(tx, run.sessionId, context);
      const acceptance: RunAcceptance = { ownerId: context.assistantId, actorId: context.clientId, runId: run.runId,
        authorityEpoch: context.authorityEpoch, revision: Number(consent.revision),
        route: { identity: routeIdentity, provider: 'gemini', modelId: this.#config.route.model, allowedClasses: [...permitted] },
        allowedClasses: [...permitted], connectionIds };
      const accepted = tools.owner.snapshotRun(tx, acceptance);
      const ownerRow = tx.get('SELECT snapshot_json FROM tool_runs WHERE owner_id=? AND run_id=?', [context.assistantId, run.runId])!;
      const ownerSnapshot = JSON.parse(String(ownerRow.snapshot_json)) as OwnerRunSnapshot;
      const policyIdentity = hash(canonicalJSON(ownerSnapshot.connections.map(c => ({ connectionId: c.connectionId, sha256: c.sha256 }))));
      const registry = definitionsInTransaction(tools.owner, run.runId, tx).filter(t => t.effect === 'read' && t.name !== 'remember_note');
      if (!frozen && registry.length) tx.run('INSERT INTO chat_capability_acceptances VALUES (?,?,?,?,?,?,?,?)',
        [run.sessionId, this.#config.route.provider, this.#config.route.model, routeIdentity, canonicalJSON([...permitted].sort()),
          policyIdentity, canonicalJSON(registry.map(t => ({ name: t.name, effect: t.effect, accountId: t.accountId, resourceId: t.resourceId }))), canonicalJSON(connectionIds)]);
      this.#toolAuthorities.set(run.runId, { context, authority: { ...acceptance, acceptedRunHash: accepted.sha256 },
        policyMatches: !frozen || frozen.policy_identity === policyIdentity });
      if (!frozen) return registry;
      const admitted = JSON.parse(String(frozen.capabilities_json)) as CapabilityIdentity[];
      return admitCapabilities(registry, admitted, run.sessionId, this.#admissionLogged, line => console.warn(line));
    });
  }

  /** Only the loop's gate-authorized continuation reaches this seam; never read raw tool_calls here. */
  #toolEvidence(request: ModelRequest): ToolEvidence[] {
    return request.contents.flatMap(content => content.parts.flatMap(part => {
      const result = part.functionResponse;
      if (!result) return [];
      const response = result.response;
      const sources = sourceCards({ text: response.text, markdown: response.markdown, sources: response.sources });
      // Owner-facing copy only: the model's own functionResponse keeps the paging/omission note.
      return [{ name: result.name, markdown: ownerEvidenceMarkdown(response), sources }];
    })).slice(0, 16);
  }

  async #generate(run: RunSnapshot, context: DomainContext, request: ModelRequest, registry: ToolDefinition[], control: ModelControl): Promise<Pick<ModelResult, 'status' | 'text'> & {
    dataClass: 'private' | 'sensitive'; partial?: true; notReached?: readonly string[] }> {
    const model = this.#config.model!;
    const tools = this.#config.tools;
    let dataClass: 'private' | 'sensitive' = 'private';
    const generate = (outgoing: ModelRequest, outgoingControl: ModelControl) => {
      if (outgoing.dataClasses.includes('sensitive')) dataClass = 'sensitive';
      return model.generate(outgoing, outgoingControl);
    };
    if (!tools) { const result = await generate(request, control); return { status: result.status, text: result.text, dataClass }; }
    const active = this.#toolAuthorities.get(run.runId)!;
    const host = { runId: run.runId, actorId: context.clientId, authorityEpoch: context.authorityEpoch,
      revision: active.authority.revision, grants: registry.map(t => ({ tool: t.name, effect: t.effect, accountId: t.accountId, resourceId: t.resourceId })) };
    const steps: ChatStepEvent[] = [];
    const rounds: number[] = [];
    const onStep = (event: ChatStepEvent) => { steps.push(event); this.#emit(run.runId, event); };
    // The end event carries the result count, known only once the round's responses are shaped.
    const finished: ChatCallRecord[] = [];
    // `next.contents` is cumulative history, so only responses that have not been consumed are new.
    let consumed = 0;
    const release = (source: readonly number[]) => {
      const counts = [...source];
      while (finished.length) {
        const record = finished.shift()!;
        const resultCount = counts.shift() ?? 0;
        onStep({ type: 'chat_step', runId: run.runId, stepId: record.stepId, tool: record.tool, phase: 'end',
          label: record.label, ok: record.ok, ms: record.ms, resultCount });
      }
    };
    const countOf = (response: JsonObject) => sourceCards({ text: response.text, markdown: response.markdown, sources: response.sources }).length;
    const acquire = chatToolRegistry(registry, { runId: run.runId, onStep, onFinished: record => finished.push(record) });
    const fence = new AbortController();
    const signal = AbortSignal.any([control.signal, fence.signal]);
    // One run budget: acquisition ends at the fence, the answer phase keeps the remainder.
    const startedAt = this.#now();
    const runBudget = Math.max(1, control.deadlineMs - startedAt);
    const acquireMs = Math.min(70_000, Math.round(runBudget * 0.78));
    // Headroom: the outer race arms its deadline timer first, so the answer must finish inside it.
    const answerMs = Math.max(200, runBudget - acquireMs - 3_000);
    const fenceTimer = setTimeout(() => fence.abort(), acquireMs);
    const acquirePhase = async () => runTools({ model: { generate: async (next, nextControl) => {
      // Consent and route currency are checked before EVERY request, including evidence follow-ups.
      this.#checkPolicy(run.runId, run.sessionId, context);
      if (!this.lookupAuthority(run.runId) || next.dataClasses.some(c => !active.authority.allowedClasses.includes(c))) throw new ContextFailure('unavailable');
      const toolEvidence = this.#toolEvidence(next);
      const seen = next.contents.flatMap(content => content.parts.flatMap(part => part.functionResponse ? [countOf(part.functionResponse.response)] : []));
      release(seen.slice(consumed));
      consumed = seen.length;
      this.#config.store.transaction(tx => {
        const row = this.#row(tx, run.runId, context);
        const trace = row.trace ? JSON.parse(String(row.trace)) as Record<string, unknown> : {};
        tx.run('UPDATE chat_runs SET trace=? WHERE run_id=?', [JSON.stringify({ ...trace, toolEvidence }), run.runId]);
      });
      // runTools retains originals for validation; the canonical helper alone derives provider schemas.
      const declarations = next.declarations?.length === 0 ? [] : declarationsFor(registry).declarations;
      const roundStarted = this.#now();
      const answered = await generate({ ...next, declarations }, nextControl);
      rounds.push(this.#now() - roundStarted);
      return answered;
      } }, request, registry: acquire, host, control: { ...control, signal }, maxSteps: 4,
      authority: { isCurrent: async () => this.lookupAuthority(run.runId) !== null },
      journal: tools.owner.journal, resultGate: tools.owner.resultGate });
    // A fenced or throwing acquisition still answers from what it gathered.
    let loop: LoopResult | undefined;
    let failure: unknown;
    try { loop = await acquirePhase(); }
    catch (error) { failure = error; loop = undefined; }
    finally { clearTimeout(fenceTimer); fence.abort(); }
    // A refused run keeps its refusal: consent, route and the result gate still own the outcome.
    if (failure instanceof ContextFailure) throw failure;
    // The calls the fence cut are named before their end events are released.
    const cutLabels = notReachedLabels(steps);
    release([]);
    // The finite bound can stop after a tool result, before another model request.
    // Read its projection through the SAME canonical gate, never from raw journal JSON.
    if (!control.signal.aborted && this.lookupAuthority(run.runId)) {
      const final = await tools.owner.resultGate.authorize(host, loop?.resultBindings ?? [], request.dataClasses, control.signal);
      const toolEvidence = final.state === 'allowed' ? this.#toolEvidence({ ...request, contents: [{ role: 'user', parts: final.results.map(result => ({ functionResponse: { name: result.binding.name, response: result.response } })) }] }) : [];
      this.#config.store.transaction(tx => {
        const row = this.#row(tx, run.runId, context);
        const trace = row.trace ? JSON.parse(String(row.trace)) as Record<string, unknown> : {};
        tx.run('UPDATE chat_runs SET trace=? WHERE run_id=?', [JSON.stringify({ ...trace, toolEvidence }), run.runId]);
      });
    }
    const settled = loop;
    if (settled !== undefined && settled.status === 'complete' && settled.text.trim().length > 0) {
      this.#timing(run, rounds, steps, this.#now() - startedAt, acquireMs, answerMs, 'answered');
      return { status: 'complete', text: settled.text, dataClass };
    }
    // A gate refusal or a provider error is not a cut run: it keeps its own outcome, never an invented answer.
    if (settled !== undefined && (settled.status === 'denied' || settled.status === 'error')) {
      return { status: settled.status, text: settled.text, dataClass };
    }
    if (settled !== undefined && settled.text.trim().length > 0 && settled.status !== 'limit'
      && settled.status !== 'uncertain' && settled.status !== 'empty') {
      return { status: settled.status, text: settled.text, dataClass };
    }
    // ANSWER: one tool-free call over the frozen evidence, then a deterministic answer if it fails.
    // Nothing gathered during acquisition is discarded at the fence.
    const evidence = this.#frozenEvidence(run);
    const notReached = cutLabels;
    let answer = '';
    if (!control.signal.aborted) {
      // The answer request passes the same check as every acquire request, evidence included.
      this.#checkPolicy(run.runId, run.sessionId, context);
      if (!this.lookupAuthority(run.runId) || request.dataClasses.some(c => !active.authority.allowedClasses.includes(c))) {
        throw new ContextFailure('unavailable');
      }
      const answerAbort = new AbortController();
      const answerTimer = setTimeout(() => answerAbort.abort(), answerMs);
      try {
        const result = await generate({ ...request, declarations: [],
          contents: [...request.contents, { role: 'user', parts: [{ text: answerInstruction(evidence, notReached) }] }] },
        { signal: AbortSignal.any([control.signal, answerAbort.signal]), deadlineMs: this.#now() + answerMs });
        answer = result.text.trim();
      } catch (error) {
        if (error instanceof ContextFailure) throw error;
        answer = '';
      } finally { clearTimeout(answerTimer); }
    }
    this.#timing(run, rounds, steps, this.#now() - startedAt, acquireMs, answerMs, 'fenced');
    return { status: 'complete', text: answer || deterministicAnswer(evidence, notReached), dataClass, partial: true, notReached };
  }

  /** One bounded receipt per run: model and tool milliseconds and counts only, never text. */
  #timing(run: RunSnapshot, rounds: readonly number[], steps: readonly ChatStepEvent[], fenceMs: number,
    acquireMs: number, answerMs: number, outcome: 'answered' | 'fenced'): void {
    hostLogEvent({ event: 'chat_timing', runId: run.runId, outcome, rounds: [...rounds],
      tools: steps.filter(step => step.phase === 'end').map(step => ({ tool: step.tool, ok: step.ok === true, ms: step.ms ?? 0 })),
      fenceMs, acquireMs, answerMs });
  }
  /** The evidence persisted before every model request: frozen at the fence, never re-read from a call. */
  #frozenEvidence(run: RunSnapshot): { name: string; markdown: string }[] {
    let stored: unknown[] = [];
    try {
      this.#config.store.transaction(tx => {
        const row = tx.get('SELECT trace FROM chat_runs WHERE run_id=?', [run.runId]);
        const trace = row?.trace ? JSON.parse(String(row.trace)) as Record<string, unknown> : {};
        stored = Array.isArray(trace.toolEvidence) ? trace.toolEvidence : [];
      });
    } catch { return []; }
    return stored.flatMap(item => {
      const entry = item as Record<string, unknown>;
      return typeof entry.name === 'string' && typeof entry.markdown === 'string' ? [{ name: entry.name, markdown: entry.markdown }] : [];
    });
  }
  #row(tx: Transaction, runId: string, context: DomainContext) {
    const row = tx.get('SELECT * FROM chat_runs WHERE run_id=? AND owner_assistant_id=?', [runId, context.assistantId]);
    if (!row) throw new ChatError('not_found');
    return row;
  }
  #snapshot(tx: Transaction, row: SQLRow, context: DomainContext): RunSnapshot {
    const memorySelection = this.#memorySelection(tx, row);
    if (row.outcome !== 'complete') return snapshot(row, null, memorySelection);
    const read = this.#config.domain.execute(tx, 'getSession', { id: String(row.session_id) }, this.#context(context));
    const entry = read.entries.find(item => item.id === row.final_entry_id && item.role === 'assistant');
    if (!entry) throw new ChatError('unavailable');
    return snapshot(row, entry.text, memorySelection);
  }
  /** Safe requested/used/omitted metadata; no record text and no whole-archive claim. */
  #memorySelection(tx: Transaction, row: SQLRow): MemorySelectionSnapshot | null {
    // A database written before chat v3 carries no selection table: it means
    // empty selection, exactly like a run with no chat_run_context row.
    if (!tx.get("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_run_context'", [])) return null;
    const stored = tx.get('SELECT * FROM chat_run_context WHERE run_id=?', [String(row.run_id)]);
    if (!stored) return null;
    const requestedIds = JSON.parse(String(stored.requested_ids)) as string[];
    let manifest: { selectedIds?: readonly string[]; omitted?: readonly { id: string; reason: string }[] } | null = null;
    if (String(row.state) !== 'accepted' && row.trace !== null && row.trace !== undefined) {
      try {
        const parsed = JSON.parse(String(row.trace)) as { manifest?: { selectedIds?: string[]; omitted?: { id: string; reason: string }[] } };
        manifest = parsed.manifest ?? null;
      } catch { manifest = null; }
    }
    return memorySelectionSnapshot(requestedIds, manifest);
  }
  #identity() {
    const route = this.#config.route;
    return JSON.stringify({ version: 1, provider: route.provider, model: route.model,
      endpoint: route.endpoint, apiVersion: route.apiVersion, keyReference: route.keyReference,
      allowedClasses: [...route.allowedClasses].sort(), policyVersion: 1 });
  }
  #validConsent(row: SQLRow) {
    const route = this.#config.route;
    const permitted = JSON.stringify([...route.allowedClasses].sort());
    return row.revoked_at === null && row.route_identity === this.#identity()
      && row.provider === route.provider && row.model === route.model && Number(row.revision) === 1
      && JSON.stringify((JSON.parse(String(row.permitted_classes)) as string[]).sort()) === permitted;
  }
  /** The same tuple resolver governs both enrollment and dispatch. */
  #resolveConsent(tx: Transaction, sessionId: string | null, context: DomainContext): SQLRow | undefined {
    const conversation = sessionId === null ? undefined : tx.get(
      "SELECT * FROM chat_consents WHERE scope='conversation' AND session_id=? AND owner_assistant_id=?", [sessionId, context.assistantId]);
    if (conversation && this.#validConsent(conversation)) return conversation;
    const standing = tx.all("SELECT * FROM chat_consents WHERE scope='standing' AND owner_assistant_id=? ORDER BY granted_at DESC,rowid DESC", [context.assistantId]);
    return standing.find(row => this.#validConsent(row)) ?? (sessionId === null ? undefined : conversation ?? standing[0]);
  }
  #consent(tx: Transaction, sessionId: string, context: DomainContext) {
    const known = tx.get('SELECT session_id FROM chat_consents WHERE session_id=? AND owner_assistant_id=?', [sessionId, context.assistantId])
      ?? tx.get('SELECT session_id FROM chat_consent_enrollments WHERE session_id=? AND owner_assistant_id=?', [sessionId, context.assistantId]);
    const row = known && this.#resolveConsent(tx, sessionId, context);
    if (!row) throw new ChatError('consent_required');
    return row;
  }
  #conversation(row: SQLRow, sessionId = String(row.session_id)): ConversationStatus {
    return { sessionId, scope: row.scope as 'conversation' | 'standing', provider: String(row.provider), model: String(row.model),
      latestRunId: null, revision: Number(row.revision), permittedClasses: JSON.parse(String(row.permitted_classes)),
      state: row.revoked_at !== null ? 'revoked' : !this.#validConsent(row) ? 'route_changed' : 'active' };
  }
  standingConsent(context: DomainContext): ConversationStatus | null {
    this.#authorize(context);
    return this.#config.store.transaction(tx => {
      const row = this.#resolveConsent(tx, null, context);
      return row ? this.#conversation(row) : null;
    });
  }
  #liveConsent(tx: Transaction, sessionId: string, context: DomainContext) {
    const row = this.#consent(tx, sessionId, context);
    const state = this.#conversation(row).state;
    if (state === 'revoked') throw new ChatError('consent_revoked');
    if (state === 'route_changed') throw new ChatError('route_changed');
    if (!this.#config.route.available) throw new ChatError('unavailable');
    return row;
  }
  enroll(input: EnrollInput, context: DomainContext): ConversationStatus {
    this.#authorize(context);
    if (!this.#ready) throw new ChatError('recovery_required');
    if (!input || typeof input.title !== 'string' || !input.title.trim() || typeof input.timeZone !== 'string'
      || typeof input.idempotencyKey !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.idempotencyKey)) throw new ChatError('invalid_input');
    const fingerprint = hash(JSON.stringify({ title: input.title, timeZone: input.timeZone, consent: input.consent, remember: input.remember }));
    return this.#config.store.transaction(tx => {
      const prior = tx.get('SELECT * FROM chat_consents WHERE owner_assistant_id=? AND idempotency_key=?', [context.assistantId, input.idempotencyKey]) ?? tx.get('SELECT * FROM chat_consent_enrollments WHERE owner_assistant_id=? AND idempotency_key=?', [context.assistantId, input.idempotencyKey]);
      if (prior) { if (prior.fingerprint !== fingerprint) throw new ChatError('idempotency_conflict'); return this.#conversation(this.#consent(tx, String(prior.session_id), context), String(prior.session_id)); }
      const standing = this.#resolveConsent(tx, null, context);
      if (input.consent === false && !standing) throw new ChatError('consent_required');
      if (input.remember && input.consent !== true) throw new ChatError('consent_required');
      const route = this.#config.route;
      if (!route.available || !route.allows(['private'])) throw new ChatError('unavailable');
      const session = this.#config.domain.execute(tx, 'createSession', { title: input.title, timeZone: input.timeZone }, this.#context(context), { writer: 'capture', dataClass: 'private' });
      const permitted = [...route.allowedClasses];
      if (standing) {
        tx.run('INSERT INTO chat_consent_enrollments VALUES (?,?,?,?)', [session.id, context.assistantId, input.idempotencyKey, fingerprint]);
      } else {
        tx.run(`INSERT INTO chat_consents VALUES (?,?,?,?,?,1,?,?,NULL,?,?,?)`,
          [session.id, context.assistantId, route.provider, route.model, this.#identity(), JSON.stringify(permitted), this.#context(context).now, input.idempotencyKey, fingerprint, input.remember ? 'standing' : 'conversation']);
      }
      return this.#conversation(this.#consent(tx, session.id, context), session.id);
    });
  }
  conversation(sessionId: string, context: DomainContext): ConversationStatus {
    this.#authorize(context);
    return this.#config.store.transaction(tx => ({ ...this.#conversation(this.#consent(tx, sessionId, context), sessionId), latestRunId: nullable(tx.get('SELECT run_id FROM chat_runs WHERE session_id=? AND owner_assistant_id=? ORDER BY accepted_at DESC,rowid DESC LIMIT 1', [sessionId, context.assistantId])?.run_id) }));
  }
  #labels(tx: Transaction, sessionId: string, context: DomainContext): SelectedLabel[] {
    const consent = this.#liveConsent(tx, sessionId, context);
    const permitted: string[] = JSON.parse(String(consent.permitted_classes));
    if (!permitted.includes(this.#config.preferences.dataClass)) throw new ChatError('unavailable');
    const read = this.#config.domain.execute(tx, 'getSession', { id: sessionId }, this.#context(context));
    if (read.nextCursor !== null) throw new ChatError('unavailable');
    return [{ kind: 'session' as const, id: sessionId }, ...read.entries.map(e => ({ kind: 'entry' as const, id: e.id }))].map(subject => {
      const label = classify(this.#config, subject, tx);
      if (!permitted.includes(label.dataClass) || !this.#config.route.allows([label.dataClass])) throw new ChatError('unavailable');
      return { ...subject, ...label, revision: this.#config.classify(subject, tx)!.revision };
    });
  }
  /**
   * Resolve, classify and freeze an explicit selection inside the accept
   * transaction, before any user-entry or run write. Every record's entry label
   * and parent-session label must be known, owned and permitted by the sending
   * consent; the frozen serialization is bounded before any capture.
   */
  #resolveSelection(tx: Transaction, selected: readonly string[], labels: SelectedLabel[], consent: SQLRow, context: DomainContext): ResolvedEntry[] | null {
    if (selected.length === 0) return null;
    let resolved: { records: ResolvedEntry[] };
    try { resolved = this.#config.domain.execute(tx, 'resolveEntries', { entryIds: [...selected] }, this.#context(context)); }
    catch (error) {
      if (error instanceof ServiceError && error.code === 'NOT_FOUND') throw new ChatError('not_found');
      throw error;
    }
    const permitted: string[] = JSON.parse(String(consent.permitted_classes));
    const add = (subject: { kind: 'session' | 'entry'; id: string }) => {
      if (labels.some(existing => existing.kind === subject.kind && existing.id === subject.id)) return;
      const label = classify(this.#config, subject, tx);
      if (!permitted.includes(label.dataClass) || !this.#config.route.allows([label.dataClass])) throw new ChatError('unavailable');
      labels.push({ ...subject, ...label, revision: this.#config.classify(subject, tx)!.revision });
    };
    for (const record of resolved.records) { add({ kind: 'entry', id: record.entryId }); add({ kind: 'session', id: record.sessionId }); }
    if (Buffer.byteLength(JSON.stringify(resolved.records), 'utf8') > MAX_SERIALIZED_SELECTION_BYTES) throw new ChatError('selection_too_large');
    return resolved.records;
  }
  #checkPolicy(runId: string, sessionId: string, context: DomainContext) {
    return this.#config.store.transaction(tx => {
      const consent = this.#liveConsent(tx, sessionId, context);
      const policy = tx.get('SELECT * FROM chat_run_policy WHERE run_id=?', [runId]);
      if (!policy || policy.consent_revision !== consent.revision || policy.route_identity !== this.#identity()) throw new ChatError('unavailable');
      const labels: { kind: 'session' | 'entry'; id: string; revision: number; dataClass: string }[] = JSON.parse(String(policy.selected_labels));
      for (const expected of labels) {
        const actual = this.#config.classify(expected, tx);
        if (!actual || actual.ownerId !== context.assistantId || actual.revision !== expected.revision || actual.dataClass !== expected.dataClass) throw new ChatError('unavailable');
      }
      return { version: 1, consentRevision: Number(consent.revision), routeIdentity: String(policy.route_identity), selectedLabels: labels };
    });
  }
  #invalidate(matches: (row: SQLRow) => boolean, context: DomainContext) {
    for (const [id, policy] of this.#livePolicies) if (matches(policy)) this.#workers.get(id)?.abort();
    const runs = this.#config.store.transaction(tx => tx.all(`SELECT r.*,p.selected_labels FROM chat_runs r JOIN chat_run_policy p ON r.run_id=p.run_id WHERE r.owner_assistant_id=? AND r.state!='terminal'`, [context.assistantId]).filter(matches).map(row => snapshot(row)));
    for (const run of runs) {
      // Consent/correction has already committed. Abort before any terminal write,
      // so a failing terminal persistence cannot leave provider work running.
      this.#workers.get(run.runId)?.abort();
      try { this.#finish(run, context, 'cancelled'); }
      catch { this.#emit(run.runId, { type: 'resync_required', sequence: run.sequence, reason: 'storage_unavailable' }); }
    }
  }
  revoke(sessionId: string, context: DomainContext): ConversationStatus {
    this.#authorize(context);
    const result = this.#config.store.transaction(tx => {
      const row = this.#consent(tx, sessionId, context);
      if (row.revoked_at === null) tx.run('UPDATE chat_consents SET revision=revision+1,revoked_at=? WHERE session_id=? AND owner_assistant_id=?', [this.#context(context).now, String(row.session_id), context.assistantId]);
      return this.#conversation({ ...row, revoked_at: this.#context(context).now, revision: Number(row.revision) + 1 }, sessionId);
    });
    const affected = result.scope === 'standing' ? this.#config.store.transaction(tx => new Set(tx.all(
      'SELECT session_id FROM chat_consents WHERE owner_assistant_id=? UNION SELECT session_id FROM chat_consent_enrollments WHERE owner_assistant_id=?',
      [context.assistantId, context.assistantId]).filter(row => !this.#validConsent(this.#consent(tx, String(row.session_id), context))).map(row => String(row.session_id)))) : new Set([sessionId]);
    this.#invalidate(row => affected.has(String(row.session_id)), context);
    return result;
  }
  correctRoutingLabel(input: RoutingLabelCorrection, context: DomainContext) {
    this.#authorize(context);
    const label = this.#config.store.transaction(tx => this.#config.domain.correctRoutingLabel(tx, input, this.#context(context)));
    this.#invalidate(row => (JSON.parse(String(row.selected_labels)) as RoutingSubject[]).some(s => s.kind === input.subject.kind && s.id === input.subject.id), context);
    return label;
  }
  shutdown() {
    for (const controller of this.#workers.values()) controller.abort();
    for (const listeners of this.#subscribers.values()) for (const subscriber of [...listeners]) subscriber.close();
    for (const listeners of this.#conversationSubscribers.values()) for (const subscriber of [...listeners]) subscriber.close();
  }
  recover(context: ChatRecoveryContext): RunSnapshot[] {
    this.#authorizeOwner(context);
    if (this.#workers.size) throw new ChatError('active_run');
    const recovered = this.#config.store.transaction(tx => {
      if (tx.get("SELECT run_id FROM chat_runs WHERE owner_assistant_id!=? AND state!='terminal'", [context.assistantId])) throw new ChatError('unauthorized');
      const rows = tx.all("SELECT * FROM chat_runs WHERE owner_assistant_id=? AND state!='terminal' ORDER BY accepted_at,run_id", [context.assistantId]);
      return rows.map(row => {
        const outcome = row.state === 'accepted' ? 'not_dispatched' : 'outcome_unknown';
        tx.run("UPDATE chat_runs SET state='terminal',outcome=?,terminal_at=?,terminal_epoch=?,sequence=sequence+1 WHERE run_id=? AND owner_assistant_id=? AND authority_epoch=? AND state=?",
          [outcome, new Date(this.#now()).toISOString(), context.authorityEpoch, String(row.run_id), context.assistantId, String(row.authority_epoch), String(row.state)]);
        return snapshot(tx.get('SELECT * FROM chat_runs WHERE run_id=?', [String(row.run_id)])!);
      });
    });
    this.#ready = true;
    for (const run of recovered) this.#publish(run);
    return recovered;
  }
  accept(input: AcceptInput, context: DomainContext): RunSnapshot {
    this.#authorize(context);
    if (!this.#ready) throw new ChatError('recovery_required');
    if (!input || typeof input.sessionId !== 'string' || !input.sessionId.trim() || typeof input.text !== 'string' || !input.text.trim()
      || typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 128
      || Object.keys(input).some(key => !['sessionId', 'text', 'idempotencyKey', 'retryOf', 'selectedMemoryEntryIds'].includes(key))
      || (input.retryOf !== undefined && (typeof input.retryOf !== 'string' || !input.retryOf.trim()))) throw new ChatError('invalid_input');
    // Canonical selection: absent and [] are empty; duplicates coalesce and the
    // order is canonical. The fingerprint key appears only for a non-empty list,
    // so every stored empty-selection hash stays valid.
    const selected = normalizeSelectedMemory(input.selectedMemoryEntryIds);
    const fingerprint = hash(JSON.stringify({ sessionId: input.sessionId, text: input.text, retryOf: input.retryOf ?? null,
      ...(selected.length ? { selectedMemoryEntryIds: selected } : {}) }));
    const result = this.#config.store.transaction(tx => {
      const prior = tx.get('SELECT * FROM chat_runs WHERE owner_assistant_id=? AND idempotency_key=?', [context.assistantId, input.idempotencyKey]);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new ChatError('idempotency_conflict');
        return { run: this.#snapshot(tx, prior, context), fresh: false, policy: '' };
      }
      const route = this.#config.route;
      if (!route.available || typeof route.provider !== 'string' || !route.provider.trim() || typeof route.model !== 'string' || !route.model.trim()
        || typeof route.allows !== 'function' || typeof this.#config.model?.generate !== 'function') throw new ChatError('unavailable');
      const consent = this.#liveConsent(tx, input.sessionId, context);
      const labels = this.#labels(tx, input.sessionId, context);
      const frozen = this.#resolveSelection(tx, selected, labels, consent, context);
      const session = this.#config.domain.execute(tx, 'getSession', { id: input.sessionId }, this.#context(context)).session;
      if (tx.get("SELECT run_id FROM chat_runs WHERE session_id=? AND state!='terminal'", [input.sessionId])) throw new ChatError('active_run');
      if (input.retryOf) {
        const old = this.#row(tx, input.retryOf, context);
        if (old.session_id !== input.sessionId || old.state !== 'terminal') throw new ChatError('invalid_retry');
      }
      const ctx = this.#context(context);
      const entry = this.#config.domain.execute(tx, 'appendEntry', { sessionId: input.sessionId, text: input.text, role: 'user', timeZone: session.timeZone, sourceRef: { id: randomUUID(), label: 'Connected chat', provider: 'chat', externalId: input.sessionId, sourceTimestamp: null, availability: 'present' } }, ctx, { writer: 'capture', dataClass: 'private' });
      const runId = (this.#config.id ?? randomUUID)();
      tx.run(`INSERT INTO chat_runs(run_id,session_id,user_entry_id,owner_assistant_id,accepting_client_id,idempotency_key,fingerprint,authority_epoch,provider,model,prompt_version,state,retry_of,accepted_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'accepted',?,?)`,
      [runId, input.sessionId, entry.id, context.assistantId, context.clientId, input.idempotencyKey, fingerprint, context.authorityEpoch, route.provider, route.model, PROMPT_VERSION, input.retryOf ?? null, ctx.now]);
      tx.run('INSERT INTO chat_run_owner_profile VALUES (?,?,?)', [runId, 1, JSON.stringify(this.#config.ownerProfile)]);
      labels.push({ kind: 'entry', id: entry.id, ...classify(this.#config, { kind: 'entry', id: entry.id }, tx), revision: this.#config.classify({ kind: 'entry', id: entry.id }, tx)!.revision });
      tx.run('INSERT INTO chat_run_policy VALUES (?,1,?,?,?)', [runId, Number(consent.revision), this.#identity(), JSON.stringify(labels)]);
      if (frozen) tx.run('INSERT INTO chat_run_context VALUES (?,?,?,?)', [runId, 1, JSON.stringify(selected), JSON.stringify(frozen)]);
      return { run: this.#snapshot(tx, tx.get('SELECT * FROM chat_runs WHERE run_id=?', [runId])!, context), fresh: true, policy: JSON.stringify(labels) };
    });
    if (result.fresh) {
      this.#workers.set(result.run.runId, new AbortController());
      this.#livePolicies.set(result.run.runId, { session_id: result.run.sessionId, selected_labels: result.policy });
      // One notification follows the committed fresh run; a replay never reaches here.
      this.#emitConversation(result.run.sessionId, { type: 'run', sessionId: result.run.sessionId, runId: result.run.runId });
      try { (this.#config.schedule ?? queueMicrotask)(() => { void this.#dispatch(result.run, context); }); }
      catch {
        try { this.#finish(result.run, context, 'not_dispatched'); }
        catch { this.#emit(result.run.runId, { type: 'resync_required', sequence: result.run.sequence, reason: 'storage_unavailable' }); }
        this.#workers.delete(result.run.runId);
      }
    }
    return result.run;
  }
  get(runId: string, context: DomainContext): RunSnapshot {
    this.#authorize(context);
    return this.#config.store.transaction(tx => this.#snapshot(tx, this.#row(tx, runId, context), context));
  }
  cancel(runId: string, context: DomainContext): RunSnapshot {
    this.#authorize(context);
    const run = this.get(runId, context);
    if (run.state === 'terminal') return run;
    // Durable terminal wins before abort. If write fails, no false cancellation.
    const final = this.#finish(run, context, 'cancelled');
    if (final.outcome === 'cancelled') this.#workers.get(runId)?.abort();
    return final;
  }
  subscribe(runId: string, context: DomainContext): AsyncIterable<ChatEvent> {
    const run = this.get(runId, context);
    const listeners = this.#subscribers.get(runId) ?? new Set<Subscription<ChatEvent>>();
    if (listeners.size >= 32) throw new ChatError('unavailable');
    const subscription = new Subscription<ChatEvent>(this.#config.subscriberCapacity ?? 16, () => {
      listeners.delete(subscription); if (!listeners.size) this.#subscribers.delete(runId);
    }, last => ({ type: 'resync_required', sequence: 'sequence' in last ? last.sequence : 0, reason: 'backpressure' }));
    listeners.add(subscription); this.#subscribers.set(runId, listeners);
    subscription.push({ type: 'snapshot', sequence: run.sequence, run });
    if (run.state === 'terminal') subscription.close();
    return subscription;
  }
  /** Conversation-scoped notification: register, then read the durable snapshot. No replay buffer. */
  subscribeConversation(sessionId: string, context: DomainContext): AsyncIterable<ConversationEvent> {
    this.conversation(sessionId, context);
    const listeners = this.#conversationSubscribers.get(sessionId) ?? new Set<Subscription<ConversationEvent>>();
    if (listeners.size >= 32) throw new ChatError('unavailable');
    const subscription = new Subscription<ConversationEvent>(this.#config.subscriberCapacity ?? 16, () => {
      listeners.delete(subscription); if (!listeners.size) this.#conversationSubscribers.delete(sessionId);
    }, () => ({ type: 'resync_required', reason: 'backpressure' }));
    listeners.add(subscription); this.#conversationSubscribers.set(sessionId, listeners);
    return subscription;
  }
  #emit(runId: string, event: ChatEvent) {
    // Copy: overflow/terminal detaches while delivering.
    for (const subscriber of [...(this.#subscribers.get(runId) ?? [])]) {
      subscriber.push(event);
      if ((event.type === 'snapshot' && event.run.state === 'terminal') || event.type === 'resync_required') subscriber.close();
    }
  }
  #emitConversation(sessionId: string, event: ConversationEvent) {
    for (const subscriber of [...(this.#conversationSubscribers.get(sessionId) ?? [])]) {
      subscriber.push(event);
      if (event.type === 'resync_required') subscriber.close();
    }
  }
  #publish(run: RunSnapshot) { this.#emit(run.runId, { type: 'snapshot', sequence: run.sequence, run }); }
  #finish(run: RunSnapshot, context: DomainContext, outcome: Outcome, text = '', dataClass: 'private' | 'sensitive' = 'private',
    extras: { partial?: true; notReached?: readonly string[] } = {}): RunSnapshot {
    this.#authorize(context);
    const final = this.#config.store.transaction(tx => {
      const row = this.#row(tx, run.runId, context);
      if (row.state === 'terminal') return this.#snapshot(tx, row, context);
      let entryId: string | null = null;
      if (outcome === 'complete') {
        const session = this.#config.domain.execute(tx, 'getSession', { id: run.sessionId }, this.#context(context)).session;
        const entry = this.#config.domain.execute(tx, 'appendAssistantEntry', { sessionId: run.sessionId, text, timeZone: session.timeZone, sourceRef: { id: randomUUID(), label: 'Connected chat', provider: 'chat', externalId: run.sessionId, sourceTimestamp: null, availability: 'present' } }, this.#context(context), { writer: 'model', dataClass });
        entryId = entry.id;
      }
      const max = this.#config.maxPartialChars ?? 100000;
      const partial = outcome === 'complete' ? '' : text || String(row.partial_text);
      const changed = tx.run(`UPDATE chat_runs SET state='terminal',outcome=?,final_entry_id=?,terminal_at=?,terminal_epoch=?,
        partial_text=?,partial_truncated=?,sequence=sequence+1 WHERE run_id=? AND owner_assistant_id=? AND authority_epoch=? AND state=?`,
        [outcome, entryId, this.#context(context).now, context.authorityEpoch, partial.slice(0, max), Number(partial.length > max || Boolean(row.partial_truncated)), run.runId, context.assistantId, String(row.authority_epoch), String(row.state)]);
      if (changed !== 1) throw new ChatError('epoch_mismatch');
      return this.#snapshot(tx, tx.get('SELECT * FROM chat_runs WHERE run_id=?', [run.runId])!, context);
    });
    this.#emit(final.runId, { type: 'snapshot', sequence: final.sequence, run: final, ...extras }); return final;
  }
  #partial(run: RunSnapshot, context: DomainContext, text: string) {
    if (!text) return;
    this.#authorize(context);
    const event = this.#config.store.transaction(tx => {
      const row = this.#row(tx, run.runId, context);
      if (row.state !== 'dispatch_intent') return null;
      const max = this.#config.maxPartialChars ?? 100000;
      const previous = String(row.partial_text);
      const retained = text.slice(0, Math.max(0, max - previous.length));
      tx.run("UPDATE chat_runs SET partial_text=?,partial_truncated=?,sequence=sequence+1 WHERE run_id=? AND owner_assistant_id=? AND authority_epoch=? AND state='dispatch_intent'",
        [previous + retained, Number(Boolean(row.partial_truncated) || retained.length !== text.length), run.runId, context.assistantId, String(row.authority_epoch)]);
      return { type: 'text' as const, sequence: Number(row.sequence) + 1, text: retained, provisional: true as const };
    });
    if (event) this.#emit(run.runId, event);
  }
  #readOwnerProfile(runId: string) {
    return this.#config.store.transaction(tx => {
      // Migration4 already backfills legacy runs; absence is corruption, never a default selection.
      const row = tx.get('SELECT schema_version,snapshot_json FROM chat_run_owner_profile WHERE run_id=?', [runId]);
      if (!row || row.schema_version !== 1) throw new ContextFailure('compile_failed');
      try { return validateOwnerProfile(JSON.parse(String(row.snapshot_json)), this.#config.store.assistantId); }
      catch { throw new ContextFailure('compile_failed'); }
    });
  }
  #readRunContext(runId: string, context: DomainContext): RunSelection | null {
    return this.#config.store.transaction(tx => {
      const row = tx.get('SELECT * FROM chat_run_context WHERE run_id=?', [runId]);
      if (!row) return null;
      const frozen = JSON.parse(String(row.resolved_records)) as (ResolvedEntry | { entryId: string; deleted: true })[];
      const records: ResolvedEntry[] = [];
      for (const record of frozen) {
        if ('deleted' in record) continue;
        try {
          // Revalidate existence, but preserve the accepted content of surviving records.
          this.#config.domain.execute(tx, 'resolveEntries', { entryIds: [record.entryId] }, this.#context(context));
          records.push(record);
        } catch (error) {
          if (!(error instanceof ServiceError && error.code === 'NOT_FOUND')) throw error;
        }
      }
      const surviving = new Set(records.map(record => record.entryId));
      const deleted = new Set(frozen.filter(record => !surviving.has(record.entryId)).map(record => record.entryId));
      if (deleted.size) {
        const policy = tx.get('SELECT selected_labels FROM chat_run_policy WHERE run_id=?', [runId]);
        if (policy) {
          const labels = JSON.parse(String(policy.selected_labels)) as PolicyLabel[];
          tx.run('UPDATE chat_run_policy SET selected_labels=? WHERE run_id=?',
            [JSON.stringify(labels.filter(label => label.kind !== 'entry' || !deleted.has(label.id))), runId]);
        }
      }
      return { requestedIds: JSON.parse(String(row.requested_ids)) as string[], records };
    });
  }
  /**
   * After the prompt freezes, keep labels only for the sending session, the
   * parent sessions of included records, the selected history entries and the
   * included record entries. Omitted records and their parents drop out, so a
   * later correction of an omitted-only record does not abort the run.
   */
  #dispatchLabels(accepted: RunSnapshot, labels: PolicyLabel[], frozen: RunSelection | null, trace: ContextTrace): PolicyLabel[] {
    if (!frozen) return labels.filter(s => s.kind === 'session' || trace.selectedHistoryIds.includes(s.id));
    const selectedIds = new Set(trace.selectedSourceIds);
    const included = new Set(frozen.records.filter(r => selectedIds.has(selectedEvidenceId(r.entryId))).map(r => r.entryId));
    const parents = new Set(frozen.records.filter(r => included.has(r.entryId)).map(r => r.sessionId));
    return labels.filter(s => (s.kind === 'session' && (s.id === accepted.sessionId || parents.has(s.id)))
      || (s.kind === 'entry' && (trace.selectedHistoryIds.includes(s.id) || included.has(s.id))));
  }
  async #dispatch(accepted: RunSnapshot, context: DomainContext) {
    const controller = this.#workers.get(accepted.runId);
    if (!controller) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (this.get(accepted.runId, context).state !== 'accepted') return;
      const frozen = this.#readRunContext(accepted.runId, context);
      const acceptedPolicy = this.#checkPolicy(accepted.runId, accepted.sessionId, context);
      const registry = this.#toolRegistry(accepted, context);
      const { request, trace } = assemble(this.#config, accepted.sessionId, accepted.userEntryId, this.#context(context), frozen, this.#readOwnerProfile(accepted.runId), registry);
      if (!this.#config.route.available || !this.#config.route.allows(request.dataClasses) || !this.#config.model) { this.#finish(accepted, context, 'unavailable'); return; }
      const permitted = this.conversation(accepted.sessionId, context).permittedClasses;
      if (request.dataClasses.some(c => !permitted.includes(c))) throw new ContextFailure('unavailable');
      const policy = { ...acceptedPolicy, selectedLabels: this.#dispatchLabels(accepted, acceptedPolicy.selectedLabels, frozen, trace) };
      this.#config.store.transaction(tx => tx.run('UPDATE chat_run_policy SET selected_labels=? WHERE run_id=?', [JSON.stringify(policy.selectedLabels), accepted.runId]));
      this.#livePolicies.set(accepted.runId, { session_id: accepted.sessionId, selected_labels: JSON.stringify(policy.selectedLabels) });
      const run = this.#config.store.transaction(tx => {
        const changed = tx.run("UPDATE chat_runs SET state='dispatch_intent',intent_at=?,trace=?,manifest_hash=?,sequence=sequence+1 WHERE run_id=? AND owner_assistant_id=? AND authority_epoch=? AND state='accepted'",
          [this.#context(context).now, JSON.stringify({ ...trace, policy }), hash(JSON.stringify(trace.manifest)), accepted.runId, context.assistantId, context.authorityEpoch]);
        return changed === 1 ? this.#snapshot(tx, this.#row(tx, accepted.runId, context), context) : null;
      });
      if (!run) return;
      this.#publish(run);
      // Let observers consume intent; intent is never proof of provider send.
      await new Promise<void>(resolve => setImmediate(resolve));
      if (controller.signal.aborted || this.get(run.runId, context).state !== 'dispatch_intent') return;
      this.#checkPolicy(run.runId, run.sessionId, context);
      // One run budget for both phases: acquisition is fenced well inside it so the answer lands.
      const duration = this.#config.deadlineMs ?? 90000;
      const deadlineMs = this.#now() + duration;
      const deadline = new Promise<'deadline'>(resolve => { timeout = setTimeout(() => resolve('deadline'), duration); });
      if (!this.#config.model) throw new ContextFailure('unavailable');
      const generation = this.#generate(run, context, request, registry, { signal: controller.signal, deadlineMs,
        onEvent: event => { if (event.type === 'text') this.#partial(run, context, event.text); } });
      const aborted = new Promise<'aborted'>(resolve => {
        if (controller.signal.aborted) resolve('aborted');
        else controller.signal.addEventListener('abort', () => resolve('aborted'), { once: true });
      });
      const result = await Promise.race([generation, deadline, aborted]);
      if (result === 'aborted') return;
      if (result === 'deadline') { this.#finish(run, context, 'deadline'); controller.abort(); return; }
      const outcome = this.#outcome(result);
      const extras = result.partial === true ? { partial: true as const, notReached: result.notReached ?? [] } : {};
      try { this.#finish(run, context, outcome, result.text, result.dataClass, extras); }
      catch { this.#finish(run, context, 'persistence_failed', result.text); }
    } catch (error) {
      const outcome = error instanceof ContextFailure ? error.outcome : error instanceof ChatError && error.code === 'unavailable' ? 'unavailable' : 'error';
      try { this.#finish(accepted, context, outcome); }
      catch { this.#emit(accepted.runId, { type: 'resync_required', sequence: accepted.sequence, reason: 'storage_unavailable' }); }
    } finally { if (timeout !== undefined) clearTimeout(timeout); this.#workers.delete(accepted.runId); }
  }
  #outcome(result: Pick<ModelResult, 'status' | 'text'>): Outcome { return result.status === 'complete' && !result.text.trim() ? 'empty' : result.status; }
}
