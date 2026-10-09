import { createHash, randomUUID } from 'node:crypto';
import type { DomainContext } from '../contracts/domain.js';
import type { SQLRow, Transaction } from '../contracts/storage.js';
import type { ModelResult } from '../adapters/model/types.js';
import { PROMPT_VERSION } from '../prompt/index.js';
import { assemble, classify, ContextFailure } from './context.js';
import { Subscription } from './subscription.js';
import { ChatError, type AcceptInput, type ChatConfig, type ChatEvent, type ChatPort, type ChatRecoveryContext, type Outcome, type RunSnapshot } from './types.js';
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
    acceptedAt: String(row.accepted_at), intentAt: nullable(row.intent_at), terminalAt: nullable(row.terminal_at) };
}

export class ChatService implements ChatPort {
  #ready = false;
  readonly #config: ChatConfig;
  readonly #now: () => number;
  readonly #workers = new Map<string, AbortController>();
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
    const row = tx.get('SELECT * FROM chat_runs WHERE run_id=?', [runId]);
    if (!row) throw new ChatError('not_found');
    if (row.actor !== context.clientId) throw new ChatError('unauthorized');
    return row;
  }
  #snapshot(tx: Transaction, row: SQLRow, context: DomainContext): RunSnapshot {
    if (row.outcome !== 'complete') return snapshot(row);
    const read = this.#config.domain.execute(tx, 'getSession', { id: String(row.session_id) }, this.#context(context));
    const entry = read.entries.find(item => item.id === row.final_entry_id && item.role === 'assistant');
    if (!entry) throw new ChatError('unavailable');
    return snapshot(row, entry.text);
  }
  recover(context: ChatRecoveryContext): RunSnapshot[] {
    this.#authorizeOwner(context);
    if (this.#workers.size) throw new ChatError('active_run');
    const recovered = this.#config.store.transaction(tx => {
      const rows = tx.all("SELECT * FROM chat_runs WHERE state!='terminal' ORDER BY accepted_at,run_id");
      return rows.map(row => {
        const outcome = row.state === 'accepted' ? 'not_dispatched' : 'outcome_unknown';
        tx.run("UPDATE chat_runs SET state='terminal',outcome=?,terminal_at=?,terminal_epoch=?,sequence=sequence+1 WHERE run_id=? AND authority_epoch=? AND state=?",
          [outcome, new Date(this.#now()).toISOString(), context.authorityEpoch, String(row.run_id), String(row.authority_epoch), String(row.state)]);
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
      const prior = tx.get('SELECT * FROM chat_runs WHERE actor=? AND idempotency_key=?', [context.clientId, input.idempotencyKey]);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new ChatError('idempotency_conflict');
        return { run: this.#snapshot(tx, prior, context), fresh: false };
      }
      const route = this.#config.route;
      if (!route.available || typeof route.provider !== 'string' || !route.provider.trim() || typeof route.model !== 'string' || !route.model.trim()
        || typeof route.allows !== 'function' || typeof this.#config.model?.generate !== 'function') throw new ChatError('unavailable');
      classify(this.#config, { kind: 'session', id: input.sessionId });
      const session = this.#config.domain.execute(tx, 'getSession', { id: input.sessionId }, this.#context(context)).session;
      if (tx.get("SELECT run_id FROM chat_runs WHERE session_id=? AND state!='terminal'", [input.sessionId])) throw new ChatError('active_run');
      if (input.retryOf) {
        const old = this.#row(tx, input.retryOf, context);
        if (old.session_id !== input.sessionId || old.state !== 'terminal') throw new ChatError('invalid_retry');
      }
      const ctx = this.#context(context);
      const entry = this.#config.domain.execute(tx, 'appendEntry', { sessionId: input.sessionId, text: input.text, role: 'user', timeZone: session.timeZone }, ctx);
      const runId = (this.#config.id ?? randomUUID)();
      tx.run(`INSERT INTO chat_runs(run_id,session_id,user_entry_id,actor,idempotency_key,fingerprint,authority_epoch,provider,model,prompt_version,state,retry_of,accepted_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'accepted',?,?)`,
      [runId, input.sessionId, entry.id, context.clientId, input.idempotencyKey, fingerprint, context.authorityEpoch, route.provider, route.model, PROMPT_VERSION, input.retryOf ?? null, ctx.now]);
      return { run: snapshot(tx.get('SELECT * FROM chat_runs WHERE run_id=?', [runId])!), fresh: true };
    });
    if (result.fresh) {
      this.#workers.set(result.run.runId, new AbortController());
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
      if (row.authority_epoch !== context.authorityEpoch) throw new ChatError('epoch_mismatch');
      let entryId: string | null = null;
      if (outcome === 'complete') {
        const session = this.#config.domain.execute(tx, 'getSession', { id: run.sessionId }, this.#context(context)).session;
        const entry = this.#config.domain.execute(tx, 'appendAssistantEntry', { sessionId: run.sessionId, text, timeZone: session.timeZone }, this.#context(context));
        entryId = entry.id;
      }
      const max = this.#config.maxPartialChars ?? 100000;
      const partial = outcome === 'complete' ? '' : text || String(row.partial_text);
      const changed = tx.run(`UPDATE chat_runs SET state='terminal',outcome=?,final_entry_id=?,terminal_at=?,terminal_epoch=?,
        partial_text=?,partial_truncated=?,sequence=sequence+1 WHERE run_id=? AND authority_epoch=? AND state=?`,
        [outcome, entryId, this.#context(context).now, context.authorityEpoch, partial.slice(0, max), Number(partial.length > max || Boolean(row.partial_truncated)), run.runId, context.authorityEpoch, String(row.state)]);
      if (changed !== 1) throw new ChatError('epoch_mismatch');
      return this.#snapshot(tx, tx.get('SELECT * FROM chat_runs WHERE run_id=?', [run.runId])!, context);
    });
    this.#publish(final); return final;
  }
  #partial(run: RunSnapshot, context: DomainContext, text: string) {
    if (!text) return;
    const event = this.#config.store.transaction(tx => {
      const row = this.#row(tx, run.runId, context);
      if (row.state !== 'dispatch_intent' || row.authority_epoch !== context.authorityEpoch) return null;
      const max = this.#config.maxPartialChars ?? 100000;
      const previous = String(row.partial_text);
      const retained = text.slice(0, Math.max(0, max - previous.length));
      tx.run("UPDATE chat_runs SET partial_text=?,partial_truncated=?,sequence=sequence+1 WHERE run_id=? AND authority_epoch=? AND state='dispatch_intent'",
        [previous + retained, Number(Boolean(row.partial_truncated) || retained.length !== text.length), run.runId, context.authorityEpoch]);
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
      const { request, trace } = assemble(this.#config, accepted.sessionId, accepted.userEntryId, this.#context(context));
      if (!this.#config.route.available || !this.#config.route.allows(request.dataClasses)) { this.#finish(accepted, context, 'unavailable'); return; }
      const run = this.#config.store.transaction(tx => {
        const changed = tx.run("UPDATE chat_runs SET state='dispatch_intent',intent_at=?,trace=?,manifest_hash=?,sequence=sequence+1 WHERE run_id=? AND authority_epoch=? AND state='accepted'",
          [this.#context(context).now, JSON.stringify(trace), hash(JSON.stringify(trace.manifest)), accepted.runId, context.authorityEpoch]);
        return changed === 1 ? snapshot(this.#row(tx, accepted.runId, context)) : null;
      });
      if (!run) return;
      this.#publish(run);
      // Let observers consume intent; intent is never proof of provider send.
      await new Promise<void>(resolve => setImmediate(resolve));
      if (controller.signal.aborted || this.get(run.runId, context).state !== 'dispatch_intent') return;
      const duration = this.#config.deadlineMs ?? 60000;
      const deadlineMs = this.#now() + duration;
      const deadline = new Promise<'deadline'>(resolve => { timeout = setTimeout(() => resolve('deadline'), duration); });
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
