// M2 (issue 907): the session clock is frozen into the accepted instruction at create, so a session that
// waited past ten minutes, or across the owner's local midnight, no longer describes his now. Such a
// session is discarded and a fresh one composed before audio; it is never patched, and a session inside
// the window is reused as it stands.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { chatMigrations } from '../chat/index.js';
import { domainMigrations } from '../domain/schema.js';
import { createLiveSessionOwner, liveMigrations, validateLiveProfile, type LiveContext } from '../live/index.js';
import type { LiveVoicePort } from '../adapters/live-voice/index.js';
import { Store } from '../runtime/store.js';
import type { HostTaskFactory } from '../tasks/host.js';

const MINUTE = 60 * 1000;
/** 23:58:00 in Jakarta, four minutes before the owner's own midnight. */
const LATE = Date.parse('2026-11-05T16:58:00Z');
const MODEL = 'models/live-clock-test';

/** No provider is ever opened by these cases: every one of them settles before audio. */
const voice = { capabilities: {}, open(): never { throw new Error('the clock suite never opens a provider'); } } as unknown as LiveVoicePort;
const tasks = (() => { throw new Error('the clock suite never starts a task'); }) as unknown as HostTaskFactory;

function owner(t: TestContext): { owner: ReturnType<typeof createLiveSessionOwner>; store: Store; clock: { now: number }; ctx: LiveContext } {
  const dir = mkdtempSync(join(tmpdir(), 'live-clock-'));
  const store = new Store(dir, [...domainMigrations, ...chatMigrations, ...liveMigrations]);
  const profile = validateLiveProfile({ provider: 'gemini', liveModelId: MODEL, voice: 'ExplicitVoice', keyReference: 'test-reference',
    route: { enabled: true, provider: 'gemini', modelId: MODEL, dataClasses: ['ordinary'] },
    prompt: { text: 'Synthetic system', dataClass: 'ordinary' },
    // The unused-session expiry is out of the way, so only the clock rule decides these cases.
    limits: { unusedMs: 3_600_000 } });
  const clock = { now: LATE };
  const live = createLiveSessionOwner({ createTaskRuntime: tasks, store, voice, profile,
    now: () => clock.now, timeZone: 'Asia/Jakarta', schedule: () => ({ unref: () => {}, cancel: () => {} }) });
  t.after(() => { void live.shutdown('app_quit'); rmSync(dir, { recursive: true, force: true }); });
  return { owner: live, store, clock, ctx: { clientId: 'client', auditId: 'audit', authorityEpoch: store.authorityEpoch } };
}

function row(store: Store): { lifecycle: string; observedAt: string; timeZone: string } {
  return store.transaction(tx => {
    const found = tx.get('SELECT lifecycle, observed_at, time_zone FROM live_sessions WHERE lifecycle IS NOT NULL ORDER BY created_at DESC LIMIT 1')!;
    return { lifecycle: String(found['lifecycle']), observedAt: String(found['observed_at']), timeZone: String(found['time_zone']) };
  });
}

test('a session composed before the owner local midnight is discarded, and a fresh one composed', (t) => {
  const h = owner(t);
  const first = h.owner.create({ inputClass: 'ordinary', idempotencyKey: 'clock-midnight' }, h.ctx);
  assert.equal(first.liveSessionId.length > 0, true);
  // Five minutes of waiting: inside the ten minute window, but the owner's local day has turned over.
  h.clock.now = LATE + 5 * MINUTE;
  assert.throws(() => h.owner.attach({ liveSessionId: first.liveSessionId }, h.ctx), { code: 'expired' },
    'a prepared session from the previous owner day never starts audio');
  const second = h.owner.create({ inputClass: 'ordinary', idempotencyKey: 'clock-midnight-next' }, h.ctx);
  assert.notEqual(second.liveSessionId, first.liveSessionId, 'a fresh session is composed');
});

test('a prepared session inside ten minutes, on the same owner day, is reused', (t) => {
  const h = owner(t);
  const first = h.owner.create({ inputClass: 'ordinary', idempotencyKey: 'clock-fresh' }, h.ctx);
  h.clock.now = LATE + 5 * MINUTE;
  const replay = h.owner.create({ inputClass: 'ordinary', idempotencyKey: 'clock-fresh' }, h.ctx);
  assert.equal(replay.liveSessionId, first.liveSessionId, 'the prepared session is the one already there');
});

test('a prepared session older than ten minutes is discarded on replay, never replayed', (t) => {
  const h = owner(t);
  const first = h.owner.create({ inputClass: 'ordinary', idempotencyKey: 'clock-stale' }, h.ctx);
  h.clock.now = LATE + 11 * MINUTE;
  const second = h.owner.create({ inputClass: 'ordinary', idempotencyKey: 'clock-stale' }, h.ctx);
  assert.notEqual(second.liveSessionId, first.liveSessionId, 'the stale instruction is never handed back');
});

test('the session row carries the observed instant in the owner zone and the zone itself', (t) => {
  const h = owner(t);
  h.owner.create({ inputClass: 'ordinary', idempotencyKey: 'clock-record' }, h.ctx);
  const stored = row(h.store);
  assert.equal(stored.timeZone, 'Asia/Jakarta');
  assert.equal(stored.observedAt, '2026-11-05T23:58:00+07:00', 'the instant is written in the owner zone, offset included');
});
