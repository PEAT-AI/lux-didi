import { sha256 } from './canonical.js';
const fields: Readonly<Record<string, readonly string[]>> = {
  search_knowledge: ['query','limit','include_sensitive','detail','max_chars','snippet_chars','project_hint','meeting_date_from','meeting_date_to','deadline_ms'], get_insight: ['ids','id','include_links','detail','max_chars','deadline_ms'],
  gmail_get_profile: [], gmail_search_messages: ['q','maxResults','pageToken'], gmail_read_message: ['id','format'],
  calendar_list_calendars: ['maxResults','pageToken'], calendar_list_events: ['calendarId','calendarIds','maxResults','pageToken','timeMin','timeMax','timeZone'],
  drive_search_files: ['query','mime_types','modified_after','limit'], drive_get_file: ['file_id'],
  search: ['query','mode','limit','cursor','verbose'], read: ['ref','depth','cursor','verbose'],
  list_companies: ['filter','limit'], get_company: ['ref','include'],
  list_tickets: ['status','kind','mine','mentioning_handle','audience','company_name','tags','search','not_updated_in_days','owner_handle','limit','offset'],
  mattermost_whoami: [], mattermost_list_channels: ['limit'], mattermost_get_channel_history: ['channel','limit'], mattermost_get_thread: ['post_id','postId'], mattermost_search: ['query','limit','after','before','channel','offset'], mattermost_attention: ['days','limit'], mattermost_chat: ['intent','person','people','channel','query','from_date','to_date','sides','offset','limit'], mattermost_conversation_overview: ['person','from_date','to_date','per_section_limit'], mattermost_resolve_person: ['name'],
  conversation_history: ['query','recordRef','cursor','after','before','limit'], remember_note: ['text','kind'], open_source: ['handle'], open_home: ['app'], open_file: ['path'], open_app: ['name'],
  trello_read: ['view','list','query','window','card','offset','limit'], trello_write: ['action','card','list','name','description','text','item','checklist','checked','due','complete','label','remove'],
  research: ['action','question','topic','researchId','sources','cursor','pageCursor','direction','lookups'], stage_lux_note: ['title','body','evidenceRefs'],
};
function record(value: unknown): value is Record<string,unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function scalar(value: unknown): boolean { return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)); }
function storable(value: unknown): boolean { return scalar(value) || (Array.isArray(value) && value.every(scalar)); }
export function diagnosticInputFields(tool: string): readonly string[] { return fields[tool] ?? []; }
export interface InputProjection {
  json: string | null; sha256: string;
  fidelity: 'complete_v1' | 'partial_v1' | 'hash_only_unsupported_v1';
  keyCount: number | null;
  /** The sorted key names are metadata (lane-6 2.3) and are recorded whatever happens to the values. */
  keys: string[] | null;
}
/** The closed Didi field list, never a discovered provider schema, authorizes retained input values. */
export function projectDiagnosticInput(tool: string, input: unknown): InputProjection {
  const bytes = JSON.stringify(input) ?? 'null';
  const sha = sha256(bytes);
  const keys = record(input) ? Object.keys(input).sort() : null;
  const accepted = fields[tool];
  if (accepted === undefined || !record(input)) return { json: null, sha256: sha, fidelity: 'hash_only_unsupported_v1', keyCount: keys?.length ?? null, keys };
  // Per key, so a nested value costs that value and never the whole record (STATE.md S-03).
  const entries = Object.entries(input);
  const kept = entries.filter(([key, value]) => accepted.includes(key) && storable(value));
  if (kept.length === entries.length) return { json: bytes, sha256: sha, fidelity: 'complete_v1', keyCount: entries.length, keys };
  if (kept.length === 0) return { json: null, sha256: sha, fidelity: 'hash_only_unsupported_v1', keyCount: entries.length, keys };
  return { json: JSON.stringify(Object.fromEntries(kept)), sha256: sha, fidelity: 'partial_v1', keyCount: entries.length, keys };
}

/** A stored projection is current when its own bytes hash to the recorded identity. A partial row is
 * authentic by construction: its hash names the full argument bytes, which are never retained, and
 * the row says so in its fidelity.
 */
export function projectionAuthentic(fidelity: string, json: string, recordedSha: string): boolean {
  return fidelity === 'partial_v1' || sha256(json) === recordedSha;
}
