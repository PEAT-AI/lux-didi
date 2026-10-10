import { createHash, randomUUID } from 'node:crypto';
import type { DomainContext, RoutingLabelCorrection, RoutingSubject } from '../contracts/domain.js';
import type { SQLRow, Transaction } from '../contracts/storage.js';
import type { ModelResult } from '../adapters/model/types.js';
import { PROMPT_VERSION } from '../prompt/index.js';
import { assemble, classify, ContextFailure } from './context.js';
import { Subscription } from './subscription.js';
import { ChatError, type AcceptInput, type ChatConfig, type ChatEvent, type ChatPort, type ChatRecoveryContext, type Outcome, type RunSnapshot, type EnrollInput, type ConversationStatus } from './types.js';
export * from './types.js';
export { chatMigrations } from './schema.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function nullable(value: SQLRow[string] | undefined) { return value === null || value === undefined ? null : String(value); }
function snapshot(row: SQLRow, finalText: string | null = null): RunSnapshot {
  return { runId: String(row.run_id), sessionId: String(row.session_id), userEntryId: String(row.user_entry_id),
    finalEntryId: nullable(row.final_entry_id), finalText, retryOf: nullable(row.retry_of), authorityEpoch: String(row.authority_epoch),
    provider: String(row.provider), model: String(row.model), promptVersion: String(row.prompt_version),
    state: row.state as RunSnapshot['state'], outcome: nullable(row.outcome) as Outcome | null,
    sequence: Number(row.sequence), partialText: String(row.partial_text), partialTruncated: Boolean(row.partial_truncated),
    acceptedAt: String(row.accepted_at), intentAt: nullable(row.intent_at), terminalAt: nullable(row.terminal_at), mayHaveBeenSent: row.intent_at !== null,
    memorySelection: null };
}

export class ChatService implements ChatPort {
  #ready = false;
  readonly #config: ChatConfig;
  readonly #now: () => number;
  readonly #workers = new Map<string, AbortController>();
  readonly #livePolicies = new Map<string, { session_id: string; selected_labels: string }>();
  readonly #subscribers = new Map<string, Set<Subscription>>();
  constructor(config: ChatConfig) {
    if (!Number.isFinite(config.deadlineMs ?? 60000) || (config.deadlineMs ?? 60000) <= 0
      || !Number.isSafeInteger(config.subscriberCapacity ?? 16) || (config.subscriberCapacity ?? 16) < 1
      || !Number.isSafeInteger(config.maxPartialChars ?? 100000) || (config.maxPartialChars ?? 100000) < 1) throw new ChatError('invalid_input');
    this.#config = { ...config, route: { ...config.route }, context: structuredClone(config.context) };
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
  #row(tx: Transaction, runId: string, context: DomainContext) {
    const row = tx.get('SELECT * FROM chat_runs WHERE run_id=? AND owner_assistant_id=?', [runId, context.assistantId]);
    if (!row) throw new ChatError('not_found');
    return row;
  }
  #snapshot(tx: Transaction, row: SQLRow, context: DomainContext): RunSnapshot {
    if (row.outcome !== 'complete') return snapshot(row);
    const read = this.#config.domain.execute(tx, 'getSession', { id: String(row.session_id) }, this.#context(context));
    const entry = read.entries.find(item => item.id === row.final_entry_id && item.role === 'assistant');
    if (!entry) throw new ChatError('unavailable');
    return snapshot(row, entry.text);
  }
  #identity() {
    const route = this.#config.route;
    return JSON.stringify({ version: 1, provider: route.provider, model: route.model,
      endpoint: route.endpoint, apiVersion: route.apiVersion, keyReference: route.keyReference,
      allowedClasses: [...route.allowedClasses].sort(), policyVersion: 1 });
  }
  #consent(tx: Transaction, sessionId: string, context: DomainContext) {
    const row = tx.get('SELECT * FROM chat_consents WHERE session_id=? AND owner_assistant_id=?', [sessionId, context.assistantId]);
    if (!row) throw new ChatError('consent_required');
    return row;
  }
  #conversation(row: SQLRow): ConversationStatus {
    return { sessionId: String(row.session_id), provider: String(row.provider), model: String(row.model),
      latestRunId: null, revision: Number(row.revision), permittedClasses: JSON.parse(String(row.permitted_classes)),
      state: row.revoked_at !== null ? 'revoked' : row.route_identity !== this.#identity() ? 'route_changed' : 'active' };
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
    const fingerprint = hash(JSON.stringify({ title: input.title, timeZone: input.timeZone }));
    return this.#config.store.transaction(tx => {
      const prior = tx.get('SELECT * FROM chat_consents WHERE owner_assistant_id=? AND idempotency_key=?', [context.assistantId, input.idempotencyKey]);
      if (prior) { if (prior.fingerprint !== fingerprint) throw new ChatError('idempotency_conflict'); return this.#conversation(prior); }
      const route = this.#config.route;
      if (!route.available || !route.allows(['private'])) throw new ChatError('unavailable');
      const session = this.#config.domain.execute(tx, 'createSession', { title: input.title, timeZone: input.timeZone }, this.#context(context), { writer: 'capture', dataClass: 'private' });
      const permitted = (['ordinary', 'private'] as const).filter(c => route.allowedClasses.includes(c));
      tx.run(`INSERT INTO chat_consents VALUES (?,?,?,?,?,1,?,?,NULL,?,?)`,
        [session.id, context.assistantId, route.provider, route.model, this.#identity(), JSON.stringify(permitted), this.#context(context).now, input.idempotencyKey, fingerprint]);
      return this.#conversation(this.#consent(tx, session.id, context));
    });
  }
  conversation(sessionId: string, context: DomainContext): ConversationStatus {
    this.#authorize(context);
    return this.#config.store.transaction(tx => ({ ...this.#conversation(this.#consent(tx, sessionId, context)), latestRunId: nullable(tx.get('SELECT run_id FROM chat_runs WHERE session_id=? AND owner_assistant_id=? ORDER BY accepted_at DESC,rowid DESC LIMIT 1', [sessionId, context.assistantId])?.run_id) }));
  }
  #labels(tx: Transaction, sessionId: string, context: DomainContext) {
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
      if (row.revoked_at === null) tx.run('UPDATE chat_consents SET revision=revision+1,revoked_at=? WHERE session_id=? AND owner_assistant_id=?', [this.#context(context).now, sessionId, context.assistantId]);
      return this.#conversation(this.#consent(tx, sessionId, context));
    });
    this.#invalidate(row => row.session_id === sessionId, context);
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
      || Object.keys(input).some(key => !['sessionId', 'text', 'idempotencyKey', 'retryOf'].includes(key))
      || (input.retryOf !== undefined && (typeof input.retryOf !== 'string' || !input.retryOf.trim()))) throw new ChatError('invalid_input');
    const fingerprint = hash(JSON.stringify({ sessionId: input.sessionId, text: input.text, retryOf: input.retryOf ?? null }));
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
      const session = this.#config.domain.execute(tx, 'getSession', { id: input.sessionId }, this.#context(context)).session;
      if (tx.get("SELECT run_id FROM chat_runs WHERE session_id=? AND state!='terminal'", [input.sessionId])) throw new ChatError('active_run');
      if (input.retryOf) {
        const old = this.#row(tx, input.retryOf, context);
        if (old.session_id !== input.sessionId || old.state !== 'terminal') throw new ChatError('invalid_retry');
      }
      const ctx = this.#context(context);
      const entry = this.#config.domain.execute(tx, 'appendEntry', { sessionId: input.sessionId, text: input.text, role: 'user', timeZone: session.timeZone }, ctx, { writer: 'capture', dataClass: 'private' });
      const runId = (this.#config.id ?? randomUUID)();
      tx.run(`INSERT INTO chat_runs(run_id,session_id,user_entry_id,owner_assistant_id,accepting_client_id,idempotency_key,fingerprint,authority_epoch,provider,model,prompt_version,state,retry_of,accepted_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'accepted',?,?)`,
      [runId, input.sessionId, entry.id, context.assistantId, context.clientId, input.idempotencyKey, fingerprint, context.authorityEpoch, route.provider, route.model, PROMPT_VERSION, input.retryOf ?? null, ctx.now]);
      labels.push({ kind: 'entry', id: entry.id, ...classify(this.#config, { kind: 'entry', id: entry.id }, tx), revision: this.#config.classify({ kind: 'entry', id: entry.id }, tx)!.revision });
      tx.run('INSERT INTO chat_run_policy VALUES (?,1,?,?,?)', [runId, Number(consent.revision), this.#identity(), JSON.stringify(labels)]);
      return { run: snapshot(tx.get('SELECT * FROM chat_runs WHERE run_id=?', [runId])!), fresh: true, policy: JSON.stringify(labels) };
    });
    if (result.fresh) {
      this.#workers.set(result.run.runId, new AbortController());
      this.#livePolicies.set(result.run.runId, { session_id: result.run.sessionId, selected_labels: result.policy });
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
    const listeners = this.#subscribers.get(runId) ?? new Set<Subscription>();
    if (listeners.size >= 32) throw new ChatError('unavailable');
    const subscription = new Subscription(this.#config.subscriberCapacity ?? 16, () => {
      listeners.delete(subscription); if (!listeners.size) this.#subscribers.delete(runId);
    });
    listeners.add(subscription); this.#subscribers.set(runId, listeners);
    subscription.push({ type: 'snapshot', sequence: run.sequence, run });
    if (run.state === 'terminal') subscription.close();
    return subscription;
  }
  #emit(runId: string, event: ChatEvent) {
    // Copy: overflow/terminal detaches while delivering.
    for (const subscriber of [...(this.#subscribers.get(runId) ?? [])]) {
      subscriber.push(event);
      if ((event.type === 'snapshot' && event.run.state === 'terminal') || event.type === 'resync_required') subscriber.close();
    }
  }
  #publish(run: RunSnapshot) { this.#emit(run.runId, { type: 'snapshot', sequence: run.sequence, run }); }
  #finish(run: RunSnapshot, context: DomainContext, outcome: Outcome, text = ''): RunSnapshot {
    this.#authorize(context);
    const final = this.#config.store.transaction(tx => {
      const row = this.#row(tx, run.runId, context);
      if (row.state === 'terminal') return this.#snapshot(tx, row, context);
      let entryId: string | null = null;
      if (outcome === 'complete') {
        const session = this.#config.domain.execute(tx, 'getSession', { id: run.sessionId }, this.#context(context)).session;
        const entry = this.#config.domain.execute(tx, 'appendAssistantEntry', { sessionId: run.sessionId, text, timeZone: session.timeZone }, this.#context(context), { writer: 'model', dataClass: 'private' });
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
    this.#publish(final); return final;
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
  async #dispatch(accepted: RunSnapshot, context: DomainContext) {
    const controller = this.#workers.get(accepted.runId);
    if (!controller) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (this.get(accepted.runId, context).state !== 'accepted') return;
      const acceptedPolicy = this.#checkPolicy(accepted.runId, accepted.sessionId, context);
      const { request, trace } = assemble(this.#config, accepted.sessionId, accepted.userEntryId, this.#context(context));
      if (!this.#config.route.available || !this.#config.route.allows(request.dataClasses) || !this.#config.model) { this.#finish(accepted, context, 'unavailable'); return; }
      const permitted = this.conversation(accepted.sessionId, context).permittedClasses;
      if (request.dataClasses.some(c => !permitted.includes(c))) throw new ContextFailure('unavailable');
      const policy = { ...acceptedPolicy, selectedLabels: acceptedPolicy.selectedLabels.filter(s => s.kind === 'session' || trace.selectedHistoryIds.includes(s.id)) };
      this.#config.store.transaction(tx => tx.run('UPDATE chat_run_policy SET selected_labels=? WHERE run_id=?', [JSON.stringify(policy.selectedLabels), accepted.runId]));
      this.#livePolicies.set(accepted.runId, { session_id: accepted.sessionId, selected_labels: JSON.stringify(policy.selectedLabels) });
      const run = this.#config.store.transaction(tx => {
        const changed = tx.run("UPDATE chat_runs SET state='dispatch_intent',intent_at=?,trace=?,manifest_hash=?,sequence=sequence+1 WHERE run_id=? AND owner_assistant_id=? AND authority_epoch=? AND state='accepted'",
          [this.#context(context).now, JSON.stringify({ ...trace, policy }), hash(JSON.stringify(trace.manifest)), accepted.runId, context.assistantId, context.authorityEpoch]);
        return changed === 1 ? snapshot(this.#row(tx, accepted.runId, context)) : null;
      });
      if (!run) return;
      this.#publish(run);
      // Let observers consume intent; intent is never proof of provider send.
      await new Promise<void>(resolve => setImmediate(resolve));
      if (controller.signal.aborted || this.get(run.runId, context).state !== 'dispatch_intent') return;
      this.#checkPolicy(run.runId, run.sessionId, context);
      const duration = this.#config.deadlineMs ?? 60000;
      const deadlineMs = this.#now() + duration;
      const deadline = new Promise<'deadline'>(resolve => { timeout = setTimeout(() => resolve('deadline'), duration); });
      if (!this.#config.model) throw new ContextFailure('unavailable');
      const generation = this.#config.model.generate(request, { signal: controller.signal, deadlineMs,
        onEvent: event => { if (event.type === 'text') this.#partial(run, context, event.text); } });
      const aborted = new Promise<'aborted'>(resolve => {
        if (controller.signal.aborted) resolve('aborted');
        else controller.signal.addEventListener('abort', () => resolve('aborted'), { once: true });
      });
      const result = await Promise.race([generation, deadline, aborted]);
      if (result === 'aborted') return;
      if (result === 'deadline') { this.#finish(run, context, 'deadline'); controller.abort(); return; }
      const outcome = this.#outcome(result);
      try { this.#finish(run, context, outcome, result.text); }
      catch { this.#finish(run, context, 'persistence_failed', result.text); }
    } catch (error) {
      const outcome = error instanceof ContextFailure ? error.outcome : error instanceof ChatError && error.code === 'unavailable' ? 'unavailable' : 'error';
      try { this.#finish(accepted, context, outcome); }
      catch { this.#emit(accepted.runId, { type: 'resync_required', sequence: accepted.sequence, reason: 'storage_unavailable' }); }
    } finally { if (timeout !== undefined) clearTimeout(timeout); this.#workers.delete(accepted.runId); }
  }
  #outcome(result: ModelResult): Outcome { return result.status === 'complete' && !result.text.trim() ? 'empty' : result.status; }
}
