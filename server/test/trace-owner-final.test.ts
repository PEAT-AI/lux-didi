// C-TRACE: the record of a call is complete and truthful. One owner utterance whose deltas the model's
// own speech cut must reach the trace and the conversation history as the words he said, the turn's own
// outcome must say she spoke when she did, and an uncertain attribution must mean one.
import { syntheticTaskFactory } from './synthetic-task.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatMigrations } from '../chat/index.js';
import { domainMigrations } from '../domain/schema.js';
import { persistHistoryTurns } from '../domain/history-turns.js';
import { createLiveSessionOwner, liveMigrations, validateLiveProfile,
  type LiveContext, type LiveSessionOwner } from '../live/index.js';
import { Store } from '../runtime/store.js';
import { fakeLiveVoicePort, type FakeLiveVoice, type FakeLiveVoiceEvent } from './fixtures/fake-live-voice.js';

const NOW = 1_700_000_000_000;
const MODEL = 'models/trace-owner-final-test';
const flush = async (): Promise<void> => { for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

/** A deadline clock: nothing sleeps, the test moves time and the owner's timers fire in due order. */
class DeadlineClock {
  now = NOW;
  readonly pending = new Set<{ due: number; callback: () => void }>();
  schedule = (callback: () => void, delayMs: number) => {
    assert.ok(delayMs > 0, 'a zero-delay loop is a bug, not a schedule');
    const entry = { due: this.now + delayMs, callback };
    this.pending.add(entry);
    return { unref: () => {}, cancel: () => { this.pending.delete(entry); } };
  };
  runDue(): void {
    for (;;) {
      const entry = [...this.pending].find(item => item.due <= this.now);
      if (!entry) return;
      this.pending.delete(entry);
      entry.callback();
    }
  }
}

interface Live {
  store: Store;
  fake: FakeLiveVoice;
  liveSessionId: string;
  emit(event: FakeLiveVoiceEvent): Promise<void>;
  advance(ms: number): Promise<void>;
}

/** Open one owner session on the fake port with an injected clock, the way the replay fixtures do. */
async function openLive(t: TestContext): Promise<Live> {
  const dir = mkdtempSync(join(tmpdir(), 'didi-trace-owner-final-'));
  const store = new Store(dir, [...domainMigrations, ...chatMigrations, ...liveMigrations]);
  const ctx: LiveContext = { clientId: 'tester', auditId: 'audit-1', authorityEpoch: store.authorityEpoch };
  const scheduler = new DeadlineClock();
  const fake = fakeLiveVoicePort();
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  const profile = validateLiveProfile({
    provider: 'gemini', liveModelId: MODEL, voice: 'ExplicitVoice', keyReference: 'test-reference',
    route: { enabled: true, provider: 'gemini', modelId: MODEL, dataClasses: ['ordinary'] },
    prompt: { text: 'Synthetic system', dataClass: 'ordinary' },
    limits: { handshakeMs: 1000, idleMs: 600_000, sessionMs: 1_200_000, closeMs: 50 },
  });
  const owner: LiveSessionOwner = createLiveSessionOwner({ createTaskRuntime: syntheticTaskFactory(store), store, voice: fake.port, profile,
    now: () => scheduler.now, timeZone: 'Asia/Kolkata', schedule: scheduler.schedule });
  const session = owner.create({ idempotencyKey: `trace-owner-${randomUUID()}`, inputClass: 'ordinary' }, ctx);
  const attachment = owner.attach({ liveSessionId: session.liveSessionId }, ctx);
  await attachment.ready;
  void (async () => { for await (const _chunk of attachment.output) { void _chunk; } })();
  t.after(() => { attachment.close(); });
  return { store, fake, liveSessionId: session.liveSessionId,
    emit: async event => { fake.emit(event); await flush(); },
    advance: async ms => { scheduler.now += ms; scheduler.runDue(); await flush(); } };
}

/** An owner delta: the provider's incremental view of the sentence he is still saying. */
const ownerPartial = (live: Live, text: string): Promise<void> => live.emit({ type: 'inputTranscription', text, finished: false });
const ownerSaid = (live: Live, text: string): Promise<void> => live.emit({ type: 'inputTranscription', text, finished: true });
const modelTurn = (live: Live): Promise<void> => live.emit({ type: 'modelTurnStarted' });
const turnComplete = (live: Live): Promise<void> => live.emit({ type: 'turnComplete' });
const audible = (live: Live): Promise<void> => live.emit({ type: 'audio', pcm: new Uint8Array(960), rate: 24_000, audible: true, rmsDbfs: -20 });

/** His words in the trace: the turn's rows, in journal order, with the turn they are attached to. */
const traceUtterance = (live: Live): { text: string; final: number; turnId: string | null }[] => live.store.transaction(tx => tx.all(
  "SELECT text, final, turn_id FROM trace_utterance WHERE role='owner' ORDER BY journal_id")
  .map(row => ({ text: String(row.text), final: Number(row.final), turnId: row.turn_id === null ? null : String(row.turn_id) })));

/** The unattributed count the store keeps for a call whose transcripts could not be placed on a turn. */
const unattributed = (live: Live): number => Number(live.store.transaction(tx => tx.get(
  'SELECT COALESCE(diagnostic_unattributed_transcripts,0) AS n FROM live_sessions WHERE live_session_id=?', [live.liveSessionId]))?.['n'] ?? 0);

test('C-TRACE 1: an owner utterance cut by her speech is finalized from its own deltas', async t => {
  const live = await openLive(t);
  await ownerPartial(live, 'what is ');
  await ownerPartial(live, 'the weather');
  // She answers before the provider ever finishes his sentence: the cut deltas are the only record of it.
  await modelTurn(live);
  await audible(live);
  await turnComplete(live);
  const turn = `${live.liveSessionId}:t1`;
  // T1: the assembled final is his turn's, never the model's, and it carries the turn id the audit reads.
  assert.deepEqual(traceUtterance(live), [
    { text: 'what is ', final: 0, turnId: turn },
    { text: 'the weather', final: 0, turnId: turn },
    { text: 'what is the weather', final: 1, turnId: turn },
  ]);
  // T2: his words were placed on a turn, so the call is not counted as carrying unattributed transcripts.
  assert.equal(unattributed(live), 0);
});

test('C-TRACE 1: the assembled final stays on his turn while her own words have theirs', async t => {
  const live = await openLive(t);
  await ownerPartial(live, 'what is ');
  await ownerPartial(live, 'the weather');
  await modelTurn(live);
  await live.emit({ type: 'outputTranscription', text: 'A synthetic answer.', finished: true });
  await audible(live);
  await turnComplete(live);
  const rows = live.store.transaction(tx => tx.all("SELECT role, turn_id, final FROM trace_utterance ORDER BY journal_id"));
  const owner = rows.filter(row => String(row.role) === 'owner');
  assert.deepEqual(owner.map(row => [String(row.turn_id), Number(row.final)]), [
    [`${live.liveSessionId}:t1`, 0], [`${live.liveSessionId}:t1`, 0], [`${live.liveSessionId}:t1`, 1],
  ]);
  const model = rows.filter(row => String(row.role) === 'model');
  assert.ok(model.length >= 1, 'her own words are the model rows of this call');
  for (const row of model) assert.notEqual(String(row.turn_id), `${live.liveSessionId}:t1`, 'no model row is his turn');
});

test('C-TRACE 1: the same cut utterance is a turn of its own in history_turns', async t => {
  const live = await openLive(t);
  await ownerPartial(live, 'what is ');
  await ownerPartial(live, 'the weather');
  await modelTurn(live);
  await audible(live);
  await turnComplete(live);
  live.store.transaction(tx => tx.run("UPDATE live_sessions SET lifecycle='terminal' WHERE live_session_id=?", [live.liveSessionId]));
  const inserted = live.store.transaction(tx => persistHistoryTurns(tx, live.liveSessionId));
  const rows = live.store.transaction(tx => tx.all("SELECT role, text FROM history_turns WHERE role='owner' ORDER BY id"));
  assert.deepEqual(rows.map(row => String(row.text)), ['what is the weather']);
  assert.equal(inserted, 1);
});

test('C-TRACE 2: attributionUncertain is true only where a turn really replaced another', async t => {
  const live = await openLive(t);
  await ownerSaid(live, 'first question');
  await modelTurn(live);
  await turnComplete(live);
  await ownerSaid(live, 'second question');
  await modelTurn(live);
  await turnComplete(live);
  // A third utterance arrives before the provider closed the second turn, which is the real ambiguity:
  // the provider's own transcript cannot say which turn it belongs to.
  await ownerSaid(live, 'third');
  await ownerSaid(live, 'question');
  await modelTurn(live);
  await turnComplete(live);
  const turns = live.store.transaction(tx => tx.all('SELECT turn_index, supersedes_turn_id, attribution_uncertain FROM trace_turn ORDER BY turn_index'));
  assert.deepEqual(turns.map(row => [Number(row.turn_index), row.supersedes_turn_id ?? null, Number(row.attribution_uncertain)]), [
    [1, null, 0],
    [2, null, 0],
    [3, null, 0],
    [4, `${live.liveSessionId}:t3`, 1],
  ]);
});

test('C-TRACE 3: a turn answered by a later response says answered and keeps its first audible moment', async t => {
  const live = await openLive(t);
  await ownerSaid(live, 'answer me');
  // The provider opens a second response inside the same turn and it carries no audio of its own: without a
  // turn-scoped audible clock the turn would claim nothing was ever heard.
  await modelTurn(live);
  await audible(live);
  await modelTurn(live);
  await turnComplete(live);
  const turn = live.store.transaction(tx => tx.get('SELECT outcome, first_audible_at FROM trace_turn ORDER BY turn_index LIMIT 1'));
  assert.equal(turn?.outcome, 'answered');
  assert.ok(Number(turn?.first_audible_at) > 0, 'the first audible moment of the turn is recorded');
});
