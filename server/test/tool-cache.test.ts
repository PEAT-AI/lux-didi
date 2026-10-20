import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LiveToolCache, LIVE_CACHED_READS, LIVE_CACHE_TTL_MS } from '../live/tool-cache.js';

test('the allowlist holds exactly the idempotent reads and nothing else', () => {
  assert.deepEqual([...LIVE_CACHED_READS].sort(), ['calendar_list_calendars', 'gmail_get_profile', 'mattermost_list_channels']);
  const cache = new LiveToolCache();
  for (const tool of ['mattermost_list_channels', 'calendar_list_calendars', 'gmail_get_profile']) assert.equal(cache.cacheable(tool), true, tool);
  for (const tool of ['mattermost_search', 'mattermost_get_channel_history', 'mattermost_get_thread', 'search_knowledge', 'remember_note']) assert.equal(cache.cacheable(tool), false, tool);
});

test('the key is the tool name plus canonical JSON of the arguments, order independent', () => {
  const cache = new LiveToolCache();
  assert.equal(cache.key('mattermost_list_channels', { limit: 12 }), cache.key('mattermost_list_channels', { limit: 12 }));
  assert.notEqual(cache.key('mattermost_list_channels', { limit: 12 }), cache.key('mattermost_list_channels', { limit: 13 }));
  assert.notEqual(cache.key('mattermost_list_channels', { limit: 12 }), cache.key('mattermost_search', { limit: 12 }));
  assert.equal(cache.key('t', { a: 1, b: 2 }), cache.key('t', { b: 2, a: 1 }));
});

test('a value is served back until the ten minute TTL lapses', () => {
  let now = 1_000;
  const cache = new LiveToolCache(LIVE_CACHE_TTL_MS, () => now);
  assert.equal(cache.get('mattermost_list_channels', { limit: 12 }), undefined);
  cache.set('mattermost_list_channels', { limit: 12 }, { channels: ['town-square'] });
  assert.deepEqual(cache.get('mattermost_list_channels', { limit: 12 }), { channels: ['town-square'] });
  now += LIVE_CACHE_TTL_MS - 1;
  assert.deepEqual(cache.get('mattermost_list_channels', { limit: 12 }), { channels: ['town-square'] });
  now += 1;
  assert.equal(cache.get('mattermost_list_channels', { limit: 12 }), undefined);
});

test('each instance keys its own session', () => {
  const first = new LiveToolCache();
  const second = new LiveToolCache();
  first.set('mattermost_list_channels', { limit: 12 }, 'first');
  assert.equal(second.get('mattermost_list_channels', { limit: 12 }), undefined);
});
