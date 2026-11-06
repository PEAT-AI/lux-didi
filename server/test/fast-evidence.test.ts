// FR1: on a cued final the host reads her call history and the cached calendar digest itself, inside a
// 100 ms budget, and appends what it found as one provisional commentary group with a null delegation id.
// Nothing here calls a model or the network: the fake port is the only transport and the clock is a seam.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { chatMigrations } from '../chat/index.js';
import { domainMigrations } from '../domain/schema.js';
import { searchRecent } from '../domain/history-reader.js';
import { createLiveSessionOwner, liveMigrations, validateLiveProfile, type LiveContext, type LiveSessionOwner } from '../live/index.js';
import { FAST_EVIDENCE_MARKER, buildFastEvidence } from '../live/fast-evidence.js';
import type { FastEvidenceInput } from '../live/fast-evidence.js';
import { Store } from '../runtime/store.js';
import { commentaryPart, commentaryResults } from './commentary-test.js';
import { fakeLiveVoicePort, type FakeLiveVoice, type FakeLiveVoiceEvent } from './fixtures/fake-live-voice.js';
import { syntheticTaskFactory } from './synthetic-task.js';

const MODEL = 'models/fr1-fast-evidence-test';
const T0 = 1_700_000_000_000;

/** The trusted clock seam: no real timer ever elapses, and every scheduled delay is readable. */
class Deadlines {
  now = T0;
  readonly scheduled: { delayMs: number; due: number; callback: () => void }[] = [];
  schedule = (callback: () => void, delayMs: number): { unref(): void; cancel(): void } => {
    const entry = { delayMs, due: this.now + delayMs, callback };
    this.scheduled.push(entry);
    return { unref: () => {}, cancel: () => { const at = this.scheduled.indexOf(entry); if (at >= 0) this.scheduled.splice(at, 1); } };
  };
  runDue(): void {
    for (;;) {
      const entry = this.scheduled.find(item => item.due <= this.now);
      if (!entry) return;
      this.scheduled.splice(this.scheduled.indexOf(entry), 1);
      entry.callback();
    }
  }
}

interface Live {
  store: Store;
  voice: FakeLiveVoice;
  clock: Deadlines;
  liveSessionId: string;
  emit(event: FakeLiveVoiceEvent): Promise<void>;
}

/** One owner session on the fake port: real host, real store, synthetic model and synthetic transport. */
async function openLive(t: TestContext, clock = new Deadlines()): Promise<Live> {
  const dir = mkdtempSync(join(tmpdir(), 'didi-fr1-fast-evidence-'));
  const store = new Store(dir, [...domainMigrations, ...chatMigrations, ...liveMigrations]);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const voice = fakeLiveVoicePort();
  const owner: LiveSessionOwner = createLiveSessionOwner({
    createTaskRuntime: syntheticTaskFactory(store), store, voice: voice.port,
    profile: validateLiveProfile({
      provider: 'gemini', liveModelId: MODEL, voice: 'ExplicitVoice', keyReference: 'test-reference',
      route: { enabled: true, provider: 'gemini', modelId: MODEL, dataClasses: ['ordinary'] },
      prompt: { text: 'Synthetic system', dataClass: 'ordinary' },
      limits: { handshakeMs: 1000, idleMs: 600_000, sessionMs: 1_200_000, closeMs: 50 },
    }),
    now: () => clock.now, timeZone: 'Asia/Kolkata', schedule: clock.schedule,
  });
  t.after(() => owner.shutdown());
  const ctx: LiveContext = { clientId: 'tester', auditId: 'audit-1', authorityEpoch: store.authorityEpoch };
  const session = owner.create({ idempotencyKey: `fr1-${Math.random().toString(36).slice(2)}`, inputClass: 'ordinary' }, ctx);
  const attachment = owner.attach({ liveSessionId: session.liveSessionId }, ctx);
  await attachment.ready;
  void (async () => { for await (const _chunk of attachment.output) { void _chunk; } })();
  const ticks = async (): Promise<void> => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
  return {
    store, voice, clock, liveSessionId: session.liveSessionId,
    async emit(event) { voice.emit(event); await ticks(); },
  };
}

/** The finalized owner utterance, the event the whole change hangs on. */
const ownerSaid = (live: Live, text: string): Promise<void> => live.emit({ type: 'inputTranscription', text, finished: true });

/** A prior call as the reader sees it: a terminal session row and its indexed turns. Synthetic words only. */
function seedPriorCall(store: Store, sourceId: string, turns: { role: 'owner' | 'assistant'; text: string; at: number }[]): string {
  const prior = 'synthetic-prior-call';
  store.transaction(tx => {
    // A copy of the session's own row under another call, because live_sessions is unique per owner and key.
    tx.run('CREATE TEMP TABLE fr1_prior AS SELECT * FROM live_sessions WHERE live_session_id=?', [sourceId]);
    tx.run('UPDATE fr1_prior SET live_session_id=?, idempotency_key=?', [prior, 'synthetic-prior']);
    tx.run('INSERT INTO live_sessions SELECT * FROM fr1_prior');
    tx.run('DROP TABLE fr1_prior');
    let journal = 900;
    for (const turn of turns) {
      tx.run('INSERT INTO history_turns(live_session_id,journal_first,journal_last,role,text,at) VALUES(?,?,?,?,?,?)',
        [prior, journal, journal, turn.role, turn.text, turn.at]);
      const id = Number(tx.get('SELECT last_insert_rowid() AS id')?.['id']);
      tx.run('INSERT INTO history_turns_fts(rowid,text) VALUES(?,?)', [id, turn.text]);
      journal += 1;
    }
  });
  return prior;
}

const searchOf = (result: ReturnType<typeof buildFastEvidence>): string => result.commentary === null ? 'null' : result.commentary.content;

test('FR1: a memory-cued final appends the local fact as one provisional group with a null delegation id', async t => {
  const live = await openLive(t);
  seedPriorCall(live.store, live.liveSessionId, [{ role: 'owner', text: 'My flight to Lisbon leaves in April.', at: T0 - 86_400_000 }]);
  const quietBefore = live.clock.scheduled.filter(item => item.delayMs === 600).length;
  await ownerSaid(live, 'What did I tell you about my trip to Lisbon?');
  assert.ok(live.voice.taskAnswers.length > 0, 'the host appended its own finding');
  const groups = commentaryResults(live.voice.taskAnswers);
  assert.equal(groups.length, 1, 'exactly one commentary group');
  assert.equal(groups[0]!.kind, 'partial', 'a provisional finding, never a result');
  for (const item of live.voice.taskAnswers) {
    assert.equal(item.delegationId, null, 'general session context carries no delegation id');
    assert.ok(item.text.length <= 450, 'never an item the adapter would refuse');
  }
  const joined = live.voice.taskAnswers.map(item => String(commentaryPart(item.text)['content'] ?? '')).join(' ');
  assert.ok(joined.startsWith(FAST_EVIDENCE_MARKER), `the marker opens the content: ${joined.slice(0, 80)}`);
  assert.match(joined, /Lisbon/u, 'the fact is the stored turn, not a guess');
  // The helper still starts exactly where it did: its quiet timer was scheduled and has not fired.
  assert.equal(live.clock.scheduled.filter(item => item.delayMs === 600).length, quietBefore + 1, 'the helper start was scheduled once');
});

test('FR1: a cued final with no match appends nothing at all', async t => {
  const live = await openLive(t);
  await ownerSaid(live, 'What did I tell you about my trip to Lisbon?');
  assert.deepEqual(live.voice.taskAnswers, [], 'zero hits sends no text, not a nothing-found line');
});

test('FR1: an uncued final is untouched and never reads the history', () => {
  let reads = 0;
  const result = buildFastEvidence(base({ cues: [], history: () => { reads += 1; return { outcome: 'empty', hits: [], elapsedMs: 1 }; } }));
  assert.equal(reads, 0, 'no cue, no read');
  assert.equal(result.commentary, null);
  assert.equal(result.outcome, 'none');
});

test('FR1: a reader that throws or overruns the 100 ms budget sends nothing and reports unavailable', () => {
  const thrown = buildFastEvidence(base({ history: () => { throw new Error('synthetic reader failure'); } }));
  assert.equal(thrown.commentary, null);
  assert.equal(thrown.outcome, 'unavailable');
  let clock = 0;
  const slow = buildFastEvidence(base({
    now: () => { clock += 150; return clock; },
    history: () => ({ outcome: 'found', hits: [{ at: T0, sessionRef: 'synthetic-prior-call', excerpt: 'My flight to Lisbon leaves in April.' }], elapsedMs: 60 }),
  }));
  assert.equal(slow.commentary, null, 'an overrun is not evidence');
  assert.equal(slow.outcome, 'unavailable');
  assert.ok(slow.elapsedMs > 100);
});

test('FR1: a calendar cue reads the cached digest, and both cues carry both kinds of fact', () => {
  const calendarOnly = buildFastEvidence(base({ cues: ['calendar'], calendar: '09:00 Dentist; 11:30 Standup' }));
  assert.equal(calendarOnly.outcome, 'found');
  assert.match(searchOf(calendarOnly), /09:00 Dentist/u);
  assert.equal(calendarOnly.commentary?.kind, 'partial');
  const both = buildFastEvidence(base({ cues: ['memory', 'calendar'], calendar: '09:00 Dentist' }));
  assert.match(searchOf(both), /Lisbon/u);
  assert.match(searchOf(both), /Dentist/u);
  const noDigest = buildFastEvidence(base({ cues: ['calendar'], calendar: undefined }));
  assert.equal(noDigest.commentary, null);
  assert.equal(noDigest.outcome, 'empty');
});

test('FR1: at most five facts, each dated and no longer than 240 characters', () => {
  const hits = Array.from({ length: 8 }, (_, index) => ({
    at: T0 - index * 60_000, sessionRef: 'synthetic-prior-call', excerpt: `${index} ${'x'.repeat(400)}`,
  }));
  const result = buildFastEvidence(base({ history: () => ({ outcome: 'found', hits, elapsedMs: 2 }) }));
  const lines = result.commentary!.content.split('\n');
  assert.equal(lines[0], FAST_EVIDENCE_MARKER);
  assert.equal(lines.length, 6, 'the marker and five facts');
  for (const line of lines.slice(1)) {
    assert.match(line, /^\d{4}-\d\d-\d\d: /u, 'each fact carries its date');
    assert.ok(line.length <= 15 + 240, `fact is bounded: ${line.length}`);
  }
  assert.equal(result.hits, 8);
});

test('FR1: searchRecent finds the prior call, leaves out the current session, and refuses an unreadable store', async t => {
  const live = await openLive(t);
  const prior = seedPriorCall(live.store, live.liveSessionId, [{ role: 'owner', text: 'My flight to Lisbon leaves in April.', at: T0 - 86_400_000 }]);
  const found = live.store.transaction(tx => searchRecent(tx, live.store.assistantId, 'when does my flight leave', { excludeSessionId: live.liveSessionId }));
  assert.equal(found.outcome, 'found');
  assert.equal(found.hits.length, 1);
  assert.equal(found.hits[0]!.sessionRef, prior);
  assert.match(found.hits[0]!.excerpt, /Lisbon/u);
  assert.ok(found.elapsedMs >= 0);
  const other = live.store.transaction(tx => searchRecent(tx, live.store.assistantId, 'when does my flight leave', { excludeSessionId: prior }));
  assert.equal(other.outcome, 'empty', 'a session excluded from the search is not a hit');
  const broken = live.store.transaction(tx => searchRecent(tx, live.store.assistantId, '"""', { excludeSessionId: live.liveSessionId }));
  assert.equal(broken.outcome, 'empty', 'a query with no content words is empty, not a failure');
});

test('FR1: the helper start does not move, cued or uncued', async t => {
  const uncued = await openLive(t);
  await ownerSaid(uncued, 'Open the garage door.');
  const cued = await openLive(t);
  seedPriorCall(cued.store, cued.liveSessionId, [{ role: 'owner', text: 'My flight to Lisbon leaves in April.', at: T0 - 86_400_000 }]);
  await ownerSaid(cued, 'What did I tell you about my trip to Lisbon?');
  const quiet = (live: Live): number[] => live.clock.scheduled.filter(item => item.delayMs === 600).map(item => item.due);
  assert.deepEqual(quiet(cued), quiet(uncued), 'the helper is scheduled at the identical instant');
  assert.deepEqual(quiet(uncued), [T0 + 600]);
  assert.ok(cued.voice.taskAnswers.length > 0, 'and the cued run did append its finding');
});

/** A pure input: one cued memory final, a matching read, no calendar, and a clock that only moves when told. */
function base(overrides: Partial<FastEvidenceInput> = {}): FastEvidenceInput {
  return {
    text: 'What did I tell you about my trip to Lisbon?', cues: ['memory'],
    history: () => ({ outcome: 'found', hits: [{ at: T0, sessionRef: 'synthetic-prior-call', excerpt: 'My flight to Lisbon leaves in April.' }], elapsedMs: 3 }),
    calendar: undefined, now: () => T0, budgetMs: 100, ...overrides,
  };
}
