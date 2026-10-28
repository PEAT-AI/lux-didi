import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeEvent } from '../host/log.js';
import { ALARM_LOG_EVENTS, ALARM_LOG_REASONS } from '../host/events.js';

test('alarm logs: closed events and reason codes retain only id and numeric timing', () => {
  for (const event of ALARM_LOG_EVENTS) for (const reason of ALARM_LOG_REASONS) {
    const metadata = { event, alarmId: 'synthetic-alarm', scheduledMs: 1000, actualMs: 2000, reason };
    assert.deepEqual(safeEvent({ ...metadata, ownerWords: 'synthetic private words', displayName: 'Synthetic Owner' }), metadata);
  }
  assert.equal(safeEvent({ event: 'alarm_set', alarmId: 'synthetic', scheduledMs: 1000, actualMs: 2000, reason: 'synthetic private words' }), undefined);
});
