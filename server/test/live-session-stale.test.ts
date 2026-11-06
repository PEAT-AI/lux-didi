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
/** 23:55:00 in Jakarta, five minutes before the owner's own midnight. */
const LATE = Date.parse('2026-11-05T16:55:00Z');
/** 06:45:58 in Jakarta, the call that started this issue: nowhere near a day boundary. */
const MORNING = Date.parse('2026-11-05T23:45:58Z');
const MODEL = 'models/live-clock-test';

/** No provider is ever opened by these cases: every one of them settles before audio. */
const voice = { capabilities: {}, open(): never { throw new Error('the clock suite never opens a provider'); } } as unknown as LiveVoicePort;
const tasks = (() => { throw new Error('the clock suite never starts a task'); }) as unknown as HostTaskFactory;

function owner(t: TestContext, zone: { timeZone: string; timeZoneSource?: 'pin' | 'host' | 'settings' } = { timeZone: 'Asia/Jakarta' }): { owner: ReturnType<typeof createLiveSessionOwner>; store: Store; clock: { now: number }; ctx: LiveContext } {
  const dir = mkdtempSync(join(tmpdir(), 'live-clock-'));
  const store = new Store(dir, [...domainMigrations, ...chatMigrations, ...liveMigrations]);
  const profile = validateLiveProfile({ provider: 'gemini', liveModelId: MODEL, voice: 'ExplicitVoice', keyReference: 'test-reference',
    route: { enabled: true, provider: 'gemini', modelId: MODEL, dataClasses: ['ordinary'] },
    prompt: { text: 'Synthetic system', dataClass: 'ordinary' },
    // The unused-session expiry is out of the way, so only the clock rule decides these cases.
    limits: { unusedMs: 3_600_000 } });
  const clock = { now: LATE };
  const live = createLiveSessionOwner({ createTaskRuntime: tasks, store, voice, profile,
    now: () => clock.now, ...zone, schedule: () => ({ unref: () => {}, cancel: () => {} }) });
  t.after(() => { void live.shutdown('app_quit'); rmSync(dir, { recursive: true, force: true }); });
  return { owner: live, store, clock, ctx: { clientId: 'client', auditId: 'audit', authorityEpoch: store.authorityEpoch } };
}

function row(store: Store, liveSessionId: string): { lifecycle: string } {
  return store.transaction(tx => {
    const found = tx.get('SELECT lifecycle FROM live_sessions WHERE live_session_id=?', [liveSessionId])!;
    return { lifecycle: String(found['lifecycle']) };
  });
}

test('a prepared session composed before the owner local midnight is discarded, not started', (t) => {
  const h = owner(t);
  const first = h.owner.create({ inputClass: 'ordinary', idempotencyKey: 'clock-midnight' }, h.ctx);
  // Seven minutes of waiting: inside the ten minute window, but the owner's own day has turned over.
  h.clock.now = LATE + 7 * MINUTE;
  assert.throws(() => h.owner.attach({ liveSessionId: first.liveSessionId }, h.ctx), { code: 'expired' },
    'a session composed on the previous owner day never starts audio');
  assert.equal(row(h.store, first.liveSessionId).lifecycle, 'terminal', 'the stale session is discarded');
});

test('a prepared session older than ten minutes is discarded, not started', (t) => {
  const h = owner(t);
  h.clock.now = MORNING;
  const first = h.owner.create({ inputClass: 'ordinary', idempotencyKey: 'clock-old' }, h.ctx);
  h.clock.now = MORNING + 11 * MINUTE;
  assert.throws(() => h.owner.attach({ liveSessionId: first.liveSessionId }, h.ctx), { code: 'expired' },
    'a session composed eleven minutes ago never starts audio');
  assert.equal(row(h.store, first.liveSessionId).lifecycle, 'terminal');
});

test('a prepared session inside ten minutes, on the same owner day, is reused as it stands', (t) => {
  const h = owner(t);
  const first = h.owner.create({ inputClass: 'ordinary', idempotencyKey: 'clock-fresh' }, h.ctx);
  h.clock.now = LATE + 5 * MINUTE;
  const replay = h.owner.create({ inputClass: 'ordinary', idempotencyKey: 'clock-fresh' }, h.ctx);
  assert.equal(replay.liveSessionId, first.liveSessionId, 'the prepared session is the one already there');
  assert.equal(row(h.store, first.liveSessionId).lifecycle, 'accepted', 'and it is still prepared, never patched');
});

test('the session row carries the observed instant in the owner zone and the zone itself', (t) => {
  const h = owner(t);
  h.clock.now = MORNING;
  h.owner.create({ inputClass: 'ordinary', idempotencyKey: 'clock-record' }, h.ctx);
  const stored = h.store.transaction(tx => tx.get('SELECT observed_at, time_zone FROM live_sessions LIMIT 1')!);
  assert.equal(String(stored['time_zone']), 'Asia/Jakarta');
  assert.equal(String(stored['observed_at']), '2026-11-06T06:45:58+07:00', 'the instant is written in the owner zone, offset included');
});

test('M2: the owner settings zone is the session zone, and the record carries it with that offset', (t) => {
  const h = owner(t, { timeZone: 'Europe/Berlin', timeZoneSource: 'settings' });
  h.clock.now = MORNING;
  h.owner.create({ inputClass: 'ordinary', idempotencyKey: 'clock-settings' }, h.ctx);
  const stored = h.store.transaction(tx => tx.get('SELECT observed_at, time_zone FROM live_sessions LIMIT 1')!);
  assert.equal(String(stored['time_zone']), 'Europe/Berlin', 'the override wins over the host zone');
  assert.equal(String(stored['observed_at']), '2026-11-06T00:45:58+01:00', 'the instant is the owner zone instant');
});
