import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { toolsMigrations } from '../tools/schema.js';
import { AlarmScheduler, AlarmSessionCoordinator } from '../host/alarm-scheduler.js';
import { alarmSessionInstructions } from '../live/index.js';

for (const alreadyLive of [false, true]) {
  test(`alarm mode: ${alreadyLive ? 'live session gets no injected text or rebuild' : 'unavailable provider gets at most one attempt'}`, t => {
    const directory = mkdtempSync(join(tmpdir(), 'synthetic-alarm-mode-'));
    const store = new Store(directory, toolsMigrations);
    const scheduler = new AlarmScheduler({ store, clock: { now: () => 1000, setTimeout: () => 1, clearTimeout: () => {} }, emit: () => {} });
    t.after(() => { scheduler.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); });
    const alarm = scheduler.set({ fireAtUtc: 1000, tz: 'UTC', label: '', createdJournalId: 'j1' });
    let opens = 0;
    const degraded: string[] = [];
    const coordinator = new AlarmSessionCoordinator({ store, hasLiveSession: () => alreadyLive,
      open: () => { opens++; throw Error('synthetic unavailable'); }, degraded: (_id, reason) => degraded.push(reason) });
    const first = coordinator.attempt(alarm.id, 'Synthetic Owner');
    assert.equal(first.status, alreadyLive ? 'live' : 'unavailable');
    coordinator.attempt(alarm.id, 'Synthetic Owner');
    assert.equal(opens, alreadyLive ? 0 : 1);
    assert.equal(scheduler.list()[0]?.state, 'ringing', 'provider result cannot stop local ringing');
    assert.ok(degraded.includes(alreadyLive ? 'live_session_no_channel' : 'provider_unavailable'));
  });
}

test('alarm mode: only the display name and scheduled time enter setup instructions', () => {
  const setup = alarmSessionInstructions({ ownerDisplayName: 'Synthetic Owner', scheduledTime: '08:00' });
  assert.match(setup, /Synthetic Owner/);
  assert.match(setup, /08:00/);
  assert.match(setup, /alarm mode/i);
  assert.doesNotMatch(setup, /calendar|mail|role.*user/i);
});

test('alarm guidance names all four tools and states the sleep and closed-lid limits', async () => {
  const { NAYA_VOICE_TOOLS } = await import('../prompt/live-persona.js');
  assert.ok(NAYA_VOICE_TOOLS.includes('set_alarm/list_alarms/cancel_alarm/snooze_alarm may fail asleep or lid closed.'));
});
