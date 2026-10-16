import { sourceCards } from '../tools/source-cards.js';
import { noEmptyResult } from '../tools/live-shape.js';
import * as memory from '../domain/memory.js';
import * as summaries from '../domain/summaries.js';
import * as labels from '../domain/labels.js';
import { definitionsInTransaction } from '../tools/index.js';
import { LiveToolJobs, type JobTimer } from '../tools/jobs.js';
import { declarationsFor, runToolCalls, authorizeToolBatch } from '../tools/declarations.js';
import { isIntentTool, planIntent, intentResponse, type IntentToolName, type IntentSubCall, type IntentSubResult } from '../tools/intent.js';
import { RESEARCH_TOOL_NAME, ResearchLedger, ResearchScheduler, validateResearch, type ResearchCall, type ResearchSelector, type SourceKind as ResearchSourceKind } from '../tools/research.js';
import { LiveToolCache, LIVE_CACHE_TTL_MS } from './tool-cache.js';
import type { RunAcceptance, LiveAuthority } from '../tools/types.js';
import type { ToolDefinition, HostContext, JsonObject } from '../adapters/model/types.js';
import type { LiveToolsComposition, LivePageProjection, LiveToolProjection, ResearchProgressView } from './types.js';
import { publicOwnerProfile, PROMPT_VERSION, TRUSTED_SYSTEM_CODE_UNIT_LIMIT, buildRuntimeContext, buildEarlierConversationsSection, composeLiveSessionInstruction, connectorGroupNames, toolGroupNames } from '../prompt/index.js';
import { hostLogEvent } from '../host/log.js';
import { validateAcceptedPrompt } from './config.js';
import { createHash, randomUUID } from 'node:crypto';
import type { DataClass, LiveVoiceDiagnostics, LiveVoiceEvent, LiveVoiceOutcome, LiveVoicePort, LiveVoiceSession, LiveVoiceRequest } from '../adapters/live-voice/index.js';
import { toolVoiceAnchor } from '../adapters/live-voice/gemini.js';
import { headVoiceBlock, voiceAnchor } from '../prompt/live-persona.js';
import type { SQLRow, Transaction } from '../contracts/storage.js';
import { liveProfileIdentity, validateLiveProfile } from './config.js';
import { parseTerminal, persistedKinds, readFragmentPage, retainedBytes } from './journal.js';
import {
  LiveError,
  type CreateLiveSession, type JournalKind, type LiveAttachment, type LiveConsumerState, type LiveContext,
  type LiveFragmentPage, type LiveInvalidationReason, type LiveOutputChunk, type LiveOwnerConfig,
  type AcceptedPromptSnapshot, type LiveProfile, type LiveProfileProjection, type LivePublicMarker, type LiveSessionSnapshot, type LiveStorePort,
  type LiveTerminalOutcome,
} from './types.js';

const pickupInstruction = 'The user has just picked up. Deliver the pending job result first, briefly, then resume the conversation. If the outcome failed or is unknown, state that truthfully.';
// Issue 1014: a session past this many tool calls starts a fresh setup instead of resuming into
// drifted audio; a session under it still reuses the saved resumption handle.
const RESUMPTION_TOOL_CALL_LIMIT = 5;
/** One intent sub-read deadline: a slow source never holds the whole turn past this. */
const INTENT_SUB_DEADLINE_MS = 8_000;

interface ActiveSession {
  inputFinal?: boolean;
  inputAt?: number;
  /** When the owner's turn finished, to measure dead air until the first model audio. */
  inputFinalAt: number | undefined;
  /** First model audio of the current turn; reset at each model turn start. */
  firstAudioAt: number | undefined;
  inputJournalId?: number;
  inputFinalTimer?: ReturnType<JobTimer>;
  inputFinalWaiters?: Set<() => void>;
  generation: number; attempts: number; rebuilding: boolean;
  request: LiveVoiceRequest; deadlineMs: number; deadlineAt: number; idleAt: number; goAwayUntil: number | undefined;
  sessionTimer: ReturnType<JobTimer> | undefined; idleTimer: ReturnType<JobTimer> | undefined;
  pendingCalls: Map<string, string>;
  toolCache: LiveToolCache;
  researchLedger: ResearchLedger;
  researchScheduler?: ResearchScheduler;
  registry: readonly ToolDefinition[];
  host: HostContext | undefined;
  toolStep: number;
  toolCalls: number;
  seenIds: Set<string>;
  thinking: boolean;
  pendingCallIds: Set<string>;
  bargeInCallIds: Set<string>;
  /** In-flight abort handle per model call id, so a provider cancellation aborts exactly that call. */
  callAborts: Map<string, AbortController>;
  /** Wall-clock start per model call id, for tool_cancelled ms-in-flight and per-turn latency. */
  callStartedAt: Map<string, number>;
  speaking: boolean;
  // E1 interruption telemetry: provider-side facts for the last turn only, never audio or text.
  lastModelAudioAt?: number;
  turnCompleteSeen: boolean;
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
  diagnosticSnapshots: Promise<Readonly<LiveVoiceDiagnostics> | undefined>[];
  ownerAudioCalls: number; ownerAudioBytes: number; ownerRebuildingDropCalls: number; ownerRebuildingDropBytes: number;
  terminalOutcome: LiveTerminalOutcome | null;
  diagnosticTerminalCode: string; diagnosticsEmitted: boolean;
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

/**
 * Trusted in-process hooks wired through the existing tools composition seam:
 * terminal distillation and allowlisted metadata logging. Never accepted from transport.
 */
type SummaryHooks = {
  onSessionTerminal?: (liveSessionId: string) => void;
  log?: (event: { event: string } & Record<string, unknown>) => void;
};

function identity(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function journalKind(type: string): JournalKind | null { return (persistedKinds as readonly string[]).includes(type) ? type as JournalKind : null; }
// Wire-38: barge-in sends serverContent.interrupted, never toolCallCancellation, and a late
// toolResponse is accepted silently. A batch dispatched before that interruption is answered
// once, marked after_barge_in so the UI can show why the answer may not match the pending turn.
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
  dropAudio(): void { this.#queue = this.#queue.filter(chunk => chunk.kind !== 'audio'); this.#bytes = 0; }
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

const normalized = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?,;:]+$/, '').trim();
const command = /^(?:naya\s*,?\s+)?remember\b(?:\s+that\b)?\s*:?\s*/i;
const classified = /^(?:privately\b|(?:this\s+)?(?:is\s+|as\s+)?(?:private|sensitive)\b)/i;

/** All reads and the write share the tool owner's transaction: duplicate calls cannot race. */
export function rememberOwnerNote(tx: Transaction, liveSessionId: string, args: { text: string; kind: 'fact' | 'preference' | 'task' }, now: number): JsonObject {
  // A bounded journal window, assembled into owner turns, not provider/model arguments.
  const rows = tx.all("SELECT journal_id,text,finished FROM live_journal WHERE live_session_id=? AND kind='inputTranscription' ORDER BY journal_id DESC LIMIT 64", [liveSessionId]).reverse();
  const turns: { seq: number; text: string }[] = [];
  let pending = '';
  for (const row of rows) {
    pending += String(row.text ?? '');
    if (Number(row.finished) === 1) { turns.push({ seq: Number(row.journal_id), text: pending }); pending = ''; }
  }
  const turn = turns.reverse().find(turn => command.test(turn.text.trim().replace(/\s+/g, ' ')));
  if (!turn) return { remembered: false, code: 'owner_transcript_not_final' };
  const utterance = turn.text.trim();
  const payload = utterance.replace(command, '').trim();
  if (classified.test(payload)) return { remembered: false, code: 'private_memory_unsupported' };
  const pointer = normalized(args.text), ownerText = normalized(payload);
  if (!pointer || !ownerText || !ownerText.includes(pointer)) return { remembered: false, code: 'owner_text_mismatch' };
  const externalId = `${liveSessionId}:${turn.seq}`;
  const existing = memory.rememberedLiveEntry(tx, externalId);
  if (existing) return { remembered: false, code: 'already_remembered', entryId: existing };
  const clock = { now: () => now };
  const session = memory.createSession(tx, { title: 'Live voice memory', startedAt: now, timeZone: 'UTC' }, clock);
  labels.correct(tx, { subject: { kind: 'session', id: session.id }, expectedRevision: 0, dataClass: 'ordinary' }, now);
  const entry = memory.appendEntry(tx, { sessionId: session.id, text: payload, capturedAt: now, timeZone: 'UTC',
    source: { label: `live-voice ${liveSessionId}`, provider: 'live-voice', accountId: liveSessionId, externalId, sourceTimestamp: now, availability: 'present', note: `kind:${args.kind}` } }, clock);
  labels.correct(tx, { subject: { kind: 'entry', id: entry.id }, expectedRevision: 0, dataClass: 'ordinary' }, now);
  return { remembered: true, entryId: entry.id };
}

/** Scrub only the deleted record, preserving the rest of the frozen instruction. */
function scrubMemorySnapshots(tx: Transaction, entryId: string): { id: string; system: string }[] {
  const scrubbed: { id: string; system: string }[] = [];
  if (!tx.get("SELECT name FROM sqlite_master WHERE type='table' AND name='live_sessions'", [])) return scrubbed;
  for (const row of tx.all('SELECT live_session_id,accepted_prompt_snapshot,prompt_identity,profile_identity FROM live_sessions', [])) {
    if (row['accepted_prompt_snapshot'] === null) continue;
    const snapshot = JSON.parse(String(row['accepted_prompt_snapshot'])) as AcceptedPromptSnapshot;
    let removed = false;
    const system = snapshot.system.replace(/<memory-record>\n([^\n]*)\n<\/memory-record>/g, (block, json: string) => {
      const record = JSON.parse(json) as { id: string };
      if (record.id !== entryId) return block;
      removed = true; return '';
    });
    if (!removed) continue;
    const selectedIds = snapshot.memory?.selectedIds.filter(id => id !== entryId) ?? [];
    const omitted = snapshot.memory?.omitted.filter(record => record.id !== entryId) ?? [];
    const memory = { status: omitted.length ? selectedIds.length ? 'partial' : 'omitted' : selectedIds.length ? 'selected' : 'empty', selectedIds, omitted } as const;
    const updated = { ...snapshot, system, memory };
    const dataClass = classes.find(dataClass => identity({ text: snapshot.system, dataClass }) === row['prompt_identity']);
    if (!dataClass) throw new LiveError('invalidated');
    const promptIdentity = identity({ text: system, dataClass });
    const id = String(row['live_session_id']);
    const grant = tx.get('SELECT chosen_input_class FROM live_grants WHERE live_session_id=?', [id]);
    if (!grant) throw new LiveError('invalidated');
    const fingerprint = identity({ inputClass: String(grant['chosen_input_class']), profile: String(row['profile_identity']), prompt: promptIdentity, pickupJobId: snapshot.pickup?.jobId ?? null });
    tx.run('UPDATE live_sessions SET accepted_prompt_snapshot=?,memory_provenance=?,prompt_identity=?,fingerprint=? WHERE live_session_id=?',
      [JSON.stringify(updated), JSON.stringify(memory), promptIdentity, fingerprint, id]);
    scrubbed.push({ id, system });
  }
  return scrubbed;
}

// Host composition and HTTP share the canonical Store object. Keep active-handle
// ownership here rather than exposing the manager through transport projections.
const memoryOwners = new WeakMap<LiveStorePort, LiveSessionOwner>();

/** Stage redaction in the caller's transaction, then publish active changes after commit. */
export function redactDeletedMemorySnapshots(store: LiveStorePort, tx: Transaction, entryId: string): { liveSessionRetainsUntilRebuild: boolean; publish: () => void } {
  const owner = memoryOwners.get(store);
  if (owner) return owner.redactDeletedMemory(tx, entryId);
  scrubMemorySnapshots(tx, entryId);
  return { liveSessionRetainsUntilRebuild: false, publish: () => {} };
}

export class LiveSessionOwner {
  readonly #jobs: LiveToolJobs;
  readonly #tools: LiveToolsComposition | undefined;
  readonly #onSessionTerminal: ((liveSessionId: string) => void) | undefined;
  readonly #summaryLog: ((event: { event: string } & Record<string, unknown>) => void) | undefined;
  readonly #memorySource: LiveOwnerConfig['memorySource'];
  readonly #store: LiveStorePort;
  readonly #voice: LiveVoicePort;
  readonly #profile: LiveProfile;
  readonly #now: () => number;
  readonly #timeZone: string;
  readonly #schedule: NonNullable<LiveOwnerConfig['schedule']>;
  readonly #research: ResearchSelector | undefined;
  #expiryTimer: ReturnType<NonNullable<LiveOwnerConfig['schedule']>> | undefined;
  readonly #profileIdentity: string;
  readonly #active = new Map<string, ActiveSession>();
  #revision = 1;
  #invalidated = false;
  #providerMemory = new WeakMap<ActiveSession, Map<string, number>>();
  #closed = false;
  /** The last state projected to the web, so one host-log live_state fires per change (F7). */
  #lastProjectedState: LivePageProjection['state'] | undefined;

  constructor(config: LiveOwnerConfig) {
    if (!config || typeof config !== 'object' || !config.store || !config.voice) throw new LiveError('invalid_config');
    this.#tools = config.tools;
    const summaryHooks = config.tools as unknown as SummaryHooks | undefined;
    this.#onSessionTerminal = summaryHooks?.onSessionTerminal;
    this.#summaryLog = summaryHooks?.log;
    this.#memorySource = config.memorySource;
    this.#store = config.store;
    this.#voice = config.voice;
    this.#research = config.research;
    this.#profile = validateLiveProfile(config.profile);
    this.#timeZone = config.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const now = config.now ?? Date.now;
    this.#now = () => {
      const value = now();
      if (!Number.isSafeInteger(value)) throw new LiveError('invalid_config', 'clock must return integer epoch milliseconds');
      return value;
    };
    this.#schedule = config.schedule ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return { unref: () => { timer.unref(); }, cancel: () => { clearTimeout(timer); } };
    });
    this.#jobs = new LiveToolJobs(this.#store, this.#now);
    this.#profileIdentity = liveProfileIdentity(this.#profile);
    memoryOwners.set(this.#store, this);
    this.recover();
  }

  get revision(): number { return this.#revision; }

  /** Host-generated runtime context: host clock and timezone, plus the groups this session can reach. */
  #liveRuntimeContext(toolNames: readonly string[]): string {
    const connected = toolGroupNames(toolNames);
    const endpoints = this.#tools?.status?.().endpoints ?? [];
    const unavailable = endpoints.filter(endpoint => endpoint.state !== 'connected')
      .flatMap(endpoint => connectorGroupNames(endpoint.connector))
      .filter((group, index, all) => all.indexOf(group) === index && !connected.includes(group));
    return buildRuntimeContext({ now: new Date(this.#now()), timeZone: this.#timeZone, connected, unavailable });
  }

  /** Safe operator-visible identity. Never carries key bytes or prompt text. */
  get profileIdentity(): string { return this.#profileIdentity; }
  profileProjection(): LiveProfileProjection {
    return {
      provider: this.#profile.provider, model: this.#profile.liveModelId, voice: this.#profile.voice,
      dataClasses: this.#profile.route.dataClasses, profileIdentity: this.#profileIdentity,
      memory: this.#store.transaction(tx => memoryProjection(tx.get('SELECT memory_provenance FROM live_sessions WHERE owner_assistant_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', [this.#store.assistantId])?.['memory_provenance'])),
    };
  }

  /** Startup sweep: no intent means no possible egress; an intent means possible egress. */
  recover(): number {
    const now = this.#now();
    const recovered = this.#store.transaction(tx => {
      const rows = tx.all("SELECT live_session_id, dispatch_intent FROM live_sessions WHERE lifecycle IN ('accepted','opening','active')");
      for (const row of rows) {
        const outcome: LiveTerminalOutcome = Number(row['dispatch_intent']) === 1 ? { state: 'outcome_unknown' } : { state: 'not_started' };
        this.#terminalInTx(tx, String(row['live_session_id']), outcome, false, now, 'ended', null);
      }
      return rows.length;
    });
    this.#armExpiry();
    return recovered;
  }

  create(input: CreateLiveSession, context: LiveContext): LiveSessionSnapshot {
    this.#guardOpen();
    if (!input || typeof input !== 'object' || typeof input.idempotencyKey !== 'string' || !keyPattern.test(input.idempotencyKey)) throw new LiveError('invalid_request');
    this.#contextShape(context);
    const fingerprintFor = (prompt: string) => identity({ inputClass: input.inputClass, profile: this.#profileIdentity, prompt, pickupJobId: input.pickupJobId ?? null });
    const now = this.#now();
    const assistantId = this.#store.assistantId;
    const snapshot = this.#store.transaction(tx => {
      // Same-key replay is decided on the normalized request meaning before any policy.
      const prior = tx.get('SELECT * FROM live_sessions WHERE owner_assistant_id=? AND idempotency_key=?', [assistantId, input.idempotencyKey]);
      if (prior) {
        if (String(prior['fingerprint']) !== fingerprintFor(String(prior['prompt_identity']))) throw new LiveError('idempotency_conflict');
        return this.#snapshot(tx, this.#expireInTx(tx, prior, now));
      }
      if (context.authorityEpoch !== this.#store.authorityEpoch) throw new LiveError('stale_authority');
      if (!classes.includes(input.inputClass) || !this.#profile.route.dataClasses.includes(input.inputClass)) throw new LiveError('invalid_request');
      const configuredPrompt = validateAcceptedPrompt(this.#profile.acceptedPrompt ?? {
        schemaVersion: 1, ownerProfile: publicOwnerProfile(assistantId), compilerVersion: PROMPT_VERSION,
        system: this.#profile.prompt.text, dataClasses: [this.#profile.prompt.dataClass],
      }, assistantId);
      if (configuredPrompt.dataClasses.some(c => !this.#profile.route.dataClasses.includes(c))) throw new LiveError('invalid_request');
      const liveSessionId = randomUUID();
      let toolNames: string[] = [];
      let toolAcceptance: { acceptance: RunAcceptance; sha256: string } | undefined;
      if (this.#tools) {
        const acceptance: RunAcceptance = { ownerId: assistantId, actorId: context.clientId, runId: liveSessionId,
          authorityEpoch: context.authorityEpoch, revision: this.#revision,
          route: { identity: this.#profileIdentity, provider: 'gemini', modelId: this.#profile.liveModelId, allowedClasses: [...this.#profile.route.dataClasses] },
          allowedClasses: [...this.#profile.route.dataClasses], connectionIds: [...this.#tools.connectionIds()] };
        toolAcceptance = { acceptance, sha256: this.#tools.owner.snapshotRun(tx, acceptance).sha256 };
        toolNames = [...definitionsInTransaction(this.#tools.owner, liveSessionId, tx).map(tool => tool.name).filter(name => name !== 'remember_note'), 'remember_note'];
      }
      const pickupJob = input.pickupJobId ? this.#jobs.pending(tx).find(job => job.id === input.pickupJobId && job.state !== 'in_progress') : undefined;
      if (input.pickupJobId && !pickupJob) throw new LiveError('invalid_request');
      const pickup = pickupJob ? { jobId: pickupJob.id, identity: identity({ state: pickupJob.state, result: pickupJob.result ?? null }) } : undefined;
      let records: ReturnType<NonNullable<LiveOwnerConfig['memorySource']>>;
      try { records = this.#memorySource?.(tx) ?? []; }
      catch { throw new LiveError('memory_unavailable'); }
      const earlier = buildEarlierConversationsSection(summaries.injectionCandidates(tx), { now, timeZone: this.#timeZone });
      let composed: ReturnType<typeof composeLiveSessionInstruction>;
      try { composed = composeLiveSessionInstruction({ text: configuredPrompt.system, tools: toolNames,
        runtimeContext: this.#liveRuntimeContext(toolNames),
        records: records.filter(record => record.dataClass === 'ordinary'), trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT,
        ...(earlier.section ? { earlierConversations: earlier.section } : {}),
        ...(this.#profile.overlay ? { overlay: this.#profile.overlay } : {}),
        ...(pickup ? { pickupNote: pickupInstruction } : {}) }); }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'instruction_too_large') throw new LiveError('instruction_too_large'); throw error; }
      console.error(JSON.stringify({ event: 'live_instruction_sizes', total: composed.text.length, sections: Object.fromEntries(composed.sections.map(section => [section.id, section.chars])) }));
      const memory = { status: composed.omitted.length ? composed.selectedIds.length ? 'partial' : 'omitted' : composed.selectedIds.length ? 'selected' : 'empty',
        selectedIds: composed.selectedIds, omitted: composed.omitted };
      const injectedSummaryIds = composed.earlierConversationsIncluded ? [...earlier.selectedIds] : [];
      if (injectedSummaryIds.length || earlier.omitted.length) this.#summaryLog?.({ event: 'conversation_summary_injection', injected: injectedSummaryIds.length, omitted: earlier.omitted.length });
      const acceptedPrompt = validateAcceptedPrompt({ ...configuredPrompt, system: composed.text, memory, ...(pickup ? { pickup } : {}) }, assistantId);
      const promptIdentity = identity({ text: acceptedPrompt.system, dataClass: this.#profile.prompt.dataClass });
      const fingerprint = fingerprintFor(promptIdentity);
      tx.run('INSERT INTO live_sessions(live_session_id, owner_assistant_id, authority_epoch, idempotency_key, fingerprint, client_id, audit_id, profile_identity, prompt_identity, lifecycle, dispatch_intent, ready, journal_events, journal_bytes, journal_complete, consumer_state, terminal_outcome, terminal_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,0,0,?,NULL,NULL,?,?)',
        [liveSessionId, assistantId, context.authorityEpoch, input.idempotencyKey, fingerprint, context.clientId, context.auditId, this.#profileIdentity, promptIdentity, 'accepted', 'detached', now, now]);
      tx.run('UPDATE live_sessions SET accepted_prompt_snapshot=?,memory_provenance=? WHERE live_session_id=?', [JSON.stringify(acceptedPrompt), JSON.stringify({ ...memory, injectedSummaryIds }), liveSessionId]);
      if (toolAcceptance) tx.run('INSERT INTO live_tool_acceptances VALUES (?,?,?)', [liveSessionId, JSON.stringify(toolAcceptance.acceptance), toolAcceptance.sha256]);
      if (pickupJob) { pickupJob.deliverySessionId = liveSessionId; this.#jobs.save(pickupJob, tx); }
      tx.run('INSERT INTO live_grants(grant_id, live_session_id, provider, model, voice, key_reference, permitted_classes, chosen_input_class, revision, granted_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [randomUUID(), liveSessionId, 'gemini', this.#profile.liveModelId, this.#profile.voice, this.#profile.keyReference,
          JSON.stringify(this.#profile.route.dataClasses), input.inputClass, this.#revision, now]);
      return this.#snapshot(tx, tx.get('SELECT * FROM live_sessions WHERE live_session_id=?', [liveSessionId])!);
    });
    this.#armExpiry();
    return snapshot;
  }

  lookupAuthority(runId: string): LiveAuthority | null {
    const handle = this.#active.get(runId);
    if (!handle || this.#settled(handle) || handle.consumerState !== 'attached') return null;
    return this.#store.transaction(tx => {
      const session = tx.get('SELECT authority_epoch,lifecycle FROM live_sessions WHERE live_session_id=?', [runId]);
      if (!session || session.authority_epoch !== this.#store.authorityEpoch || session.lifecycle !== 'active') return null;
      const row = tx.get('SELECT acceptance_json,accepted_run_hash FROM live_tool_acceptances WHERE live_session_id=?', [runId]);
      return row ? { ...JSON.parse(String(row.acceptance_json)) as RunAcceptance, acceptedRunHash: String(row.accepted_run_hash) } : null;
    });
  }

  /** Additional authority source for a dispatched job only; Live session lookup remains unchanged. */
  lookupJobAuthority(runId: string): LiveAuthority | null {
    const job = this.#jobs.list().find(job => job.originSessionId === runId && job.state === 'in_progress');
    return job && job.host.authorityEpoch === this.#store.authorityEpoch ? job.authority : null;
  }

  #jobProjection(pendingOnly: boolean): import('./types.js').PendingLiveJob[] {
    return this.#jobs.list().filter(job => job.deferred && (!pendingOnly || !job.delivered)).map(job => ({
      id: job.id, originSessionId: job.originSessionId, state: job.state, createdAt: job.createdAt, delivered: job.delivered,
      markdown: job.result?.accepted.map(result => typeof result.response.text === 'string' ? result.response.text : JSON.stringify(result.response)).join('\n\n')
        || `Job ${job.state}.`,
    }));
  }

  pendingJobs(): import('./types.js').PendingLiveJob[] { return this.#jobProjection(true); }

  createWithPending(input: CreateLiveSession, context: LiveContext): LiveSessionSnapshot {
    const priorPickup = this.#store.transaction(tx => {
      const prior = tx.get('SELECT accepted_prompt_snapshot FROM live_sessions WHERE owner_assistant_id=? AND idempotency_key=?', [this.#store.assistantId, input.idempotencyKey]);
      return prior ? validateAcceptedPrompt(JSON.parse(String(prior['accepted_prompt_snapshot'])), this.#store.assistantId).pickup?.jobId ?? null : undefined;
    });
    const pickupJobId = input.pickupJobId ?? (priorPickup !== undefined ? priorPickup ?? undefined : this.#jobs.pending().find(job => job.state !== 'in_progress')?.id);
    return this.create({ ...input, ...(pickupJobId ? { pickupJobId } : {}) }, context);
  }

  current(cursor = 0): LivePageProjection {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new LiveError('invalid_request');
    const jobs = this.#jobProjection(false);
    const page: LivePageProjection = this.#store.transaction(tx => {
      const row = tx.get('SELECT live_session_id,lifecycle,created_at,updated_at,terminal_at,terminal_outcome,memory_provenance FROM live_sessions WHERE owner_assistant_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', [this.#store.assistantId]);
      if (!row) return { state: 'idle', since: null, ...(jobs.length ? { jobs } : {}), entries: [], cursor };
      const handle = this.#active.get(String(row.live_session_id));
      const terminal = parseTerminal(row.terminal_outcome);
      const pastSession: LivePageProjection['pastSession'] = terminal || !handle
        ? { outcome: terminal?.state ?? 'unknown', endedAt: terminal ? Number(row.terminal_at) : null, lastObservedAt: Number(row.updated_at) } : undefined;
      const state: LivePageProjection['state'] = pastSession ? (!terminal && row.lifecycle === 'accepted' ? 'idle' : 'ended') : handle?.rebuilding ? 'rebuilding' : handle?.thinking ? 'thinking' : handle?.speaking ? 'speaking' : handle?.consumerState === 'attached' ? 'listening' : handle ? 'ended' : 'idle';
      const rows = tx.all('SELECT journal_id,kind,text,tool_json FROM live_journal WHERE live_session_id=? AND journal_id>? ORDER BY journal_id LIMIT 100', [String(row.live_session_id), cursor]);
      const entries: LivePageProjection['entries'] = [];
      for (const item of rows) {
        const seq = Number(item.journal_id), kind = String(item.kind);
        if (kind === 'inputTranscription' || kind === 'outputTranscription') entries.push({ seq, kind, text: String(item.text ?? '') });
        else if (kind === 'toolCall' || kind === 'toolResult') {
          const tool = JSON.parse(String(item.tool_json)) as LiveToolProjection;
          entries.push({ seq, kind, tool: kind === 'toolCall' ? { name: tool.name, status: 'called' } : { name: tool.name, status: tool.status, markdown: tool.markdown, sources: tool.sources.map(source => ({ title: source.title, ...(source.url ? { url: source.url } : {}) })) } });
        } else if (kind === 'continuity') entries.push({ seq, kind, ...JSON.parse(String(item.text)) });
        else if (kind === 'researchProgress') { const p = JSON.parse(String(item.text)) as ResearchProgressView; entries.push({ seq, kind, progress: { researchId: p.researchId, phase: p.phase, sourcesDone: p.sourcesDone, sourcesPending: p.sourcesPending, elapsedMs: p.elapsedMs } }); }
        else if (kind === 'interrupted' || kind === 'turnComplete' || kind === 'terminal') entries.push({ seq, kind });
      }
      return { state, ...(pastSession ? { pastSession } : {}), since: Number(row.created_at), memory: memoryProjection(row['memory_provenance']), ...(jobs.length ? { jobs } : {}), entries, cursor: rows.length ? Number(rows[rows.length - 1]!.journal_id) : cursor };
    });
    this.#observeState(page.state);
    return page;
  }

  /** One metadata-only host record per projected state change, so the orb timeline is reconstructable
   *  from host.log even though audio is never journalled (F7). */
  #observeState(state: LivePageProjection['state']): void {
    if (state === this.#lastProjectedState) return;
    this.#lastProjectedState = state;
    hostLogEvent({ event: 'live_state', state, at: this.#now() });
  }

  get(liveSessionId: string): LiveSessionSnapshot {
    this.#guardOpen();
    const snapshot = this.#store.transaction(tx => {
      const row = tx.get('SELECT * FROM live_sessions WHERE live_session_id=? AND owner_assistant_id=?', [liveSessionId, this.#store.assistantId]);
      if (!row) throw new LiveError('not_found');
      return this.#snapshot(tx, this.#expireInTx(tx, row, this.#now()));
    });
    this.#armExpiry();
    return snapshot;
  }

  listFragments(query: { liveSessionId: string; cursor?: number; limit?: number }): LiveFragmentPage {
    this.#guardOpen();
    if (!query || typeof query.liveSessionId !== 'string') throw new LiveError('invalid_request');
    const cursor = query.cursor === undefined ? 0 : query.cursor;
    const limit = query.limit === undefined ? 100 : query.limit;
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new LiveError('invalid_request');
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > maxPage) throw new LiveError('invalid_request');
    const page = this.#store.transaction(tx => {
      const row = tx.get('SELECT * FROM live_sessions WHERE live_session_id=? AND owner_assistant_id=?', [query.liveSessionId, this.#store.assistantId]);
      if (!row) throw new LiveError('not_found');
      this.#expireInTx(tx, row, this.#now());
      return readFragmentPage(tx, query.liveSessionId, cursor, limit);
    });
    this.#armExpiry();
    return page;
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
      if (String(row['profile_identity']) !== this.#profileIdentity) throw new LiveError('invalidated');
      if (String(row['lifecycle']) === 'terminal') throw new LiveError('terminal');
      if (String(row['lifecycle']) !== 'accepted') throw new LiveError('already_attached');
      if (this.#expireInTx(tx, row, now) !== row) return 'expired' as const;
      let acceptedPrompt: AcceptedPromptSnapshot;
      // Null is a pre-v2 legacy record. Refuse honestly rather than recompile private current state.
      try { acceptedPrompt = validateAcceptedPrompt(JSON.parse(String(row['accepted_prompt_snapshot'])), this.#store.assistantId); }
      catch { throw new LiveError('invalidated'); }
      if (String(row['prompt_identity']) !== identity({ text: acceptedPrompt.system, dataClass: this.#profile.prompt.dataClass })) throw new LiveError('invalidated');
      const grantClasses = tx.get('SELECT permitted_classes FROM live_grants WHERE live_session_id=?', [input.liveSessionId]);
      const permitted: DataClass[] = JSON.parse(String(grantClasses?.['permitted_classes']));
      if (acceptedPrompt.dataClasses.some(c => !permitted.includes(c) || !this.#profile.route.dataClasses.includes(c))) throw new LiveError('invalidated');
      const job = this.#jobs.forSession(input.liveSessionId, tx);
      if (acceptedPrompt.pickup ? !job || job.id !== acceptedPrompt.pickup.jobId || job.delivered
        || identity({ state: job.state, result: job.result ?? null }) !== acceptedPrompt.pickup.identity : Boolean(job)) throw new LiveError('pickup_changed');
      tx.run("UPDATE live_sessions SET lifecycle='opening', dispatch_intent=1, consumer_state='attached', updated_at=? WHERE live_session_id=?", [now, input.liveSessionId]);
      const grant = tx.get('SELECT chosen_input_class FROM live_grants WHERE live_session_id=?', [input.liveSessionId])!;
      return { inputClass: String(grant['chosen_input_class']) as DataClass, acceptedPrompt };
    });
    this.#armExpiry();
    if (prepared === 'expired') throw new LiveError('expired');
    return this.#open(input.liveSessionId, prepared.inputClass, revision, prepared.acceptedPrompt, context);
  }

  /** The HTTP delete owns the transaction; publish handle changes only after it commits. */
  redactDeletedMemory(tx: Transaction, entryId: string): { liveSessionRetainsUntilRebuild: boolean; publish: () => void } {
    let liveSessionRetainsUntilRebuild = [...this.#active.values()].some(handle => !handle.terminal && this.#providerMemory.get(handle)?.get(entryId) === handle.generation);
    const publish: (() => void)[] = [];
    for (const snapshot of scrubMemorySnapshots(tx, entryId)) {
      const handle = this.#active.get(snapshot.id);
      if (!handle || handle.terminal) continue;
      liveSessionRetainsUntilRebuild = true;
      // A staging handle lets the normal journal path maintain the same counters
      // without changing an active request if another owner subsequently rolls back.
      const staged = { ...handle, request: { ...handle.request, system: { ...handle.request.system, text: snapshot.system } } };
      const sequence = this.#persist(staged, { type: 'continuity', sequence: 0, text: JSON.stringify({ event: 'memory_deleted', entryId }) }, 'continuity', tx);
      if (sequence === 'overflow') throw new LiveError('persistence_failed');
      publish.push(() => {
        handle.request = staged.request;
        handle.journalEvents = staged.journalEvents;
        handle.journalBytes = staged.journalBytes;
        const retained = this.#providerMemory.get(handle) ?? new Map<string, number>();
        retained.set(entryId, handle.generation);
        this.#providerMemory.set(handle, retained);
      });
    }
    return { liveSessionRetainsUntilRebuild, publish: () => { for (const apply of publish) apply(); } };
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
      this.#armExpiry();
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
    this.#expiryTimer?.cancel();
    this.#expiryTimer = undefined;
    const handles = [...this.#active.values()];
    for (const handle of handles) {
      handle.consumer?.discard();
      handle.session.close();
    }
    await Promise.all(handles.map(handle => handle.loopDone.promise));
    for (const handle of handles) handle.resolveDone();
  }

  #jobHistory(sessionId: string, inputClass: DataClass): readonly { role: 'user'; text: string; dataClass: DataClass }[] | undefined {
    const job = this.#jobs.forSession(sessionId);
    if (!job) return undefined;
    const accepted = job.result?.accepted ?? [];
    // Only gate-reconstructed results can become history; never reconstruct raw references here.
    const text = accepted.length ? accepted.map(result => JSON.stringify({ tool: result.binding.name, result: result.response })).join('\n')
      : job.state === 'completed' ? 'The tool finished, but its result could not be authorized for delivery. Report this delivery failure, not success.'
      : `The background job ${job.id} ${job.state === 'unknown' ? 'has an unknown outcome after interruption; it was not replayed' : 'failed'}. Do not invent a successful result.`;
    const classes = accepted.flatMap(result => result.dataClasses ?? [inputClass]);
    const dataClass: DataClass = classes.includes('sensitive') ? 'sensitive' : classes.includes('private') ? 'private' : inputClass;
    return [{ role: 'user', text, dataClass }];
  }

  #open(liveSessionId: string, inputClass: DataClass, revision: number, acceptedPrompt: AcceptedPromptSnapshot, context: LiveContext): LiveAttachment {
    const abort = new AbortController();
    const dataClasses = classes.filter(c => c === inputClass || acceptedPrompt.dataClasses.includes(c));
    let registry: readonly ToolDefinition[] = [], host: HostContext | undefined;
    if (this.#tools) {
      const saved = this.#store.transaction(tx => tx.get('SELECT acceptance_json FROM live_tool_acceptances WHERE live_session_id=?', [liveSessionId]));
      if (!saved) throw new LiveError('invalidated');
      registry = Object.freeze(this.#tools.owner.liveDefinitions(liveSessionId, (tx, id, args) => this.#active.get(id)?.inputFinal ? rememberOwnerNote(tx, id, args, this.#now()) : { remembered: false, code: 'owner_transcript_not_final' }).map(tool => Object.freeze({ ...tool, parameters: structuredClone(tool.parameters) })));
      host = { runId: liveSessionId, actorId: context.clientId, authorityEpoch: context.authorityEpoch, revision,
        grants: registry.filter(tool => tool.effect === 'read' || this.#tools!.owner.liveRememberApproved() && tool.name === 'remember_note' && tool.accountId === 'gateway:live-voice' && tool.resourceId === 'owner-memory').map(tool => ({ tool: tool.name, effect: tool.effect, accountId: tool.accountId, resourceId: tool.resourceId })) };
    }
    const history = this.#jobHistory(liveSessionId, inputClass);
    // Only the coarse intent tools (and remember) are declared to the model; the connector reads stay
    // dispatchable through the registry so the intent fan-out and the session cache keep working.
    const modelFacing = registry.filter(tool => tool.name === RESEARCH_TOOL_NAME || tool.name === 'remember_note');
    const declarations = modelFacing.length ? declarationsFor(modelFacing).declarations : [];
    const system = acceptedPrompt.system;
    const request: LiveVoiceRequest = { opening: 'model_first',
      system: { text: system, dataClass: dataClasses[dataClasses.length - 1]! }, history: history ?? [], dataClasses,
      ...(this.#profile.language !== undefined ? { languageCode: this.#profile.language } : {}),
      ...(this.#profile.overlay?.accent !== undefined ? { voiceAccent: this.#profile.overlay.accent } : {}),
      ...(declarations.length ? { tools: declarations } : {}) };
    const deadlineMs = Date.now() + this.#profile.limits.sessionMs;
    const deadlineAt = this.#now() + this.#profile.limits.sessionMs;
    let session: LiveVoiceSession;
    try {
      // Absolute wall clock for the adapter; the injected clock is the owner's own durable order.
      session = this.#voice.open(request, { signal: abort.signal, deadlineMs, limits: this.#profile.limits });
    } catch (error) {
      this.#store.transaction(tx => this.#terminalInTx(tx, liveSessionId, { state: 'not_started' }, false, this.#now(), 'ended', null));
      throw error;
    }
    this.#store.transaction(tx => tx.run("UPDATE live_sessions SET lifecycle='active', updated_at=? WHERE live_session_id=?", [this.#now(), liveSessionId]));
    const handle: ActiveSession = {
      generation: 0, attempts: 0, rebuilding: false, request: structuredClone(request),
      deadlineMs, deadlineAt, idleAt: this.#now() + this.#profile.limits.idleMs, goAwayUntil: undefined,
      sessionTimer: undefined, idleTimer: undefined, pendingCalls: new Map(),
      toolCache: new LiveToolCache(LIVE_CACHE_TTL_MS, () => this.#now()),
      researchLedger: new ResearchLedger(),
      registry, host, toolStep: 0, toolCalls: 0, seenIds: new Set(), thinking: false, speaking: false, pendingCallIds: new Set(), bargeInCallIds: new Set(), turnCompleteSeen: false, callAborts: new Map(), callStartedAt: new Map(), inputFinalAt: undefined, firstAudioAt: undefined,
      liveSessionId, session, abort, revision, inputClass, ready: false, invalidated: false, terminal: false,
      consumer: new OutputChannel(this.#profile.limits.consumerQueueEvents, this.#profile.limits.consumerQueueBytes),
      consumerState: 'attached', journalEvents: 0, journalBytes: 0, adapterOutcome: undefined,
      diagnosticSnapshots: [], ownerAudioCalls: 0, ownerAudioBytes: 0, ownerRebuildingDropCalls: 0, ownerRebuildingDropBytes: 0, terminalOutcome: null,
      diagnosticTerminalCode: 'outcome_unknown', diagnosticsEmitted: false,
      loopDone: deferred<void>(), done: deferred<LiveSessionSnapshot>(), resolveDone: () => {}, persistFailure: undefined,
    };
    handle.resolveDone = () => {
      try { handle.done.resolve(this.#readSnapshot(liveSessionId)); }
      catch (error) { handle.done.reject(error); }
    };
    session.ready.then(() => {
      if (handle.generation !== 0 || this.#settled(handle)) return;
      handle.ready = true;
      const job = this.#jobs.forSession(liveSessionId);
      if (job) { job.delivered = true; this.#jobs.save(job); }
    }, () => {});
    session.done.catch(() => {});
    this.#observeDiagnostics(handle, session);
    this.#active.set(liveSessionId, handle);
    void handle.done.promise.catch(() => {});
    handle.sessionTimer = this.#schedule(() => this.#settle(handle, { state: 'failed', code: 'session_timeout' }, false, 'ended', null), this.#profile.limits.sessionMs);
    this.#armIdle(handle, this.#profile.limits.idleMs);
    void this.#consume(handle);
    const ready = session.ready.then(() => this.#readSnapshot(liveSessionId));
    void ready.catch(() => {});
    return {
      liveSessionId,
      ready,
      output: handle.consumer,
      done: handle.done.promise,
      sendAudio: ({ pcm }) => this.#sendAudio(handle, pcm),
      endAudioStream: () => { if (handle.rebuilding) return; this.#guardHandle(handle); handle.session.endAudioStream(); },
      close: () => { handle.session.close(); },
      detach: () => this.#detach(handle),
      overflow: () => {
        if (handle.terminal) return;
        handle.consumerState = 'backpressure';
        this.#settle(handle, { state: 'consumer_backpressure' }, false, 'backpressure', null);
      },
    };
  }

  #armIdle(handle: ActiveSession, remainingMs: number): void {
    if (this.#settled(handle)) return;
    handle.idleTimer?.cancel();
    handle.idleAt = this.#now() + remainingMs;
    handle.idleTimer = this.#schedule(() => this.#settle(handle, { state: 'failed', code: 'idle_timeout' }, false, 'ended', null), remainingMs);
  }

  #continuity(handle: ActiveSession, event: 'rebuilding' | 'resumed', reason?: string): void {
    const journalSequence = this.#persist(handle, { type: 'continuity', sequence: 0, text: JSON.stringify({ event, ...(reason ? { reason } : {}) }) }, 'continuity');
    if (journalSequence === 'overflow') { this.#settle(handle, { state: 'journal_limit' }, false, 'ended', null); return; }
    this.#pushChunk(handle, { kind: 'marker', marker: { kind: 'continuity', event, ...(reason ? { reason } : {}), sequence: null, journalSequence, text: null, finished: null, value: null } });
  }

  #rebuild(handle: ActiveSession, reason: string): boolean {
    const remaining = handle.deadlineAt - this.#now(), idle = handle.idleAt - this.#now();
    const window = Math.min(10_000, handle.goAwayUntil === undefined ? 10_000 : handle.goAwayUntil - this.#now());
    const saved = this.#store.transaction(tx => tx.get('SELECT resumption_handle FROM live_sessions WHERE live_session_id=?', [handle.liveSessionId]));
    const savedHandle = saved?.['resumption_handle'];
    const hasHandle = typeof savedHandle === 'string' && savedHandle.length > 0;
    const reuse = hasHandle && handle.toolCalls < RESUMPTION_TOOL_CALL_LIMIT;
    if (handle.attempts >= 2 || (!reuse && !hasHandle) || remaining <= 0 || idle <= 0 || window <= 0) {
      this.#settle(handle, { state: 'failed', code: 'resume_failed' }, false, 'ended', null);
      return false;
    }
    if (!reuse) hostLogEvent({ event: 'live_resumption_fresh', toolCalls: handle.toolCalls });
    handle.attempts += 1; handle.generation += 1; handle.rebuilding = true; handle.ready = false;
    handle.thinking = false; handle.speaking = false;
    this.#store.transaction(tx => tx.run('UPDATE live_sessions SET connection_generation=? WHERE live_session_id=?', [handle.generation, handle.liveSessionId]));
    handle.consumer.dropAudio();
    // Fence before closing: neither iterator callbacks nor pending async tool work can cross the cut.
    handle.session.close();
    for (const id of handle.pendingCallIds) {
      const tool: LiveToolProjection = { callId: id, name: handle.pendingCalls.get(id) ?? 'unknown', status: 'error', code: 'tool_call_lost_on_resume', markdown: 'Tool call lost when the voice connection resumed.', sources: [] };
      const journalSequence = this.#persist(handle, { type: 'toolResult', sequence: 0, tool }, 'toolResult');
      if (journalSequence === 'overflow') { this.#settle(handle, { state: 'journal_limit' }, false, 'ended', null); return false; }
      this.#pushChunk(handle, { kind: 'marker', marker: { kind: 'toolResult', sequence: null, journalSequence, text: null, finished: null, value: null, tool } });
    }
    handle.pendingCallIds.clear(); handle.pendingCalls.clear(); handle.bargeInCallIds.clear();
    this.#continuity(handle, 'rebuilding', reason);
    if (this.#settled(handle)) return false;
    try {
      handle.session = this.#voice.open({ ...structuredClone(handle.request), ...(reuse ? { resumptionHandle: savedHandle } : {}) }, {
        signal: handle.abort.signal, deadlineMs: handle.deadlineMs, idleResetMs: this.#profile.limits.idleMs,
        limits: { ...this.#profile.limits, sessionMs: Math.ceil(remaining), idleMs: Math.ceil(idle), handshakeMs: Math.max(1, Math.ceil(Math.min(this.#profile.limits.handshakeMs, window, remaining, idle))) },
      });
      void handle.session.ready.catch(() => {}); void handle.session.done.catch(() => {});
      this.#observeDiagnostics(handle, handle.session);
      handle.goAwayUntil = undefined;
      return true;
    } catch {
      this.#settle(handle, { state: 'failed', code: 'resume_failed' }, false, 'ended', null);
      return false;
    }
  }

  /** Send operator-typed text into the newest active session as a user turn (W5-R4 item 2). */
  text(text: string): void {
    if (typeof text !== 'string' || !text.length || text.length > 4000) throw new LiveError('invalid_request');
    const handle = [...this.#active.values()].filter(candidate => !candidate.terminal).at(-1);
    if (!handle) throw new LiveError('not_found', 'No active Live session');
    this.#guardHandle(handle);
    const event = { type: 'inputTranscription' as const, sequence: 0, text, finished: true };
    handle.session.sendText({ text });
    this.#armIdle(handle, this.#profile.limits.idleMs);
    const journalSequence = this.#persist(handle, event, 'inputTranscription');
    if (journalSequence === 'overflow') return;
    this.#pushChunk(handle, { kind: 'marker', marker: markerOf(event, 'inputTranscription', journalSequence) });
  }
  #sendAudio(handle: ActiveSession, pcm: Uint8Array): void {
    handle.ownerAudioCalls++; handle.ownerAudioBytes += pcm.byteLength;
    // A late mic frame after the session settled is dropped and counted, never thrown:
    // throwing here makes the HTTP layer close the socket generic 1002 before the typed terminal frame.
    if (handle.rebuilding || (handle.terminal && !handle.invalidated)) {
      handle.ownerRebuildingDropCalls++; handle.ownerRebuildingDropBytes += pcm.byteLength;
      // The settle diagnostics were already emitted, so a late drop is counted and reported here.
      if (handle.terminal) console.error(JSON.stringify({ event: 'live_late_frame_dropped', liveSessionId: handle.liveSessionId,
        dropCalls: handle.ownerRebuildingDropCalls, dropBytes: handle.ownerRebuildingDropBytes }));
      return;
    }
    this.#guardHandle(handle);
    if (!(pcm instanceof Uint8Array) || !pcm.length || pcm.length % 2 !== 0) throw new LiveError('invalid_audio');
    this.#armIdle(handle, this.#profile.limits.idleMs);
    handle.session.sendAudio({ pcm, dataClass: handle.inputClass });
  }

  #observeDiagnostics(handle: ActiveSession, session: LiveVoiceSession): void {
    handle.diagnosticSnapshots.push(session.done.then(() => session.diagnostics?.(), () => session.diagnostics?.()));
  }

  #emitDiagnostics(handle: ActiveSession): void {
    if (handle.diagnosticsEmitted) return;
    handle.diagnosticsEmitted = true;
    void Promise.all(handle.diagnosticSnapshots).then(values => {
      const snapshots = values.filter((value): value is Readonly<LiveVoiceDiagnostics> => value !== undefined);
      const sum = (field: keyof LiveVoiceDiagnostics) => snapshots.reduce((total, value) => total + value[field], 0);
      const accent = this.#profile.overlay?.accent;
      console.error(JSON.stringify({ event: 'live_session_diagnostics', terminalCode: handle.diagnosticTerminalCode,
        headVoiceChars: headVoiceBlock(accent)?.length ?? 0,
        terminalVoiceChars: voiceAnchor(this.#profile.language, accent).length,
        toolAnchorChars: toolVoiceAnchor(accent).length,
        adapterGenerations: values.length, ownerAudioCalls: handle.ownerAudioCalls, ownerAudioBytes: handle.ownerAudioBytes,
        ownerRebuildingDropCalls: handle.ownerRebuildingDropCalls, ownerRebuildingDropBytes: handle.ownerRebuildingDropBytes,
        adapterAudioCalls: sum('audioCalls'), adapterAudioBytes: sum('audioBytes'),
        drainingDropCalls: sum('drainingDropCalls'), drainingDropBytes: sum('drainingDropBytes'),
        localWriteEnqueuedCalls: sum('localWriteEnqueuedCalls'), localWriteEnqueuedPCMBytes: sum('localWriteEnqueuedPCMBytes'),
        localWriteCallbackSuccessCalls: sum('localWriteCallbackSuccessCalls'), localWriteCallbackSuccessPCMBytes: sum('localWriteCallbackSuccessPCMBytes'),
        localWriteCallbackErrorCalls: sum('localWriteCallbackErrorCalls'), localWriteCallbackErrorPCMBytes: sum('localWriteCallbackErrorPCMBytes'),
        localWriteCallbackPendingCalls: sum('localWriteCallbackPendingCalls'), localWriteCallbackPendingPCMBytes: sum('localWriteCallbackPendingPCMBytes'),
        inputTranscriptionEvents: sum('inputTranscriptionEvents'), inputTranscriptionCharacters: sum('inputTranscriptionCharacters'),
        generationCompleteEvents: sum('generationCompleteEvents'), turnCompleteEvents: sum('turnCompleteEvents'),
        outputAudioFrames: sum('outputAudioFrames'), outputAudioPCMBytes: sum('outputAudioPCMBytes'),
        outputAudioAfterInitialTurnFrames: sum('outputAudioAfterInitialTurnFrames'), outputAudioAfterInitialTurnPCMBytes: sum('outputAudioAfterInitialTurnPCMBytes') }));
    });
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
    catch (error) {
      // A failed detach write is logged, never swallowed; #snapshot reconciles the row against this handle.
      console.error(JSON.stringify({ event: 'live_detach_write_failed', liveSessionId: handle.liveSessionId,
        class: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.constructor.name) ? error.constructor.name : 'Unknown' }));
    }
  }

  async #consume(handle: ActiveSession): Promise<void> {
    while (!this.#settled(handle)) {
    const session = handle.session, generation = handle.generation;
    let outcome: LiveVoiceOutcome | undefined;
    try {
      for await (const event of session.events) {
        if (this.#settled(handle) || generation !== handle.generation) break;
        if (event.type === 'modelTurnStarted') {
          handle.firstAudioAt = undefined;
          this.#beginModelTurn(handle);
          handle.turnCompleteSeen = false;
          continue;
        }
        if (event.type === 'resumptionHandle') {
          this.#store.transaction(tx => tx.run('UPDATE live_sessions SET resumption_handle=? WHERE live_session_id=?', [event.handle, handle.liveSessionId]));
          continue;
        }
        if (event.type === 'goAway') {
          handle.goAwayUntil = this.#now() + event.timeLeftMs;
          outcome = { status: 'failed', code: 'go_away', recoverable: true };
          break;
        }
        if (event.type === 'ready' && handle.rebuilding) {
          handle.rebuilding = false; handle.ready = true;
          this.#continuity(handle, 'resumed');
          continue;
        }
        if (event.type !== 'ready' && event.type !== 'outcome') this.#armIdle(handle, this.#profile.limits.idleMs);
        if (event.type === 'toolCall') {
          handle.toolCalls += event.calls.length;
          for (const call of event.calls) { handle.pendingCallIds.add(call.id); handle.pendingCalls.set(call.id, call.name); }
          void this.#toolBatch(handle, event, generation).catch(() => {
            if (this.#settled(handle) || generation !== handle.generation) return;
            const responses = event.calls.filter(call => handle.pendingCallIds.has(call.id)).map(call => ({ id: call.id, name: call.name, response: { error: 'tool_processing_failed' } }));
            try { if (responses.length) handle.session.sendToolResponse({ responses }); } catch { /* transport may have terminated */ }
            for (const call of event.calls) handle.pendingCallIds.delete(call.id);
            handle.thinking = responses.length > 0 || handle.pendingCallIds.size > 0;
          }); continue;
        }
        if (event.type === 'toolCallCancellation') {
          // A provider cancellation (after a barge-in) drops exactly the cancelled ids: their in-flight
          // reads are aborted and no response is sent for them. A plain interrupted is different: those
          // ids stay in pendingCallIds, so their response is still answered once, marked after_barge_in.
          for (const id of event.ids) {
            const started = handle.callStartedAt.get(id);
            hostLogEvent({ event: 'tool_cancelled', tool: handle.pendingCalls.get(id) ?? 'unknown', id, msInFlight: started === undefined ? null : Math.max(0, this.#now() - started) });
            handle.callAborts.get(id)?.abort();
            handle.pendingCallIds.delete(id);
          }
          handle.thinking = handle.pendingCallIds.size > 0;
          continue;
        }
        if (event.type === 'interrupted') {
          for (const id of handle.pendingCallIds) handle.bargeInCallIds.add(id);
          handle.speaking = false;
          // A barge-in abandons any awaited output, and a tool that never resolves must not leave
          // THINKING stuck (F4).
          handle.thinking = false;
          // E1: one metadata-only host record per provider barge-in. Never audio, text or a provider payload.
          hostLogEvent({ event: 'live_interrupted', liveSessionId: handle.liveSessionId,
            turnCompleteSeen: handle.turnCompleteSeen,
            msSinceLastModelAudio: handle.lastModelAudioAt === undefined ? null : this.#now() - handle.lastModelAudioAt });
        }
        // generationComplete alone does not end SPEAKING: the orb holds it until the turn completes
        // and playback drains (F2).
        if (event.type === 'turnComplete') { handle.speaking = false; handle.turnCompleteSeen = true; handle.thinking = handle.pendingCallIds.size > 0; }
        if (event.type === 'waitingForInput') { handle.thinking = !event.value; if (event.value) handle.speaking = false; }
        if (event.type === 'audio') {
          handle.thinking = false; handle.speaking = true; handle.lastModelAudioAt = this.#now();
          if (handle.firstAudioAt === undefined) {
            handle.firstAudioAt = this.#now();
            if (handle.inputFinalAt !== undefined) {
              hostLogEvent({ event: 'live_dead_air', deadAirMs: Math.max(0, handle.firstAudioAt - handle.inputFinalAt) });
              handle.inputFinalAt = undefined;
            }
          }
          this.#pushChunk(handle, { kind: 'audio', pcm: event.pcm }); continue;
        }
        if (event.type === 'outcome') { outcome = event.outcome; continue; }
        if (event.type === 'inputTranscription') {
          handle.inputFinalTimer?.cancel();
          handle.inputAt = this.#now();
          handle.inputFinal = event.finished === true;
          if (handle.inputFinal) handle.inputFinalAt = handle.inputAt;
        }
        const kind = journalKind(event.type);
        if (kind === null) continue;
        const persisted = this.#persist(handle, event, kind);
        if (persisted === 'overflow') {
          this.#settle(handle, { state: 'journal_limit' }, false, 'ended', { kind, sequence: event.sequence });
          break;
        }
        if (event.type === 'inputTranscription') {
          handle.inputJournalId = persisted;
          if (handle.inputFinal) for (const resolve of handle.inputFinalWaiters ?? []) resolve();
        }
        this.#pushChunk(handle, { kind: 'marker', marker: markerOf(event, kind, persisted) });
      }
    } catch (error) { handle.persistFailure = error; }
    if (!handle.terminal) {
      if (handle.persistFailure) { handle.abort.abort(); handle.done.reject(handle.persistFailure); }
      else {
        outcome ??= await session.done.catch(() => undefined);
        if (outcome?.recoverable) {
          const rebuilt = this.#rebuild(handle, outcome.code);
          if (outcome.upstream) hostLogEvent({ event: 'live_upstream_drop', errorKind: outcome.upstream.errorKind, closeCode: outcome.upstream.closeCode, bufferedAmount: outcome.upstream.bufferedAmount, writesFailed: outcome.upstream.writesFailed, sessionMs: outcome.upstream.sessionMs, rebuilt });
          if (rebuilt) continue;
        }
        if (handle.terminal) break;
        if (outcome) this.#settle(handle, { state: outcome.status, code: handle.rebuilding && outcome.code !== 'session_timeout' && outcome.code !== 'idle_timeout' && outcome.code !== 'deadline' || outcome.recoverable ? 'resume_failed' : outcome.code === 'deadline' ? 'session_timeout' : outcome.code }, outcome.status === 'closed', 'ended', null);
        else this.#settle(handle, { state: 'outcome_unknown' }, false, 'ended', null);
      }
    }
    break;
    }
    this.#emitDiagnostics(handle);
    this.#active.delete(handle.liveSessionId);
    handle.loopDone.resolve();
  }

  #beginModelTurn(handle: ActiveSession): void {
    if (handle.inputFinal || handle.inputAt === undefined || handle.inputJournalId === undefined) return;
    handle.inputFinalTimer?.cancel();
    const journalId = handle.inputJournalId, generation = handle.generation;
    handle.inputFinalTimer = this.#schedule(() => {
      if (this.#settled(handle) || handle.generation !== generation || handle.inputJournalId !== journalId) return;
      try {
        this.#store.transaction(tx => tx.run("UPDATE live_journal SET finished=1 WHERE journal_id=? AND live_session_id=? AND kind='inputTranscription'", [journalId, handle.liveSessionId]));
      } catch (error) {
        handle.persistFailure = error;
        handle.abort.abort();
        handle.done.reject(error);
        return;
      }
      handle.inputFinal = true;
      handle.inputFinalAt = this.#now();
      for (const resolve of handle.inputFinalWaiters ?? []) resolve();
    }, Math.max(0, 300 - (this.#now() - handle.inputAt)));
    handle.inputFinalTimer.unref();
  }

  async #waitForOwnerTranscript(handle: ActiveSession, sequence: number): Promise<void> {
    if (handle.inputFinal) return;
    const started = this.#now();
    await new Promise<void>(resolve => {
      const finish = () => {
        timer.cancel();
        handle.inputFinalWaiters?.delete(finish);
        handle.abort.signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = this.#schedule(finish, 1500);
      timer.unref();
      (handle.inputFinalWaiters ??= new Set()).add(finish);
      handle.abort.signal.addEventListener('abort', finish, { once: true });
    });
    if (!this.#settled(handle)) {
      const retained = this.#persist(handle, { type: 'remember_deferred', sequence, text: String(Math.max(0, this.#now() - started)) }, 'remember_deferred');
      if (retained === 'overflow') this.#settle(handle, { state: 'journal_limit' }, false, 'ended', { kind: 'remember_deferred', sequence });
    }
  }

  #researchSources(handle: ActiveSession): ResearchSourceKind[] {
    const names = new Set(handle.registry.map(tool => tool.name));
    const sources: ResearchSourceKind[] = [];
    if (names.has('search_knowledge')) sources.push('knowledge');
    if (names.has('gcal_calendars')) sources.push('calendar');
    if (names.has('gmail_list')) sources.push('mail');
    if (names.has('mattermost_search')) sources.push('chat');
    return sources;
  }

  /** One BLOCKING research call runs its whole bounded loop; `interrupted` never aborts it. */
  async #researchBatch(handle: ActiveSession, event: Extract<LiveVoiceEvent, { type: 'toolCall' }>, generation: number, host: HostContext, allowed: boolean): Promise<{ responses: { id: string; name: string; response: JsonObject }[]; projections: LiveToolProjection[] }> {
    const configured = this.#researchSources(handle);
    const gateAuthority = { isCurrent: async (_host: HostContext, _tool: ToolDefinition, signal: AbortSignal) => allowed && !signal.aborted && generation === handle.generation && !this.#settled(handle) };
    const execute = async (subs: readonly IntentSubCall[], signal: AbortSignal): Promise<IntentSubResult[]> => {
      // Q1-R3(d): a research run issues several execute batches (search, then hydrate/open/thread, then a
      // retry). They shared handle.toolStep, so executionId (`runId:step:index`) collided and the journal
      // refused the second batch as tool_intent_exists. Take a fresh step per batch.
      const step = handle.toolStep++;
      const calls = subs.map((sub, n) => ({ id: `r${step}~${n}~${sub.key}`, name: sub.name, args: sub.args }));
      const signalMap = new Map<string, AbortSignal>(calls.map(call => [call.id, signal]));
      const control = { signal, deadlineMs: handle.deadlineMs };
      const raw = await runToolCalls(this.#tools!.owner, calls, { registry: handle.registry, host, signals: signalMap, authority: gateAuthority, control, step, contentIndex: 0, seenIds: handle.seenIds, baseClasses: [handle.inputClass] });
      const authorized = (this.lookupAuthority(host.runId) || this.lookupJobAuthority(host.runId)) ? await authorizeToolBatch(this.#tools!.owner, raw, { host, control, baseClasses: [handle.inputClass] }) : raw;
      return calls.map(call => {
        const slot = authorized.bindings.findIndex(binding => binding.callId === call.id);
        const record = slot >= 0 ? authorized.tools[slot] : undefined;
        const accepted = authorized.accepted.find(result => result.binding.callId === call.id);
        const response = accepted?.response ?? {};
        const text = typeof response.text === 'string' ? response.text : '';
        const ok = record?.status === 'completed' && accepted !== undefined;
        // Q1-R3(d/e): a failed sub-call names its cause for the research_subcall log, never silently.
        const code = ok ? undefined : (typeof response.code === 'string' ? response.code : record ? String(record.status) : 'refused');
        return { key: call.id, name: call.name, ok, text, originalCharacters: typeof response.originalCharacters === 'number' ? response.originalCharacters : text.length, omittedCharacters: typeof response.omittedCharacters === 'number' ? response.omittedCharacters : 0, ...(code ? { code } : {}) };
      });
    };
    const scheduler = handle.researchScheduler ??= new ResearchScheduler({
      now: () => this.#now(), configured, selector: this.#research, execute,
      emit: progress => {
        hostLogEvent({ event: 'research_progress', ...progress });
        // U1: the voice lane sees the lookup as it runs, on the channel it already polls.
        if (!this.#settled(handle) && generation === handle.generation) {
          const view: ResearchProgressView = { researchId: progress.researchId, phase: progress.phase, sourcesDone: [...progress.sourcesDone], sourcesPending: [...progress.sourcesPending], elapsedMs: progress.elapsedMs };
          this.#persist(handle, { type: 'continuity', sequence: 0, text: JSON.stringify(view) }, 'researchProgress');
        }
      },
      log: entry => hostLogEvent(entry), ledger: handle.researchLedger,
    });
    const responses: { id: string; name: string; response: JsonObject }[] = [];
    const projections: LiveToolProjection[] = [];
    // F6: every research call in one model message runs concurrently; the adapter bounds each source.
    const settled = await Promise.all(event.calls.map(async call => {
      let response: JsonObject;
      try {
        if (!validateResearch(call.args)) throw Error('invalid_research_arguments');
        response = await scheduler.call(call.args as unknown as ResearchCall, handle.abort.signal);
      } catch (error) { response = { error: error instanceof Error ? error.message : 'research_failed' }; }
      return { id: call.id, name: call.name, response };
    }));
    for (const entry of settled) {
      responses.push(entry);
      // F6-R1: the research reply carries no status field; a present `error` key is the failure shape.
      const completed = entry.response['error'] === undefined;
      const status: 'completed' | 'error' = completed ? 'completed' : 'error';
      projections.push({ name: entry.name, status, markdown: `research: ${status}`, sources: [] });
    }
    return { responses, projections };
  }

  async #toolBatch(handle: ActiveSession, event: Extract<LiveVoiceEvent, { type: 'toolCall' }>, generation: number): Promise<void> {
    handle.thinking = true;
    const publish = (kind: 'toolCall' | 'toolResult', tool: LiveToolProjection) => {
      if ((this.#settled(handle) || generation !== handle.generation)) return;
      const sequence = this.#persist(handle, { type: kind, sequence: event.sequence, tool }, kind);
      if (sequence === 'overflow') { this.#settle(handle, { state: 'journal_limit' }, false, 'ended', { kind, sequence: event.sequence }); return; }
      this.#pushChunk(handle, { kind: 'marker', marker: { kind, sequence: event.sequence, journalSequence: sequence, text: null, finished: null, value: null, tool } });
    };
    for (const call of event.calls) publish('toolCall', { name: call.name, status: 'called', markdown: '', sources: [] });
    if ((this.#settled(handle) || generation !== handle.generation)) return;
    let responses = event.calls.map(call => ({ id: call.id, name: call.name, response: { error: 'Tool not granted' } as JsonObject }));
    let projections: LiveToolProjection[] = event.calls.map(call => ({ name: call.name, status: 'error', markdown: 'Tool not granted', sources: [] }));
    if (this.#tools && handle.host) {
      const authority = this.lookupAuthority(handle.host.runId);
      if (!authority) return;
      const dispatchGate = await this.#tools.owner.resultGate.authorize(handle.host, [], [handle.inputClass], handle.abort.signal);
      if (this.#settled(handle) || generation !== handle.generation) return;
      const host = structuredClone(handle.host), step = ++handle.toolStep;
      const jobAbort = new AbortController();
      const control = { signal: jobAbort.signal, deadlineMs: handle.deadlineMs };
      if (event.calls.some(call => call.name === 'remember_note')) await this.#waitForOwnerTranscript(handle, event.sequence);
      if (this.#settled(handle) || generation !== handle.generation) return;
      if (event.calls.every(call => call.name === RESEARCH_TOOL_NAME)) {
        const outcome = await this.#researchBatch(handle, event, generation, host, dispatchGate.state === 'allowed');
        if (this.#settled(handle) || generation !== handle.generation) return;
        responses = outcome.responses;
        projections = outcome.projections;
        hostLogEvent({ event: 'live_tool_turn', sequence: event.sequence, toolCallsThisTurn: event.calls.length, toolLatencyMs: [], toolResponseWhileGenerating: handle.speaking });
      } else {
      // One model call fans out to one or more internal reads; a plain call maps to itself. An intent
      // is deliberately never cached: its sub-reads change per query or per minute.
      interface Unit { index: number; call: (typeof event.calls)[number]; intent: IntentToolName | undefined; subs: { key: string; name: string; args: JsonObject }[]; plan: ReturnType<typeof planIntent> | undefined }
      type Batch = Awaited<ReturnType<typeof runToolCalls>>;
      const units: Unit[] = event.calls.map((call, index) => {
        if (!isIntentTool(call.name)) return { index, call, intent: undefined, subs: [{ key: call.id, name: call.name, args: call.args as JsonObject }], plan: undefined };
        const plan = planIntent(call.name, call.args);
        return { index, call, intent: call.name, subs: plan.calls.map((sub, n) => ({ key: `${call.id}~${n}`, name: sub.name, args: sub.args })), plan };
      });
      const cache = handle.toolCache;
      const cached = new Map<number, { response: JsonObject; projection: LiveToolProjection }>();
      const pending: Unit[] = [];
      for (const unit of units) {
        const hit = unit.intent === undefined && cache.cacheable(unit.call.name) ? cache.get<{ response: JsonObject; projection: LiveToolProjection }>(unit.call.name, unit.call.args) : undefined;
        if (!hit) { pending.push(unit); continue; }
        hostLogEvent({ event: 'live_read_cache', tool: unit.call.name, cached: true });
        cached.set(unit.index, hit);
      }
      // One AbortController per model call; the batch stays a single dispatch so same-endpoint reads
      // keep their order, and a cancellation aborts exactly its own call. Each intent sub-read also
      // carries its own deadline, so one slow source never holds the whole turn.
      const signals = new Map<string, AbortSignal>();
      const registerSignals = (unit: Unit, subs: { key: string }[]): void => {
        const aborter = handle.callAborts.get(unit.call.id)!;
        const bounded = unit.intent === undefined ? aborter.signal : AbortSignal.any([aborter.signal, AbortSignal.timeout(INTENT_SUB_DEADLINE_MS)]);
        for (const sub of subs) signals.set(sub.key, bounded);
      };
      for (const unit of pending) {
        handle.callAborts.set(unit.call.id, new AbortController());
        handle.callStartedAt.set(unit.call.id, this.#now());
        registerSignals(unit, unit.subs);
      }
      const subCalls = pending.flatMap(unit => unit.subs.map(sub => ({ id: sub.key, name: sub.name, args: sub.args })));
      const offsets = new Map<number, number>();
      { let at = 0; for (const unit of pending) { offsets.set(unit.index, at); at += unit.subs.length; } }
      const runBatch = async (calls: { id: string; name: string; args: JsonObject }[], useStep: number): Promise<Batch | undefined> => {
        if (calls.length === 0) return undefined;
        if (this.#settled(handle) || generation !== handle.generation) throw new LiveError('invalidated');
        const raw = await runToolCalls(this.#tools!.owner, calls, { registry: handle.registry, host, signals,
          authority: { isCurrent: async (_host, _tool, signal) => dispatchGate.state === 'allowed' && !signal.aborted && generation === handle.generation && !this.#settled(handle) }, control,
          step: useStep, contentIndex: 0, seenIds: handle.seenIds, baseClasses: [handle.inputClass] });
        // Completion never sends to the old transport. With no active authority, retain references for pickup.
        if (!this.lookupAuthority(host.runId) && !this.lookupJobAuthority(host.runId)) return raw;
        return await authorizeToolBatch(this.#tools!.owner, raw, { host, control, baseClasses: [handle.inputClass] });
      };
      const readSub = (source: Batch | undefined, key: string, name: string): IntentSubResult => {
        const slot = source?.bindings.findIndex(binding => binding.callId === key) ?? -1;
        const record = slot >= 0 ? source!.tools[slot] : undefined;
        const accepted = source?.accepted.find(result => result.binding.callId === key);
        const response = accepted?.response ?? {};
        const text = typeof response.text === 'string' ? response.text : '';
        const ok = record?.status === 'completed' && accepted !== undefined;
        return { key, name, ok, text, originalCharacters: typeof response.originalCharacters === 'number' ? response.originalCharacters : text.length, omittedCharacters: typeof response.omittedCharacters === 'number' ? response.omittedCharacters : 0 };
      };
      const batch = await runBatch(subCalls, step);
      if ((this.#settled(handle) || generation !== handle.generation)) return;
      // Phase 2: calendar and brief enumerate their calendars first, then read a bounded event slice
      // per calendar id the shaped list carried, so the calendar intent covers every calendar.
      const followUps = new Map<number, IntentSubCall[]>();
      const phase2: { id: string; name: string; args: JsonObject }[] = [];
      for (const unit of pending) {
        if (unit.plan?.follow === undefined) continue;
        const phase1 = unit.subs.map(sub => readSub(batch, sub.key, sub.name));
        const extra = unit.plan.follow(phase1).map((call, n) => ({ key: `${unit.call.id}~f${n}`, name: call.name, args: call.args }));
        if (extra.length === 0) continue;
        followUps.set(unit.index, extra);
        registerSignals(unit, extra);
        phase2.push(...extra.map(sub => ({ id: sub.key, name: sub.name, args: sub.args })));
      }
      const followBatch = await runBatch(phase2, ++handle.toolStep);
      if ((this.#settled(handle) || generation !== handle.generation)) return;
      for (const unit of pending) handle.callAborts.delete(unit.call.id);
      responses = event.calls.map((call, index) => {
        const hit = cached.get(index);
        if (hit) { projections[index] = hit.projection; return { id: call.id, name: call.name, response: hit.response }; }
        const unit = units[index]!;
        const base = offsets.get(index) ?? 0;
        const record = batch?.tools[base];
        const reason = batch?.error?.reason ?? record?.reason ?? 'tool_result_denied';
        if (unit.intent !== undefined && unit.plan !== undefined && batch) {
          const first = unit.subs.map(sub => readSub(batch, sub.key, sub.name));
          const second = (followUps.get(index) ?? []).map(sub => readSub(followBatch, sub.key, sub.name));
          const subResults = [...first, ...second];
          const digest = unit.plan.combine(subResults);
          const ok = subResults.some(result => result.ok);
          projections[index] = { name: call.name, status: ok ? 'completed' : 'error', markdown: noEmptyResult(digest.text), sources: [] };
          return { id: call.id, name: call.name, response: ok ? intentResponse(digest, unit.intent) : { error: reason } };
        }
        const accepted = batch?.accepted.find(result => result.binding.callId === call.id && result.binding.name === call.name);
        const completed = accepted !== undefined && record?.status === 'completed';
        const markdown = completed ? noEmptyResult(typeof accepted.response.markdown === 'string' ? accepted.response.markdown : typeof accepted.response.text === 'string' ? accepted.response.text : reason) : reason;
        const sources = completed ? sourceCards({ text: accepted.response.text, markdown: accepted.response.markdown, sources: accepted.response.sources }, Infinity) : [];
        const projection: LiveToolProjection = { name: call.name, status: completed ? 'completed' : 'error', markdown, sources };
        projections[index] = projection;
        if (completed && cache.cacheable(call.name)) cache.set(call.name, call.args, { response: accepted.response, projection });
        return { id: call.id, name: call.name, response: completed ? accepted.response : { error: reason } };
      });
      // Per-turn metadata only: the traces the council requires before any playback fence.
      const latency: { tool: string; ms: number }[] = [];
      for (const unit of pending) {
        const started = handle.callStartedAt.get(unit.call.id);
        if (started !== undefined) latency.push({ tool: unit.call.name, ms: Math.max(0, this.#now() - started) });
        handle.callStartedAt.delete(unit.call.id);
      }
      // F6 diagnostics: the peak in-flight count per endpoint for this batch, endpoints and counts only.
      const peaks = new Map<string, number>();
      for (const sub of subCalls) {
        const endpoint = handle.registry.find(tool => tool.name === sub.name)?.endpointId;
        if (endpoint !== undefined) peaks.set(endpoint, (peaks.get(endpoint) ?? 0) + 1);
      }
      const peakInFlight = [...peaks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([endpoint, count]) => ({ endpoint, peak: count }));
      hostLogEvent({ event: 'live_tool_turn', sequence: event.sequence, toolCallsThisTurn: units.reduce((sum, unit) => sum + unit.subs.length + (followUps.get(unit.index)?.length ?? 0), 0), toolLatencyMs: latency, toolResponseWhileGenerating: handle.speaking, peakInFlight });
      }
    }
    if ((this.#settled(handle) || generation !== handle.generation)) return;
    for (const [index, projection] of projections.entries()) {
      const id = event.calls[index]!.id;
      if (handle.pendingCallIds.has(id)) publish('toolResult', handle.bargeInCallIds.has(id) ? { ...projection, code: 'after_barge_in' } : projection);
    }
    responses = responses.filter(response => handle.pendingCallIds.has(response.id));
    if (!(this.#settled(handle) || generation !== handle.generation)) {
      try {
        if (responses.length) {
          handle.session.sendToolResponse({ responses });
        }
      } catch { /* A cancelled provider batch or terminal transport cannot receive late answers. */ }
    }
    for (const call of event.calls) { handle.pendingCallIds.delete(call.id); handle.bargeInCallIds.delete(call.id); }
    // A tool result keeps thinking until the model's first output audio or an explicit wait for input,
    // so the orb never flashes LISTENING between the tool and her speech (F1).
    handle.thinking = responses.length > 0 || handle.pendingCallIds.size > 0;
  }
  #persist(handle: ActiveSession, event: { type: 'continuity' | 'remember_deferred'; sequence: number; text: string } | LiveVoiceEvent | { type: 'toolCall' | 'toolResult'; sequence: number; tool: LiveToolProjection }, kind: JournalKind, transaction?: Transaction): number | 'overflow' {
    const text = 'text' in event ? event.text : null;
    const finished = 'finished' in event && event.finished !== undefined ? (event.finished ? 1 : 0) : null;
    const value = event.type === 'waitingForInput' ? (event.value ? 1 : 0) : null;
    const toolJSON = 'tool' in event ? JSON.stringify(event.tool) : null;
    const bytes = toolJSON ? Buffer.byteLength(toolJSON) : kind === 'continuity' ? Buffer.byteLength(text ?? '') : retainedBytes(kind, text);
    const limits = this.#profile.limits;
    if (handle.journalEvents + 1 > limits.journalMaxEvents || handle.journalBytes + bytes > limits.journalMaxBytes) return 'overflow';
    const now = this.#now();
    const events = handle.journalEvents + 1;
    const total = handle.journalBytes + bytes;
    const persist = (tx: Transaction) => {
      tx.run('INSERT INTO live_journal(live_session_id, provider_sequence, kind, text, finished, value, tool_json, terminal_outcome, rejected_kind, rejected_sequence, payload_bytes, arrived_at) VALUES (?,?,?,?,?,?,?,NULL,NULL,NULL,?,?)',
        [handle.liveSessionId, event.sequence, kind, text, finished, value, toolJSON, bytes, now]);
      tx.run('UPDATE live_sessions SET journal_events=?, journal_bytes=?, ready=CASE WHEN ?=1 THEN 1 ELSE ready END, updated_at=? WHERE live_session_id=?',
        [events, total, kind === 'ready' ? 1 : 0, now, handle.liveSessionId]);
      return Number(tx.get('SELECT journal_id FROM live_journal WHERE live_session_id=? ORDER BY journal_id DESC LIMIT 1', [handle.liveSessionId])!['journal_id']);
    };
    const journalSequence = transaction ? persist(transaction) : this.#store.transaction(persist);
    handle.journalEvents = events;
    handle.journalBytes = total;
    return journalSequence;
  }

  #settled(handle: ActiveSession): boolean { return handle.terminal || handle.invalidated; }

  #settle(handle: ActiveSession, outcome: LiveTerminalOutcome, complete: boolean, consumerState: LiveConsumerState, rejected: { kind: JournalKind; sequence: number } | null): void {
    if (handle.terminal) return;
    handle.terminal = true;
    handle.terminalOutcome = outcome;
    handle.diagnosticTerminalCode = 'code' in outcome ? outcome.code : outcome.state;
    handle.sessionTimer?.cancel(); handle.idleTimer?.cancel();
    handle.session.close();
    let journalSequence: number;
    try {
      journalSequence = this.#store.transaction(tx => this.#terminalInTx(tx, handle.liveSessionId, outcome, complete, this.#now(), consumerState, rejected));
    } catch (error) {
      // The durable write failed, but the typed terminal fact must still reach the app. Log the failure
      // (bounded fields only) and resolve done with the in-memory outcome so the socket sends the real code.
      handle.persistFailure = error;
      console.error(JSON.stringify({ event: 'live_terminal_write_failed', liveSessionId: handle.liveSessionId,
        code: handle.diagnosticTerminalCode,
        class: error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.constructor.name) ? error.constructor.name : 'Unknown' }));
      handle.consumer?.close();
      handle.abort.abort();
      handle.resolveDone();
      return;
    }
    // The terminal fact is durable before it is emitted; committed markers stay queued on overflow.
    // Distillation is scheduled here, never awaited: close returns immediately.
    this.#onSessionTerminal?.(handle.liveSessionId);
    this.#pushChunk(handle, { kind: 'marker', marker: { kind: 'terminal', sequence: null, journalSequence, text: null, finished: null, value: null } });
    handle.consumer?.close();
    handle.abort.abort();
    handle.resolveDone();
  }

  /** The transaction/lifecycle guard makes attach and every expiry observation share one winner. */
  #expireInTx(tx: Transaction, row: SQLRow, now: number): SQLRow {
    if (row['owner_assistant_id'] !== this.#store.assistantId || row['lifecycle'] !== 'accepted'
      || Number(row['dispatch_intent']) !== 0 || now - Number(row['created_at']) <= this.#profile.limits.unusedMs) return row;
    const id = String(row['live_session_id']);
    this.#terminalInTx(tx, id, { state: 'expired' }, false, now, 'detached', null);
    return tx.get('SELECT * FROM live_sessions WHERE live_session_id=?', [id])!;
  }

  #armExpiry(): void {
    if (this.#closed) return;
    const next = this.#store.transaction(tx => tx.get(
      "SELECT MIN(created_at) AS created_at FROM live_sessions WHERE owner_assistant_id=? AND lifecycle='accepted' AND dispatch_intent=0",
      [this.#store.assistantId])!['created_at']);
    this.#expiryTimer?.cancel();
    this.#expiryTimer = undefined;
    if (next === null) return;
    // Integer milliseconds preserve age > unusedMs, even at equality or after a trusted clock jump.
    // Node's maximum delay is capped to avoid its overflow-to-1ms behavior.
    const delay = Math.min(2_147_483_647, Math.max(1, Number(next) + this.#profile.limits.unusedMs + 1 - this.#now()));
    this.#expiryTimer = this.#schedule(() => {
      if (this.#closed) return;
      this.#expiryTimer = undefined;
      const now = this.#now();
      // Deliberately uncaught: Store rollback plus Node's fatal error seam, never silent retry/success.
      this.#store.transaction(tx => {
        const rows = tx.all("SELECT * FROM live_sessions WHERE owner_assistant_id=? AND lifecycle='accepted' AND dispatch_intent=0 AND created_at < ?",
          [this.#store.assistantId, now - this.#profile.limits.unusedMs]);
        for (const row of rows) this.#expireInTx(tx, row, now);
      });
      this.#armExpiry();
    }, delay);
    this.#expiryTimer.unref();
  }

  #terminalInTx(tx: Transaction, liveSessionId: string, outcome: LiveTerminalOutcome, complete: boolean, now: number, consumerState: LiveConsumerState, rejected: { kind: JournalKind; sequence: number } | null): number {
    tx.run('INSERT INTO live_journal(live_session_id, provider_sequence, kind, text, finished, value, tool_json, terminal_outcome, rejected_kind, rejected_sequence, payload_bytes, arrived_at) VALUES (?,NULL,?,NULL,NULL,NULL,NULL,?,?,?,0,?)',
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
      memory: memoryProjection(row['memory_provenance']),
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
      consumerState: this.#consumerStateOf(row),
      journal: { events: Number(row['journal_events']), bytes: Number(row['journal_bytes']), maxEvents: limits.journalMaxEvents, maxBytes: limits.journalMaxBytes, complete: Number(row['journal_complete']) === 1 },
      terminal: parseTerminal(row['terminal_outcome']),
      createdAt: Number(row['created_at']), updatedAt: Number(row['updated_at']),
    };
  }

  #readSnapshot(liveSessionId: string): LiveSessionSnapshot {
    const snapshot = this.#store.transaction(tx => {
      const row = tx.get('SELECT * FROM live_sessions WHERE live_session_id=?', [liveSessionId]);
      if (!row) throw new LiveError('not_found');
      return this.#snapshot(tx, row);
    });
    // A settle whose durable write failed still reports the real typed outcome to the caller.
    const override = this.#active.get(liveSessionId)?.terminalOutcome;
    return override && snapshot.terminal === null ? { ...snapshot, terminal: override } : snapshot;
  }

  /** A failed detach write leaves the row 'attached'; the in-memory handle is the truth on read. */
  #consumerStateOf(row: SQLRow): LiveSessionSnapshot['consumerState'] {
    const stored = String(row['consumer_state']) as LiveSessionSnapshot['consumerState'];
    if (stored !== 'attached') return stored;
    const handle = this.#active.get(String(row['live_session_id']));
    return handle && !this.#settled(handle) && handle.consumerState === 'attached' ? 'attached' : 'ended';
  }

  #guardOpen(): void { if (this.#closed) throw new LiveError('terminal', 'owner is shut down'); }
}

/** Factory composition: the host supplies the validated profile, the real LiveVoicePort and its credentials. */
export function createLiveSessionOwner(config: LiveOwnerConfig): LiveSessionOwner {
  return new LiveSessionOwner(config);
}

function memoryProjection(value: unknown): import('./types.js').LiveMemoryProjection {
  if (typeof value !== 'string') return { status: 'empty', selected: 0, omitted: 0 };
  const provenance = JSON.parse(value) as import('./types.js').LiveMemoryProvenance;
  return { status: provenance.status, selected: provenance.selectedIds.length, omitted: provenance.omitted.length };
}
