import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advancesExposure, tierOf } from '../tools/tiers.js';

// C-PERMTIER (f): the table is closed. A future send tool is guarded without any code change, and the
// only guard left is sending to another person or an irreversible delete.
test('C-PERMTIER (f): free is an explicit list and everything else is guarded', () => {
  for (const name of ['set_alarm', 'cancel_alarm', 'snooze_alarm', 'list_alarms', 'create_event', 'draft_email',
    'draft_chat', 'remember_note', 'stage_lux_note', 'save_to_vault', 'trello_write',
    'open_source', 'open_home', 'open_file', 'open_app', 'open_web']) {
    assert.equal(tierOf(name), 'free', name);
  }
  for (const name of ['mail_send', 'chat_send', 'delete_event', 'respond_event', 'calendar_write_event', 'unknown_tool']) {
    assert.equal(tierOf(name), 'guarded', name);
  }
});

test('C-PERMTIER: only third-party text advances the exposure position', () => {
  for (const source of ['mail', 'chat', 'web', 'research']) assert.equal(advancesExposure(source), true, source);
  for (const source of ['calendar', 'memory', 'knowledge', 'trello', 'vault', 'alarms', undefined]) assert.equal(advancesExposure(source), false, String(source));
});
