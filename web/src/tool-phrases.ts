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
