import { sha256 } from './canonical.js';
const fields: Readonly<Record<string, readonly string[]>> = {
  search_knowledge: ['query','limit','include_sensitive','detail','max_chars','deadline_ms'], get_insight: ['ids','id','include_links','detail','max_chars','deadline_ms'],
  gmail_get_profile: [], gmail_search_messages: ['q','maxResults','pageToken'], gmail_read_message: ['id','format'],
  calendar_list_calendars: ['maxResults','pageToken'], calendar_list_events: ['calendarId','calendarIds','maxResults','pageToken','timeMin','timeMax','timeZone'],
  ask_mongoose: ['question','limit'], search_mongoose: ['query','scope','domain','limit','offset','include','include_strong'],
  get_knowledge_item: ['id','item_id','identifier','detail'], read_knowledge_body: ['ref','max_chars','cursor'],
  get_company_profile: ['company_name','sections','detail','flagship_only','launch_year'],
  list_tickets: ['status','kind','mine','mentioning_handle','audience','company_name','tags','search','not_updated_in_days','owner_handle','limit','offset'],
  get_ticket: ['number','detail','limit','offset','body_offset'],
  mattermost_whoami: [], mattermost_list_channels: ['limit'], mattermost_get_channel_history: ['channel','limit'], mattermost_get_thread: ['post_id','postId'], mattermost_search: ['query','limit','after','before'], mattermost_attention: ['days','limit'],
  conversation_history: ['query','recordRef','cursor','after','before','limit'], remember_note: ['text','kind'], open_url: ['url'], open_file: ['path'], open_application: ['name'],
};
function record(value: unknown): value is Record<string,unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function scalar(value: unknown): boolean { return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)); }
export function diagnosticInputFields(tool: string): readonly string[] { return fields[tool] ?? []; }
export interface InputProjection { json: string | null; sha256: string; fidelity: 'complete_v1' | 'hash_only_unsupported_v1'; keyCount: number | null }
/** The closed Didi field list, never a discovered provider schema, authorizes retained input values. */
export function projectDiagnosticInput(tool: string, input: unknown): InputProjection {
  const bytes = JSON.stringify(input) ?? 'null';
  const accepted = fields[tool];
  const supported = accepted !== undefined && record(input) && Object.entries(input).every(([key,value]) => accepted.includes(key) && (scalar(value) || (Array.isArray(value) && value.every(scalar))));
  return { json: supported ? bytes : null, sha256: sha256(bytes), fidelity: supported ? 'complete_v1' : 'hash_only_unsupported_v1',keyCount: record(input) ? Object.keys(input).length : null };
}
