import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AlarmShellBridge, type AlarmDue } from '../host/alarm-scheduler.js';

const occurrence: AlarmDue = {
  id: 'synthetic-occurrence', fireAtUtc: 1000, tz: 'UTC', label: '', state: 'ringing',
  createdJournalId: 'j1', ringStartedAtUtc: 1000, ringDeadlineUtc: 601000,
};

test('alarm shell: disconnection, denied notifications and failed assertion are honest degradation', () => {
  const shell = new AlarmShellBridge();
  assert.deepEqual(shell.health(), { degraded: true, reasons: ['shell_unreachable'] });
  const frames: unknown[] = [];
  const disconnect = shell.bind(frame => { frames.push(frame); return true; });
  assert.equal(shell.health().degraded, true, 'unknown capabilities must not report reliable ringing');
  shell.report({ assertion: true, notifications: true });
  assert.deepEqual(shell.health(), { degraded: false, reasons: [] });
  shell.report({ assertion: false, notifications: false });
  assert.deepEqual(shell.health(), { degraded: true, reasons: ['assertion_failed', 'notifications_denied'] });
  shell.publish(occurrence);
  assert.deepEqual(frames, [{ type: 'alarm_due', alarm: occurrence }]);
  disconnect();
  assert.deepEqual(shell.health(), { degraded: true, reasons: ['shell_unreachable'] });
});

test('alarm shell: delivery failure cannot acknowledge an occurrence or claim a reachable shell', () => {
  const shell = new AlarmShellBridge();
  shell.bind(() => { throw Error('synthetic closed transport'); });
  assert.doesNotThrow(() => shell.publish(occurrence));
  assert.equal(shell.health().degraded, true);
});

test('alarm shell: real HTTP delivers a persisted due frame to an authenticated fake shell', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Store } = await import('../runtime/store.js');
  const { toolsMigrations } = await import('../tools/schema.js');
  const { AlarmScheduler } = await import('../host/alarm-scheduler.js');
  const { listenService } = await import('../http/server.js');
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-alarm-http-'));
  const store = new Store(directory, toolsMigrations);
  let now = 1000000;
  const shell = new AlarmShellBridge();
  const scheduler = new AlarmScheduler({ store, clock: {
    now: () => now, setTimeout: () => 1, clearTimeout: () => {},
  }, emit: alarm => {
    assert.equal(scheduler.list().find(row => row.id === alarm.id)?.state, 'ringing', 'commit before frame');
    shell.publish(alarm);
  }, changed: rows => shell.state(rows) });
  const abort = new AbortController();
  let closeService: (() => Promise<void>) | undefined;
  t.after(async () => { abort.abort(); scheduler.stop(); await closeService?.(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const service = await listenService({ port: 0, store, now: () => now, alarms: { scheduler, shell } });
  closeService = service.close;
  const denied = await fetch(`${service.origin}/v1/alarms/events`);
  assert.equal(denied.status, 401);
  await denied.arrayBuffer();
  const response = await fetch(`${service.origin}/v1/alarms/events`, {
    headers: { authorization: `Bearer ${store.adminCredential}` }, signal: abort.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  let wire = new TextDecoder().decode((await reader.read()).value);
  assert.match(wire, /alarm_state/);
  const alarm = scheduler.set({ fireAtUtc: now + 1000, tz: 'UTC', label: '', createdJournalId: 'synthetic-journal' });
  now += 1000;
  scheduler.recheck('clock_changed');
  for (let reads = 0; reads < 4 && !wire.includes('alarm_due'); reads++) wire += new TextDecoder().decode((await reader.read()).value);
  const frames = wire.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as { type: string; alarm?: AlarmDue });
  const due = frames.find(frame => frame.type === 'alarm_due');
  assert.equal(due?.alarm?.id, alarm.id);
  assert.equal(due?.alarm?.ringDeadlineUtc, now + 600000);
  await reader.cancel();
});
