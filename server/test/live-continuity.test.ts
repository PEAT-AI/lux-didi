import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatMigrations } from '../chat/index.js';
import { domainMigrations } from '../domain/schema.js';
import { createLiveSessionOwner, liveMigrations, SEED_CHAR_LIMIT, validateLiveProfile, type LiveContext, type LiveSessionOwner } from '../live/index.js';
import { Store } from '../runtime/store.js';
import { attachHostLogSink } from '../tools/host-events.js';
import { fakeLiveVoicePort, type FakeLiveVoice, type FakeLiveVoiceEvent } from './fixtures/fake-live-voice.js';
import type { LiveVoicePort } from '../adapters/live-voice/index.js';

const NOW = 1_700_000_000_000;
const MODEL = 'models/live-continuity-test';
const flush = async (): Promise<void> => { for (let i = 0; i < 4; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

/** A clock the test moves itself: nothing sleeps and no timer fires on its own. */
class DeadlineClock {
  now = NOW;
  readonly pending = new Set<{ due: number; callback: () => void }>();
  schedule = (callback: () => void, delayMs: number) => {
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
  owner: LiveSessionOwner; fake: FakeLiveVoice; store: Store;
  /** Set while the owner is meant to be muted: any provider open then fails the test. */
  muted: { value: boolean };
  start(): Promise<{ liveSessionId: string; close: () => void }>;
  emit(event: FakeLiveVoiceEvent): Promise<void>;
  advance(ms: number): Promise<void>;
  conversationOf(liveSessionId: string): string | undefined;
  history(index: number): { role: string; text: string }[];
  terminal(liveSessionId: string): string | undefined;
  journalTexts(liveSessionId: string, kind: string): string[];
}

/** `timeZone: null` leaves the zone to the host, resolved when each call is composed, as production does. */
function openLive(t: TestContext, options: { timeZone?: string | null } = {}): Live {
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-continuity-'));
  const store = new Store(dir, [...domainMigrations, ...chatMigrations, ...liveMigrations]);
  const ctx: LiveContext = { clientId: 'tester', auditId: 'audit-1', authorityEpoch: store.authorityEpoch };
  const clock = new DeadlineClock();
  const fake = fakeLiveVoicePort();
  const muted = { value: false };
  const port = {
    capabilities: fake.port.capabilities,
    open: (request: Parameters<LiveVoicePort['open']>[0], control: Parameters<LiveVoicePort['open']>[1]) => {
      assert.equal(muted.value, false, 'the provider received traffic while muted');
      return fake.port.open(request, control);
    },
  } as LiveVoicePort;
  const profile = validateLiveProfile({
    provider: 'gemini', liveModelId: MODEL, voice: 'ExplicitVoice', keyReference: 'test-reference',
    route: { enabled: true, provider: 'gemini', modelId: MODEL, dataClasses: ['ordinary'] },
    prompt: { text: 'Synthetic system', dataClass: 'ordinary' },
    limits: { handshakeMs: 1000, idleMs: 600_000, sessionMs: 1_200_000, closeMs: 50 },
  });
  const detach = attachHostLogSink({ event: () => {} });
  t.after(() => { detach(); rmSync(dir, { recursive: true, force: true }); });
  const owner = createLiveSessionOwner({ store, voice: port, profile, now: () => clock.now, ...(options.timeZone === null ? {} : { timeZone: options.timeZone ?? 'Asia/Kolkata' }), schedule: clock.schedule });
  const start = async () => {
    const session = owner.create({ idempotencyKey: `continuity-${randomUUID()}`, inputClass: 'ordinary' }, ctx);
    const attachment = owner.attach({ liveSessionId: session.liveSessionId }, ctx);
    await attachment.ready;
    return { liveSessionId: session.liveSessionId, close: () => attachment.close() };
  };
  const rows = <T>(liveSessionId: string, kind: string): T[] => store.transaction(tx => tx.all(
    'SELECT text FROM live_journal WHERE live_session_id=? AND kind=? ORDER BY journal_id', [liveSessionId, kind]) as T[]);
  return {
    owner, fake, store, muted, start,
    emit: async event => { fake.emit(event); await flush(); },
    advance: async ms => { clock.now += ms; clock.runDue(); await flush(); },
    conversationOf: liveSessionId => store.transaction(tx => {
      const row = tx.get('SELECT conversation_id FROM live_session_conversations WHERE live_session_id=?', [liveSessionId]);
      return row?.['conversation_id'] === null || row?.['conversation_id'] === undefined ? undefined : String(row['conversation_id']);
    }),
    history: index => (fake.requests[index]?.history ?? []).map(turn => ({ role: String(turn.role), text: String(turn.text) })),
    terminal: liveSessionId => owner.get(liveSessionId).terminal?.state,
    journalTexts: (liveSessionId, kind) => rows<{ text: string }>(liveSessionId, kind).map(row => String(row.text)),
  };
}

test('mute closes the provider at once, and the same conversation seeds the exchange verbatim', async t => {
  const live = openLive(t);
  const first = await live.start();
  await live.emit({ type: 'inputTranscription', text: 'why was that again', finished: true });
  await live.emit({ type: 'outputTranscription', text: 'Because the meeting moved to Friday.', finished: true });
  await live.emit({ type: 'turnComplete' });
  first.close();
  assert.equal(live.terminal(first.liveSessionId), 'closed', 'mute ends the provider session at once');
  const opened = live.fake.sessionsOpened;
  live.muted.value = true;
  await live.advance(3 * 60 * 60 * 1000);
  assert.equal(live.fake.sessionsOpened, opened, 'nothing reconnects or reopens while muted');
  live.muted.value = false;
  const second = await live.start();
  assert.equal(live.conversationOf(second.liveSessionId), live.conversationOf(first.liveSessionId), 'unmute continues the same conversation');
  assert.deepEqual(live.history(1).slice(-2), [
    { role: 'user', text: 'why was that again' },
    { role: 'model', text: 'Because the meeting moved to Friday.' },
  ], 'the seed ends with the last completed exchange verbatim');
});

test('a mute mid answer seeds only what was heard and keeps the rest apart', async t => {
  const live = openLive(t);
  const first = await live.start();
  await live.emit({ type: 'inputTranscription', text: 'tell me the plan', finished: true });
  await live.emit({ type: 'outputTranscription', text: 'First we ship the ladder', finished: false });
  first.close();
  const unheard = live.journalTexts(first.liveSessionId, 'continuity').map(text => JSON.parse(text) as { event?: string; text?: string });
  assert.equal(unheard.at(-1)?.event, 'unheard', 'the unheard remainder is stored, not dropped');
  assert.equal(unheard.at(-1)?.text, 'First we ship the ladder');
  const second = await live.start();
  assert.equal(live.conversationOf(second.liveSessionId), live.conversationOf(first.liveSessionId));
  const seeded = live.history(1).map(turn => turn.text).join(' ');
  assert.ok(!seeded.includes('First we ship the ladder'), 'words the owner never heard never seed as history');
  assert.match(seeded, /tell me the plan/, 'the question the owner did ask still seeds');
});

test('a provider event that arrives after mute is dropped by the generation fence', async t => {
  const live = openLive(t);
  const first = await live.start();
  first.close();
  await live.emit({ type: 'outputTranscription', text: 'too late to be spoken', finished: true });
  await live.emit({ type: 'turnComplete' });
  assert.equal(live.terminal(first.liveSessionId), 'closed');
  assert.equal(live.fake.sessionsOpened, 1, 'a late event never reopens a session');
  assert.deepEqual(live.journalTexts(first.liveSessionId, 'outputTranscription'), [], 'a late event never restarts playback');
});

test('an explicit new conversation rotates the id, and an ordinary next session does not', async t => {
  const live = openLive(t);
  const first = await live.start();
  const conversation = live.conversationOf(first.liveSessionId);
  assert.ok(conversation, 'every session carries a conversation');
  first.close();
  const second = await live.start();
  assert.equal(live.conversationOf(second.liveSessionId), conversation, 'a new session keeps the conversation');
  second.close();
  const rotated = live.owner.newConversation();
  assert.notEqual(rotated, conversation, 'an explicit new conversation gets a new id');
  const third = await live.start();
  assert.equal(live.conversationOf(third.liveSessionId), rotated, 'the next session belongs to the new conversation');
});

test('budget pressure drops whole older exchanges and never the latest one', async t => {
  const live = openLive(t);
  const first = await live.start();
  const answer = (marker: string) => `${marker}${'x'.repeat(3_000)}`;
  for (const marker of ['A', 'B', 'C']) {
    await live.emit({ type: 'inputTranscription', text: `question ${marker}`, finished: true });
    await live.emit({ type: 'outputTranscription', text: answer(marker), finished: true });
    await live.emit({ type: 'turnComplete' });
  }
  first.close();
  const second = await live.start();
  assert.equal(live.conversationOf(second.liveSessionId), live.conversationOf(first.liveSessionId));
  const seed = live.history(1);
  assert.equal(seed.length % 2, 0, 'the seed never holds half an exchange');
  assert.ok(!seed.some(turn => turn.text.includes('question A')), 'the oldest whole exchange is dropped first');
  assert.deepEqual(seed.slice(-2), [
    { role: 'user', text: 'question C' },
    { role: 'model', text: answer('C') },
  ], 'the latest exchange stays verbatim');
  assert.ok(seed.reduce((sum, turn) => sum + turn.text.length, 0) <= SEED_CHAR_LIMIT, 'the seed never exceeds the history budget');
});

test('each call resolves the owner zone when it is composed', async t => {
  const previous = process.env['TZ'];
  t.after(() => { if (previous === undefined) delete process.env['TZ']; else process.env['TZ'] = previous; });
  process.env['TZ'] = 'Europe/Berlin';
  const live = openLive(t, { timeZone: null });
  const first = await live.start();
  assert.match(live.fake.requests[0]!.system.text, /Now: Tue, 2023-11-14, 23:13 Europe\/Berlin \(UTC\+01:00\)/u,
    'the first call is composed in the zone the host had then');
  first.close();
  // The owner flies east between two calls; the long-lived host follows him per call, not per process.
  await live.advance(67_600_000);
  process.env['TZ'] = 'Asia/Singapore';
  const second = await live.start();
  assert.match(live.fake.requests[1]!.system.text, /Now: Thu, 2023-11-16, 01:00 Asia\/Singapore \(UTC\+08:00\)/u,
    'the second call is composed in the zone the host has now');
  second.close();
});
