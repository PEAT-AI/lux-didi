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

/** One live tool step, as the voice view receives it: source and action, plus its subject. */
export interface ToolStepView { source: string; action: string; subject?: string; phase: 'start' | 'end'; resultCount?: number; ok?: boolean }

/** Every source a step can name: the object reads after a verb, the noun starts a result line. */
const STEP_SOURCES: Record<string, ToolPhrase & { noun: string; counted: string }> = {
  knowledge: { verb: 'Searching', object: 'your knowledge base', noun: 'Knowledge', counted: 'notes' },
  mail: { verb: 'Searching', object: 'your mail', noun: 'Mail', counted: 'messages' },
  calendar: { verb: 'Checking', object: 'your calendar', noun: 'Calendar', counted: 'events' },
  chat: { verb: 'Searching', object: 'Mattermost', noun: 'Mattermost', counted: 'messages' },
  mongoose: { verb: 'Searching', object: 'Mongoose', noun: 'Mongoose', counted: 'results' },
  web: { verb: 'Searching', object: 'the web', noun: 'Web', counted: 'pages' },
  memory: { verb: 'Saving', object: 'your memory', noun: 'Memory', counted: 'notes' },
};

/** The verb a step action reads as, keyed by the action the server published. */
const STEP_ACTIONS: Record<string, string> = { search: 'Searching', read: 'Reading', list: 'Listing', save: 'Saving', use: 'Using' };

function stepSource(source: string): ToolPhrase & { noun: string; counted: string } {
  return STEP_SOURCES[source] ?? { verb: 'Using', object: source, noun: source.charAt(0).toUpperCase() + source.slice(1), counted: 'results' };
}

/** One step as one calm line: "Searching Mattermost: release freeze, last 7 days" while it runs,
 *  then "Mattermost: 13 messages" once it answers, or why it did not. */
export function stepPhrase(step: ToolStepView): string {
  const named = stepSource(step.source);
  if (step.phase === 'start') {
    const verb = STEP_ACTIONS[step.action] ?? STEP_ACTIONS['use']!;
    return `${verb} ${named.object}${step.subject ? `: ${step.subject}` : ''}`;
  }
  if (step.ok === false) return `${named.noun} did not answer`;
  if (step.resultCount === undefined) return `${named.noun} answered`;
  if (step.resultCount === 0) return `${named.noun}: nothing found`;
  if (step.resultCount === 1) return `${named.noun}: 1 ${named.counted.replace(/s$/, '')}`;
  return `${named.noun}: ${step.resultCount} ${named.counted}`;
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
