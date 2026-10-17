// Human phrases for what Naya is doing with a tool. One table, keyed by the
// Live tool name. Parts are split into a verb and an object so several calls in
// one batch read as one calm line ("Searching your mail and Mattermost").
export interface ToolPhrase { verb: string; object: string }

/** Every current Live tool, keyed by its exact connector tool name. */
export const TOOL_PHRASES: Record<string, ToolPhrase> = {
  // lux-knowledge
  search_knowledge: { verb: 'Looking in', object: 'your knowledge base' },
  get_insight: { verb: 'Reading', object: 'your knowledge base' },
  // Gmail
  gmail_get_profile: { verb: 'Checking', object: 'your mail profile' },
  gmail_list: { verb: 'Searching', object: 'your mail' },
  gmail_read: { verb: 'Reading', object: 'that email' },
  // Calendar
  gcal_calendars: { verb: 'Checking', object: 'your calendar' },
  gcal_list: { verb: 'Checking', object: 'your calendar' },
  // Mattermost
  mattermost_whoami: { verb: 'Checking', object: 'your Mattermost account' },
  mattermost_get_channel_history: { verb: 'Reading', object: 'a Mattermost channel' },
  mattermost_get_thread: { verb: 'Reading', object: 'a Mattermost thread' },
  mattermost_search: { verb: 'Searching', object: 'Mattermost' },
  mattermost_list_channels: { verb: 'Listing', object: 'your Mattermost channels' },
  // owner memory
  remember_note: { verb: 'Saving', object: 'that to your memory' },
};

/** Connector name from the tool name's prefix, for the unknown-tool fallback. */
const CONNECTORS: Record<string, string> = {
  gmail: 'Gmail', gcal: 'Calendar', mattermost: 'Mattermost', mongoose: 'Mongoose',
  lux: 'lux-knowledge', search: 'lux-knowledge', get: 'lux-knowledge', remember: 'your memory',
};

function prefixOf(name: string): string { return name.split('_')[0] ?? name; }

/** A connector label for a tool name, never the raw id. */
export function toolConnector(name: string): string {
  const prefix = prefixOf(name);
  return CONNECTORS[prefix] ?? prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

function phraseFor(name: string): ToolPhrase {
  return TOOL_PHRASES[name] ?? { verb: 'Using', object: toolConnector(name) };
}

/** One tool as a human phrase. Unknown tools read "Using <connector>". */
export function toolPhrase(name: string): string {
  const phrase = phraseFor(name);
  return `${phrase.verb} ${phrase.object}`;
}

function joinAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Several calls in one batch as one line: shared verbs merge their objects. */
export function toolPhrases(names: string[]): string {
  const groups: { verb: string; objects: string[] }[] = [];
  for (const name of names) {
    const phrase = phraseFor(name);
    const group = groups.find(candidate => candidate.verb === phrase.verb);
    if (group) { if (!group.objects.includes(phrase.object)) group.objects.push(phrase.object); continue; }
    groups.push({ verb: phrase.verb, objects: [phrase.object] });
  }
  return groups
    .map((group, index) => `${index === 0 ? group.verb : group.verb.charAt(0).toLowerCase() + group.verb.slice(1)} ${joinAnd(group.objects)}`)
    .join(' and ');
}

/** One step of a run, exactly the shape of the server's `chat_step` event (docs/chat-steps.md on K3):
 * `{type:"chat_step", runId, stepId, tool, phase, label, resultCount?, ok?, ms?}`. The server's `label`
 * is a hint and never rendered, so no raw tool id or provider word reaches the owner. */
export interface ChatStep {
  type?: 'chat_step';
  runId: string;
  stepId: string;
  tool: string;
  phase: 'start' | 'end';
  label?: string;
  resultCount?: number;
  ok?: boolean;
  ms?: number;
}

/** A verb's finished form, so a running line reads "Searching Mattermost..." and its end "Searched Mattermost". */
const PAST_VERBS: Record<string, string> = {
  Searching: 'Searched', Reading: 'Read', Checking: 'Checked', Listing: 'Listed',
  'Looking in': 'Looked in', Saving: 'Saved', Using: 'Used',
};
function pastVerb(verb: string): string { return PAST_VERBS[verb] ?? `${verb}ed`; }

/** The quiet line while a tool runs: "Searching Mattermost...". */
export function stepRunning(step: ChatStep): string {
  const phrase = phraseFor(step.tool);
  return `${phrase.verb} ${phrase.object}...`;
}

/** The line once the tool answered: "Searched Mattermost, 13 results". */
export function stepFinished(step: ChatStep): string {
  const phrase = phraseFor(step.tool);
  const head = `${pastVerb(phrase.verb)} ${phrase.object}`;
  const count = typeof step.resultCount === 'number' && step.resultCount > 0 ? Math.floor(step.resultCount) : 0;
  return count ? `${head}, ${count} ${count === 1 ? 'result' : 'results'}` : head;
}

/** The folded one-line summary of a finished batch: "Checked Mattermost, Mongoose and calendar".
 * A shared verb is kept; a mixed batch reads as the neutral "Checked". Connectors take their prose
 * form here, the same words the partial-turn copy uses. */
export function stepsSummary(steps: readonly ChatStep[]): string {
  const done = steps.filter(step => step.phase === 'end');
  const names: string[] = [];
  for (const step of done) { const name = connectorProse(toolConnector(step.tool)); if (!names.includes(name)) names.push(name); }
  if (!names.length) return '';
  const verbs = [...new Set(done.map(step => pastVerb(phraseFor(step.tool).verb)))];
  const verb = verbs.length === 1 ? verbs[0]! : 'Checked';
  const line = names.length === 1 ? `${verb} ${names[0]}` : `${verb} ${joinAnd(names)}`;
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/** A connector word fit for mid-sentence prose, so the partial-turn copy reads "before checking calendar". */
const PROSE: Record<string, string> = { Calendar: 'calendar', Gmail: 'mail', 'lux-knowledge': 'the knowledge base' };
export function connectorProse(name: string): string { return PROSE[name] ?? name; }

/** Tools that change something outside Didi. None of today's read-only tools match, so a failed run
 * never claims "Content may have been sent" (target turn, item 6). */
const WRITE_TOOL = /_(?:post|send|reply|create|update|delete|invite|schedule)$/;
export function wroteExternally(names: readonly string[]): boolean { return names.some(name => WRITE_TOOL.test(name)); }
