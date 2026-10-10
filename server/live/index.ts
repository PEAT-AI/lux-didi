import { createHash, randomUUID } from 'node:crypto';
import type { DataClass, LiveVoiceEvent, LiveVoiceOutcome, LiveVoicePort, LiveVoiceSession } from '../adapters/live-voice/index.js';
import type { SQLRow, Transaction } from '../contracts/storage.js';
import { liveProfileIdentity, validateLiveProfile } from './config.js';
import { parseTerminal, persistedKinds, readFragmentPage, retainedBytes } from './journal.js';
import {
  LiveError,
  type CreateLiveSession, type JournalKind, type LiveAttachment, type LiveConsumerState, type LiveContext,
  type LiveFragmentPage, type LiveInvalidationReason, type LiveOutputChunk, type LiveOwnerConfig,
  type LiveProfile, type LiveProfileProjection, type LivePublicMarker, type LiveSessionSnapshot, type LiveStorePort,
  type LiveTerminalOutcome,
} from './types.js';

interface ActiveSession {
  liveSessionId: string;
  session: LiveVoiceSession;
  abort: AbortController;
  revision: number;
  inputClass: DataClass;
  ready: boolean;
  invalidated: boolean;
  terminal: boolean;
  consumer: OutputChannel;
  consumerState: LiveConsumerState;
  journalEvents: number;
  journalBytes: number;
  adapterOutcome: LiveVoiceOutcome | undefined;
  loopDone: { promise: Promise<void>; resolve: () => void };
  done: { promise: Promise<LiveSessionSnapshot>; resolve: (value: LiveSessionSnapshot) => void; reject: (error: unknown) => void };
  resolveDone: () => void;
  persistFailure: unknown;
}

export { liveMigrations } from './schema.js';
export * from './types.js';
export { liveProfileIdentity, validateLiveProfile, defaultLiveLimits } from './config.js';

const keyPattern = /^[A-Za-z0-9_.:-]{1,128}$/;
const classes: readonly DataClass[] = ['ordinary', 'private', 'sensitive'];
const maxPage = 500;

function identity(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function journalKind(type: string): JournalKind | null { return (persistedKinds as readonly string[]).includes(type) ? type as JournalKind : null; }
function markerOf(event: LiveVoiceEvent, kind: JournalKind, journalSequence: number): LivePublicMarker {
  return {
    kind, sequence: event.sequence, journalSequence,
    text: 'text' in event ? event.text : null,
    finished: 'finished' in event && event.finished !== undefined ? event.finished : null,
    value: event.type === 'waitingForInput' ? event.value : null,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
/** Bounded single-consumer output channel: ephemeral PCM plus committed public markers, in order. */
class OutputChannel {
  #queue: LiveOutputChunk[] = [];
  #bytes = 0;
  #waiter: ((result: IteratorResult<LiveOutputChunk>) => void) | undefined;
  #closed = false;
  constructor(private readonly maxEvents: number, private readonly maxBytes: number) {}
  push(chunk: LiveOutputChunk): 'ok' | 'backpressure' {
    if (this.#closed) return 'ok';
    const size = chunk.kind === 'audio' ? chunk.pcm.length : 0;
    if (this.#queue.length + 1 > this.maxEvents || this.#bytes + size > this.maxBytes) return 'backpressure';
    const waiter = this.#waiter;
    if (waiter) { this.#waiter = undefined; waiter({ value: chunk, done: false }); return 'ok'; }
    this.#queue.push(chunk); this.#bytes += size; return 'ok';
  }
  /** Graceful end: already queued committed markers are still delivered, then done. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#queue.length) return;
    const waiter = this.#waiter; this.#waiter = undefined;
    waiter?.({ value: undefined, done: true });
  }
  /** Immediate end for detach/shutdown: drop anything still queued. */
  discard(): void {
    if (this.#closed) return;
    this.#closed = true; this.#queue = []; this.#bytes = 0;
    const waiter = this.#waiter; this.#waiter = undefined;
    waiter?.({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<LiveOutputChunk> {
    return {
      next: () => this.#next(),
      return: () => { this.discard(); return Promise.resolve({ value: undefined, done: true }); },
    };
  }
  #next(): Promise<IteratorResult<LiveOutputChunk>> {
    const item = this.#queue.shift();
    if (item) { this.#bytes -= item.kind === 'audio' ? item.pcm.length : 0; return Promise.resolve({ value: item, done: false }); }
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise(resolve => { this.#waiter = resolve; });
  }
}

export class LiveSessionOwner {
  readonly #store: LiveStorePort;
  readonly #voice: LiveVoicePort;
  readonly #profile: LiveProfile;
  readonly #now: () => number;
  readonly #profileIdentity: string;
  readonly #promptIdentity: string;
  readonly #active = new Map<string, ActiveSession>();
  #revision = 1;
  #invalidated = false;
  #closed = false;

  constructor(config: LiveOwnerConfig) {
    if (!config || typeof config !== 'object' || !config.store || !config.voice) throw new LiveError('invalid_config');
    this.#store = config.store;
    this.#voice = config.voice;
    this.#profile = validateLiveProfile(config.profile);
    this.#now = config.now ?? Date.now;
    this.#profileIdentity = liveProfileIdentity(this.#profile);
    this.#promptIdentity = identity({ text: this.#profile.prompt.text, dataClass: this.#profile.prompt.dataClass });
    this.recover();
  }

  get revision(): number { return this.#revision; }

  /** Safe operator-visible identity. Never carries key bytes or prompt text. */
  get profileIdentity(): string { return this.#profileIdentity; }
  profileProjection(): LiveProfileProjection {
    return {
      provider: this.#profile.provider, model: this.#profile.liveModelId, voice: this.#profile.voice,
      dataClasses: this.#profile.route.dataClasses, profileIdentity: this.#profileIdentity,
    };
  }

  /** Startup sweep: no intent means no possible egress; an intent means possible egress. */
  recover(): number {
    const now = this.#now();
    return this.#store.transaction(tx => {
      const rows = tx.all("SELECT live_session_id, dispatch_intent FROM live_sessions WHERE lifecycle IN ('accepted','opening','active')");
      for (const row of rows) {
        const outcome: LiveTerminalOutcome = Number(row['dispatch_intent']) === 1 ? { state: 'outcome_unknown' } : { state: 'not_started' };
        this.#terminalInTx(tx, String(row['live_session_id']), outcome, false, now, 'ended', null);
      }
      return rows.length;
    });
  }

  create(input: CreateLiveSession, context: LiveContext): LiveSessionSnapshot {
    this.#guardOpen();
    if (!input || typeof input !== 'object' || typeof input.idempotencyKey !== 'string' || !keyPattern.test(input.idempotencyKey)) throw new LiveError('invalid_request');
    this.#contextShape(context);
    const fingerprint = identity({ inputClass: input.inputClass, profile: this.#profileIdentity, prompt: this.#promptIdentity });
    const now = this.#now();
    const assistantId = this.#store.assistantId;
    return this.#store.transaction(tx => {
      // Same-key replay is decided on the normalized request meaning before any policy.
      const prior = tx.get('SELECT * FROM live_sessions WHERE owner_assistant_id=? AND idempotency_key=?', [assistantId, input.idempotencyKey]);
      if (prior) {
        if (String(prior['fingerprint']) !== fingerprint) throw new LiveError('idempotency_conflict');
        return this.#snapshot(tx, prior);
      }
      if (context.authorityEpoch !== this.#store.authorityEpoch) throw new LiveError('stale_authority');
      if (!classes.includes(input.inputClass) || !this.#profile.route.dataClasses.includes(input.inputClass)) throw new LiveError('invalid_request');
      const liveSessionId = randomUUID();
      tx.run('INSERT INTO live_sessions(live_session_id, owner_assistant_id, authority_epoch, idempotency_key, fingerprint, client_id, audit_id, profile_identity, prompt_identity, lifecycle, dispatch_intent, ready, journal_events, journal_bytes, journal_complete, consumer_state, terminal_outcome, terminal_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,0,0,?,NULL,NULL,?,?)',
        [liveSessionId, assistantId, context.authorityEpoch, input.idempotencyKey, fingerprint, context.clientId, context.auditId, this.#profileIdentity, this.#promptIdentity, 'accepted', 'detached', now, now]);
      tx.run('INSERT INTO live_grants(grant_id, live_session_id, provider, model, voice, key_reference, permitted_classes, chosen_input_class, revision, granted_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [randomUUID(), liveSessionId, 'gemini', this.#profile.liveModelId, this.#profile.voice, this.#profile.keyReference,
          JSON.stringify(this.#profile.route.dataClasses), input.inputClass, this.#revision, now]);
      return this.#snapshot(tx, tx.get('SELECT * FROM live_sessions WHERE live_session_id=?', [liveSessionId])!);
    });
  }

  get(liveSessionId: string): LiveSessionSnapshot {
    this.#guardOpen();
    return this.#store.transaction(tx => {
      const row = tx.get('SELECT * FROM live_sessions WHERE live_session_id=? AND owner_assistant_id=?', [liveSessionId, this.#store.assistantId]);
      if (!row) throw new LiveError('not_found');
      return this.#snapshot(tx, row);
    });
  }

  listFragments(query: { liveSessionId: string; cursor?: number; limit?: number }): LiveFragmentPage {
    this.#guardOpen();
    if (!query || typeof query.liveSessionId !== 'string') throw new LiveError('invalid_request');
    const cursor = query.cursor === undefined ? 0 : query.cursor;
    const limit = query.limit === undefined ? 100 : query.limit;
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new LiveError('invalid_request');
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > maxPage) throw new LiveError('invalid_request');
    return this.#store.transaction(tx => {
      const row = tx.get('SELECT live_session_id FROM live_sessions WHERE live_session_id=? AND owner_assistant_id=?', [query.liveSessionId, this.#store.assistantId]);
      if (!row) throw new LiveError('not_found');
      return readFragmentPage(tx, query.liveSessionId, cursor, limit);
    });
  }

  attach(input: { liveSessionId: string }, context: LiveContext): LiveAttachment {
    this.#guardOpen();
    if (!input || typeof input.liveSessionId !== 'string') throw new LiveError('invalid_request');
    this.#authorize(context);
    if (this.#invalidated) throw new LiveError('invalidated');
    const revision = this.#revision;
    const now = this.#now();
    const prepared = this.#store.transaction(tx => {
      const row = tx.get('SELECT * FROM live_sessions WHERE live_session_id=? AND owner_assistant_id=?', [input.liveSessionId, this.#store.assistantId]);
      if (!row) throw new LiveError('not_found');
      if (String(row['profile_identity']) !== this.#profileIdentity || String(row['prompt_identity']) !== this.#promptIdentity) throw new LiveError('invalidated');
      if (String(row['lifecycle']) === 'terminal') throw new LiveError('terminal');
      if (String(row['lifecycle']) !== 'accepted') throw new LiveError('already_attached');
      if (now - Number(row['created_at']) > this.#profile.limits.unusedMs) {
        this.#terminalInTx(tx, input.liveSessionId, { state: 'expired' }, false, now, 'detached', null);
        return 'expired' as const;
      }
      tx.run("UPDATE live_sessions SET lifecycle='opening', dispatch_intent=1, consumer_state='attached', updated_at=? WHERE live_session_id=?", [now, input.liveSessionId]);
      const grant = tx.get('SELECT chosen_input_class FROM live_grants WHERE live_session_id=?', [input.liveSessionId])!;
      return String(grant['chosen_input_class']) as DataClass;
    });
    if (prepared === 'expired') throw new LiveError('expired');
    return this.#open(input.liveSessionId, prepared, revision);
  }

  /** Explicit host entry point: synchronous in-memory invalidation and adapter abort. */
  invalidate(reason: LiveInvalidationReason): void {
    if (reason !== 'revoked' && reason !== 'authority' && reason !== 'profile') throw new LiveError('invalid_request');
    this.#invalidated = true;
    this.#revision += 1;
    for (const handle of [...this.#active.values()]) {
      handle.invalidated = true;
      if (!handle.terminal) this.#settle(handle, { state: 'revoked' }, false, 'ended', null);
      else handle.consumer?.close();
      handle.abort.abort();
    }
  }

  /** Targeted termination: ends exactly this session/grant durably; other sessions unaffected. */
  revoke(liveSessionId: string): void {
    if (typeof liveSessionId !== 'string' || !liveSessionId) throw new LiveError('invalid_request');
    const handle = this.#active.get(liveSessionId);
    if (!handle) {
      this.#store.transaction(tx => {
        const row = tx.get('SELECT lifecycle FROM live_sessions WHERE live_session_id=? AND owner_assistant_id=?', [liveSessionId, this.#store.assistantId]);
        if (!row) throw new LiveError('not_found');
        if (String(row['lifecycle']) !== 'terminal') this.#terminalInTx(tx, liveSessionId, { state: 'revoked' }, false, this.#now(), 'detached', null);
      });
      return;
    }
    handle.invalidated = true;
    if (!handle.terminal) this.#settle(handle, { state: 'revoked' }, false, 'ended', null);
    else handle.consumer?.close();
    handle.abort.abort();
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const handles = [...this.#active.values()];
    for (const handle of handles) {
      handle.consumer?.discard();
      handle.session.close();
    }
    await Promise.all(handles.map(handle => handle.loopDone.promise));
    for (const handle of handles) handle.resolveDone();
  }

  #open(liveSessionId: string, inputClass: DataClass, revision: number): LiveAttachment {
    const abort = new AbortController();
    const request = { system: { text: this.#profile.prompt.text, dataClass: this.#profile.prompt.dataClass }, history: [], dataClasses: [inputClass] };
    let session: LiveVoiceSession;
    try {
      // Absolute wall clock for the adapter; the injected clock is the owner's own durable order.
      session = this.#voice.open(request, { signal: abort.signal, deadlineMs: Date.now() + this.#profile.limits.sessionMs });
    } catch (error) {
      this.#store.transaction(tx => this.#terminalInTx(tx, liveSessionId, { state: 'not_started' }, false, this.#now(), 'ended', null));
      throw error;
    }
    this.#store.transaction(tx => tx.run("UPDATE live_sessions SET lifecycle='active', updated_at=? WHERE live_session_id=?", [this.#now(), liveSessionId]));
    const handle: ActiveSession = {
      liveSessionId, session, abort, revision, inputClass, ready: false, invalidated: false, terminal: false,
      consumer: new OutputChannel(this.#profile.limits.consumerQueueEvents, this.#profile.limits.consumerQueueBytes),
      consumerState: 'attached', journalEvents: 0, journalBytes: 0, adapterOutcome: undefined,
      loopDone: deferred<void>(), done: deferred<LiveSessionSnapshot>(), resolveDone: () => {}, persistFailure: undefined,
    };
    handle.resolveDone = () => {
      try { handle.done.resolve(this.#readSnapshot(liveSessionId)); }
      catch (error) { handle.done.reject(error); }
    };
    session.ready.then(() => { handle.ready = true; }, () => {});
    session.done.catch(() => {});
    this.#active.set(liveSessionId, handle);
    void handle.done.promise.catch(() => {});
    void this.#consume(handle);
    const ready = session.ready.then(() => this.#readSnapshot(liveSessionId));
    void ready.catch(() => {});
    return {
      liveSessionId,
      ready,
      output: handle.consumer,
      done: handle.done.promise,
      sendAudio: ({ pcm }) => this.#sendAudio(handle, pcm),
      endAudioStream: () => { this.#guardHandle(handle); handle.session.endAudioStream(); },
      close: () => { handle.session.close(); },
      detach: () => this.#detach(handle),
      overflow: () => {
        if (handle.terminal) return;
        handle.consumerState = 'backpressure';
        this.#settle(handle, { state: 'consumer_backpressure' }, false, 'backpressure', null);
      },
    };
  }

  #sendAudio(handle: ActiveSession, pcm: Uint8Array): void {
    this.#guardHandle(handle);
    if (!(pcm instanceof Uint8Array) || !pcm.length || pcm.length % 2 !== 0) throw new LiveError('invalid_audio');
    handle.session.sendAudio({ pcm, dataClass: handle.inputClass });
  }

  /** Ordered output admission. Overflow is settled as a durable fact, never silently shed. */
  #pushChunk(handle: ActiveSession, chunk: LiveOutputChunk): void {
    if (handle.consumerState !== 'attached') return;
    if (handle.consumer?.push(chunk) === 'backpressure') {
      handle.consumerState = 'backpressure';
      this.#settle(handle, { state: 'consumer_backpressure' }, false, 'backpressure', null);
    }
  }

  #guardHandle(handle: ActiveSession): void {
    if (handle.invalidated || this.#invalidated || this.#revision !== handle.revision) throw new LiveError('invalidated');
    if (handle.terminal) throw new LiveError('terminal');
    if (!handle.ready) throw new LiveError('not_ready');
  }

  #detach(handle: ActiveSession): void {
    if (handle.consumerState !== 'attached') return;
    handle.consumerState = 'ended';
    handle.consumer?.discard();
    try { this.#store.transaction(tx => tx.run("UPDATE live_sessions SET consumer_state='ended', updated_at=? WHERE live_session_id=?", [this.#now(), handle.liveSessionId])); }
    catch { /* detach is best-effort; the store may already be closing */ }
  }

  async #consume(handle: ActiveSession): Promise<void> {
    try {
      for await (const event of handle.session.events) {
        if (this.#settled(handle)) break;
        if (event.type === 'audio') { this.#pushChunk(handle, { kind: 'audio', pcm: event.pcm }); continue; }
        if (event.type === 'outcome') { handle.adapterOutcome = event.outcome; continue; }
        const kind = journalKind(event.type);
        if (kind === null) continue;
        const persisted = this.#persist(handle, event, kind);
        if (persisted === 'overflow') {
          this.#settle(handle, { state: 'journal_limit' }, false, 'ended', { kind, sequence: event.sequence });
          break;
        }
        this.#pushChunk(handle, { kind: 'marker', marker: markerOf(event, kind, persisted) });
      }
    } catch (error) { handle.persistFailure = error; }
    if (!handle.terminal) {
      if (handle.persistFailure) { handle.abort.abort(); handle.done.reject(handle.persistFailure); }
      else {
        const outcome = handle.adapterOutcome ?? await handle.session.done.catch(() => undefined);
        if (outcome) this.#settle(handle, { state: outcome.status, code: outcome.code }, outcome.status === 'closed', 'ended', null);
        else this.#settle(handle, { state: 'outcome_unknown' }, false, 'ended', null);
      }
    }
    this.#active.delete(handle.liveSessionId);
    handle.loopDone.resolve();
  }

  #persist(handle: ActiveSession, event: LiveVoiceEvent, kind: JournalKind): number | 'overflow' {
    const text = 'text' in event ? event.text : null;
    const finished = 'finished' in event && event.finished !== undefined ? (event.finished ? 1 : 0) : null;
    const value = event.type === 'waitingForInput' ? (event.value ? 1 : 0) : null;
    const bytes = retainedBytes(kind, text);
    const limits = this.#profile.limits;
    if (handle.journalEvents + 1 > limits.journalMaxEvents || handle.journalBytes + bytes > limits.journalMaxBytes) return 'overflow';
    const now = this.#now();
    const events = handle.journalEvents + 1;
    const total = handle.journalBytes + bytes;
    const journalSequence = this.#store.transaction(tx => {
      tx.run('INSERT INTO live_journal(live_session_id, provider_sequence, kind, text, finished, value, terminal_outcome, rejected_kind, rejected_sequence, payload_bytes, arrived_at) VALUES (?,?,?,?,?,?,NULL,NULL,NULL,?,?)',
        [handle.liveSessionId, event.sequence, kind, text, finished, value, bytes, now]);
      tx.run('UPDATE live_sessions SET journal_events=?, journal_bytes=?, ready=CASE WHEN ?=1 THEN 1 ELSE ready END, updated_at=? WHERE live_session_id=?',
        [events, total, kind === 'ready' ? 1 : 0, now, handle.liveSessionId]);
      return Number(tx.get('SELECT journal_id FROM live_journal WHERE live_session_id=? ORDER BY journal_id DESC LIMIT 1', [handle.liveSessionId])!['journal_id']);
    });
    handle.journalEvents = events;
    handle.journalBytes = total;
    return journalSequence;
  }

  #settled(handle: ActiveSession): boolean { return handle.terminal || handle.invalidated; }

  #settle(handle: ActiveSession, outcome: LiveTerminalOutcome, complete: boolean, consumerState: LiveConsumerState, rejected: { kind: JournalKind; sequence: number } | null): void {
    if (handle.terminal) return;
    handle.terminal = true;
    let journalSequence: number;
    try {
      journalSequence = this.#store.transaction(tx => this.#terminalInTx(tx, handle.liveSessionId, outcome, complete, this.#now(), consumerState, rejected));
    } catch (error) {
      handle.persistFailure = error;
      handle.consumer?.close();
      handle.abort.abort();
      handle.done.reject(error);
      return;
    }
    // The terminal fact is durable before it is emitted; committed markers stay queued on overflow.
    this.#pushChunk(handle, { kind: 'marker', marker: { kind: 'terminal', sequence: null, journalSequence, text: null, finished: null, value: null } });
    handle.consumer?.close();
    handle.abort.abort();
    handle.resolveDone();
  }

  #terminalInTx(tx: Transaction, liveSessionId: string, outcome: LiveTerminalOutcome, complete: boolean, now: number, consumerState: LiveConsumerState, rejected: { kind: JournalKind; sequence: number } | null): number {
    tx.run('INSERT INTO live_journal(live_session_id, provider_sequence, kind, text, finished, value, terminal_outcome, rejected_kind, rejected_sequence, payload_bytes, arrived_at) VALUES (?,NULL,?,NULL,NULL,NULL,?,?,?,0,?)',
      [liveSessionId, 'terminal', JSON.stringify(outcome), rejected?.kind ?? null, rejected?.sequence ?? null, now]);
    tx.run("UPDATE live_sessions SET lifecycle='terminal', journal_complete=?, terminal_outcome=?, terminal_at=?, consumer_state=?, updated_at=? WHERE live_session_id=?",
      [complete ? 1 : 0, JSON.stringify(outcome), now, consumerState, now, liveSessionId]);
    return Number(tx.get('SELECT journal_id FROM live_journal WHERE live_session_id=? ORDER BY journal_id DESC LIMIT 1', [liveSessionId])!['journal_id']);
  }

  #contextShape(context: LiveContext): void {
    if (!context || typeof context !== 'object' || typeof context.clientId !== 'string' || !context.clientId.trim()
      || typeof context.auditId !== 'string' || !context.auditId.trim()
      || typeof context.authorityEpoch !== 'string' || !context.authorityEpoch.length) throw new LiveError('invalid_context');
  }

  #authorize(context: LiveContext): void {
    this.#contextShape(context);
    if (context.authorityEpoch !== this.#store.authorityEpoch) throw new LiveError('stale_authority');
  }

  #snapshot(tx: Transaction, row: SQLRow): LiveSessionSnapshot {
    const grant = tx.get('SELECT * FROM live_grants WHERE live_session_id=?', [String(row['live_session_id'])]);
    if (!grant) throw new LiveError('not_found');
    const limits = this.#profile.limits;
    return {
      liveSessionId: String(row['live_session_id']), assistantId: String(row['owner_assistant_id']),
      authorityEpoch: String(row['authority_epoch']), idempotencyKey: String(row['idempotency_key']),
      clientId: String(row['client_id']), auditId: String(row['audit_id']),
      lifecycle: String(row['lifecycle']) as LiveSessionSnapshot['lifecycle'],
      dispatchIntent: Number(row['dispatch_intent']) === 1, ready: Number(row['ready']) === 1,
      profileIdentity: String(row['profile_identity']), promptIdentity: String(row['prompt_identity']),
      grant: {
        grantId: String(grant['grant_id']), provider: 'gemini', model: String(grant['model']), voice: String(grant['voice']),
        keyReference: String(grant['key_reference']), permittedClasses: JSON.parse(String(grant['permitted_classes'])) as DataClass[],
        chosenInputClass: String(grant['chosen_input_class']) as DataClass, revision: Number(grant['revision']), grantedAt: Number(grant['granted_at']),
      },
      consumerState: String(row['consumer_state']) as LiveSessionSnapshot['consumerState'],
      journal: { events: Number(row['journal_events']), bytes: Number(row['journal_bytes']), maxEvents: limits.journalMaxEvents, maxBytes: limits.journalMaxBytes, complete: Number(row['journal_complete']) === 1 },
      terminal: parseTerminal(row['terminal_outcome']),
      createdAt: Number(row['created_at']), updatedAt: Number(row['updated_at']),
    };
  }

  #readSnapshot(liveSessionId: string): LiveSessionSnapshot {
    return this.#store.transaction(tx => {
      const row = tx.get('SELECT * FROM live_sessions WHERE live_session_id=?', [liveSessionId]);
      if (!row) throw new LiveError('not_found');
      return this.#snapshot(tx, row);
    });
  }

  #guardOpen(): void { if (this.#closed) throw new LiveError('terminal', 'owner is shut down'); }
}

/** Factory composition: the host supplies the validated profile, the real LiveVoicePort and its credentials. */
export function createLiveSessionOwner(config: LiveOwnerConfig): LiveSessionOwner {
  return new LiveSessionOwner(config);
}
