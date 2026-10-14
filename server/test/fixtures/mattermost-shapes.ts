/**
 * Synthetic Mattermost tool-output shapes, copied from the upstream mattermost-mcp
 * serializer (src/search/serialize.ts and src/mcp/tools.ts) plus REST v4 `/posts`.
 * Invented names and text only: no real account, message or corpus. Every shape here
 * shaped to '' before W12, which is the defect this fixture set pins.
 */

/** mattermost_whoami */
export const WHOAMI = { id: 'u1', username: 'river', email: 'river@example.invalid' };

/** mattermost_search / mattermost_get_channel_history (serializeSearch) */
export const SEARCH_RESULTS = {
  total: 2,
  returned: 2,
  results: [
    { id: 'p1', username: 'river', channel: 'harbour', timestamp: '2026-10-11T10:00:00.000Z', message: 'Mooring drift log is ready', url: 'https://chat.example.invalid/t/harbour/pl/p1', channelName: 'harbour', rootId: '', replyCount: 3, editedAt: null, score: 0.91 },
    { id: 'p2', username: 'ash', channel: 'harbour', timestamp: '2026-10-11T10:05:00.000Z', message: 'Reviewed the mooring drift log', url: 'https://chat.example.invalid/t/harbour/pl/p2', channelName: 'harbour', rootId: '', replyCount: 0, editedAt: null, score: 0.72 },
  ],
};

/** A genuinely empty search: total 0, an empty results array. */
export const SEARCH_EMPTY = { total: 0, returned: 0, results: [] };

/** mattermost_get_thread (serializeThread) */
export const THREAD = {
  root: { id: 'p1', username: 'river', channel: 'harbour', timestamp: '2026-10-11T10:00:00.000Z', message: 'Mooring drift log is ready', url: 'https://chat.example.invalid/t/harbour/pl/p1', channelName: 'harbour', rootId: '', replyCount: 1, editedAt: null },
  replies: [
    { id: 'p2', username: 'ash', channel: 'harbour', timestamp: '2026-10-11T10:05:00.000Z', message: 'Reviewed the mooring drift log', url: 'https://chat.example.invalid/t/harbour/pl/p2', channelName: 'harbour', rootId: 'p1', replyCount: 0, editedAt: null },
  ],
  attachments: { p1: [{ name: 'drift.csv', extension: 'csv', size: 2048 }] },
};

/** mattermost_list_channels */
export const CHANNELS = {
  count: 2,
  channels: [
    { id: 'c1', name: 'harbour', displayName: 'Harbour', team: 'ops', type: 'O', posts: 128, lastSyncAt: '2026-10-11T10:10:00.000Z', archived: false, archivedAt: null },
    { id: 'c2', name: 'dry-dock', displayName: 'Dry Dock', team: 'ops', type: 'O', posts: 4, lastSyncAt: '2026-10-01T00:00:00.000Z', archived: true, archivedAt: '2026-10-02T00:00:00.000Z' },
  ],
};

/** REST v4 `/posts`: `order` names the ids, `posts` is an id map rather than an array. */
export const REST_POSTS = {
  order: ['r2', 'r1'],
  posts: {
    r1: { id: 'r1', create_at: 1760176800000, update_at: 1760176800000, user_id: 'u1', channel_id: 'c1', message: 'Tide table pinned', type: '' },
    r2: { id: 'r2', create_at: 1760176860000, update_at: 1760176860000, user_id: 'u2', channel_id: 'c1', message: 'Crane booked for Tuesday', type: '' },
    r3: { id: 'r3', create_at: 1760176920000, update_at: 1760176920000, user_id: 'u1', channel_id: 'c1', message: 'ash joined the channel', type: 'system_join_channel' },
  },
};

/** A wrapper that carries posts under `items` instead of `posts`. */
export const ITEMS = {
  items: [
    { channel: 'harbour', author: 'river', time: '2026-10-11T10:00:00Z', text: 'Mooring drift log is ready', permalink: 'https://chat.example.invalid/t/harbour/pl/p1' },
    { channel: 'harbour', author: 'ash', time: '2026-10-11T10:05:00Z', text: 'Reviewed the mooring drift log', permalink: 'https://chat.example.invalid/t/harbour/pl/p2' },
  ],
};

/** A shape no branch recognises: the shaper must fail loud, never return ''. */
export const UNRECOGNISED = { blocks: [{ kind: 'canvas', ref: 'x1' }], cursor: 'next' };
