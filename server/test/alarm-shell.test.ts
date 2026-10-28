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
