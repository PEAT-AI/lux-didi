import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RESEARCH, ResearchLedger, SELECTOR_SYSTEM, candidateSubs, researchDeclaration, extractInsightIds, fallbackSelection, knowledgeQuery, parseSelector, runResearch, shapeBlock,
  type CandidateKind, type ResearchDeps, type ResearchSelector, type SourceKind,
} from '../tools/research.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';
import { safeEvent } from '../host/log.js';

// The web candidate's own suite rides with the research suite, so one run covers the candidate set.
import './research-web.test.js';

const CONFIGURED: readonly SourceKind[] = ['knowledge', 'calendar', 'mail', 'chat'];

function sub(name: string, text: string, ok = true, key = name): IntentSubResult {
  return { key, name, ok, text, originalCharacters: text.length, omittedCharacters: 0 };
}

// --- Selector authors queries and a calendar window -----------------------------------------

test('parseSelector reads a per-action query and calendar window, trims and caps them', () => {
  const parsed = parseSelector('{"questionClass":"quick_fact","actions":['
    + '{"kind":"mail_search","query":"in:inbox newer_than:2d is:important"},'
    + '{"kind":"calendar_window","window":"tomorrow"},'
    + '{"kind":"knowledge_search","query":"  lux   didi  decisions "}],"pUseful":{}}');
  assert.equal(parsed?.actions[0]?.query, 'in:inbox newer_than:2d is:important');
  assert.equal(parsed?.actions[1]?.window, 'tomorrow');
  assert.equal(parsed?.actions[2]?.query, 'lux didi decisions');
  const long = parseSelector(JSON.stringify({ questionClass: 'cross_source', actions: [{ kind: 'knowledge_search', query: 'x'.repeat(500) }], pUseful: {} }));
  assert.equal(long?.actions[0]?.query?.length, RESEARCH.queryLimitChars);
  const bad = parseSelector('{"questionClass":"quick_fact","actions":[{"kind":"calendar_window","window":"whenever"}],"pUseful":{}}');
  assert.equal(bad?.actions[0]?.window, 'whenever', 'unsupported text reaches the resolver and cannot silently become today');
  assert.equal(parseSelector('{"questionClass":"quick_fact","actions":[{"kind":"mail_search","query":"a\\nb"}],"pUseful":{}}')?.actions[0]?.query, 'a b');
});

test('SELECTOR_SYSTEM teaches the per-source query syntax', () => {
  assert.match(SELECTOR_SYSTEM, /in:inbox/);
  assert.match(SELECTOR_SYSTEM, /newer_than/);
  assert.match(SELECTOR_SYSTEM, /after:YYYY-MM-DD/);
  assert.match(SELECTOR_SYSTEM, /3 to 5 content keywords/);
  assert.match(SELECTOR_SYSTEM, /window/);
});

// W11: the model authors mail queries too, so the declaration itself says how to ask mail well.
test('the research declaration tells the model to ask mail in short Gmail syntax with a window', () => {
  const { guidance, description } = researchDeclaration();
  assert.match(guidance, /Gmail operators/, 'the guidance names the operators it wants');
  assert.match(guidance, /from:/);
  assert.match(guidance, /newer_than/);
  assert.match(guidance, /window/, 'and the window rule');
  assert.match(guidance, /from:dana newer_than:14d invoice/, 'one short example with a sender and a window');
  assert.match(guidance, /newer_than:2d is:unread/, 'a second short example');
  // F3: the field that grew for this change carries its own budget, so the next example cannot creep in
  // unbounded; the mail clause is one sentence with two examples.
  assert.ok(guidance.length < 800, `the declaration guidance keeps its 800-char budget (${guidance.length} chars)`);
  assert.ok(description.length < 500, `the declaration description keeps its budget (${description.length} chars)`);
});

// --- Deterministic fallback: content keywords, never the raw sentence ------------------------

const SYNTHETIC = [
  'Anything important in my email today?',
  "What's new in Mattermost?",
  'Can you check my email for the release status please',
  'Search my notes for Lux Didi decisions',
  'Who wrote to me about the board deck?',
];

test('fallbackSelection never passes the spoken sentence as a query, on five synthetic questions', () => {
  for (const question of SYNTHETIC) {
    const selection = fallbackSelection(question, CONFIGURED, Date.parse('2026-10-16T12:00:00Z'));
    for (const action of selection.actions) {
      if (action.query === undefined) continue;
      assert.notEqual(action.query, question, `raw sentence leaked for ${action.kind}`);
      assert.equal(action.query.includes('?'), false);
    }
  }
});

test('the fallback mail query carries operators and keywords, chat carries after:, knowledge only keywords', () => {
  const mail = fallbackSelection('Can you check my email for the release status please', CONFIGURED, Date.parse('2026-10-16T12:00:00Z'));
  const mailQuery = mail.actions.find(action => action.kind === 'mail_search')?.query ?? '';
  assert.match(mailQuery, /^in:inbox newer_than:14d /);
  assert.match(mailQuery, /release/);
  assert.equal(fallbackSelection("What's new in Mattermost?", CONFIGURED, Date.parse('2026-10-16T12:00:00Z')).actions.find(action => action.kind === 'chat_search')?.query, 'after:yesterday');
  const knowledge = fallbackSelection('Search my notes for Lux Didi decisions', CONFIGURED, Date.parse('2026-10-16T12:00:00Z'));
  const knowledgeFallback = knowledge.actions.find(action => action.kind === 'knowledge_search')?.query ?? '';
  assert.equal(/[?:"]|in:|after:|newer_than/.test(knowledgeFallback), false);
  assert.equal(knowledgeFallback, 'lux didi decisions', 'source words like notes are not content keywords');
  assert.equal(fallbackSelection('Anything important in my email today?', CONFIGURED, Date.parse('2026-10-16T12:00:00Z')).actions.find(action => action.kind === 'mail_search')?.query, 'in:inbox newer_than:1d is:important', 'today and important are operators');
  assert.equal(fallbackSelection('Anything unread in my inbox?', CONFIGURED, Date.parse('2026-10-16T12:00:00Z')).actions.find(action => action.kind === 'mail_search')?.query, 'in:inbox newer_than:2d is:unread');
  assert.equal(fallbackSelection('What is important in my email this week?', CONFIGURED, Date.parse('2026-10-16T12:00:00Z')).actions.find(action => action.kind === 'mail_search')?.query, 'in:inbox newer_than:7d is:important');
  assert.equal(candidateSubs('mail_search', { question: 'q', configured: CONFIGURED, evidence: new Map() })[0]?.args['q'], 'in:inbox newer_than:2d');
});

test('a calendar window is asked for with the primary-calendar scope', () => {
  const selection = fallbackSelection('What is on my calendar tomorrow?', CONFIGURED, Date.parse('2026-10-16T12:00:00Z'));
  assert.equal(selection.actions.find(action => action.kind === 'calendar_window')?.window, 'tomorrow');
  const subs = candidateSubs('calendar_window', { question: 'q', configured: ['calendar'], evidence: new Map(), window: 'tomorrow', nowMs: Date.parse('2026-10-16T12:00:00Z') });
  assert.equal(subs.length, 1, 'one merged connector call, never one sub-call per calendar');
  assert.equal(subs[0]?.name, 'calendar_list_events');
  assert.equal(subs[0]?.args['calendarId'], 'primary', 'research keeps its primary-calendar scope');
  assert.match(String(subs[0]?.args['timeMin']), /^\d{4}-\d{2}-\d{2}T/);
  assert.match(String(subs[0]?.args['timeMax']), /^\d{4}-\d{2}-\d{2}T/);
});

test('candidateSubs uses the authored query and the per-source limits', () => {
  const knowledge = candidateSubs('knowledge_search', { question: 'raw sentence here', configured: CONFIGURED, evidence: new Map(), query: 'lux didi' });
  assert.equal(knowledge[0]?.args['limit'], RESEARCH.knowledgeHits, 'P5-R1 and 3r K1: six hits with bounded bodies');
  // MED-1022: the authored terms lead, and the question's own words follow them inside the budget.
  assert.equal(knowledge[0]?.args['query'], 'lux didi raw sentence here');
  const chat = candidateSubs('chat_search', { question: 'q', configured: CONFIGURED, evidence: new Map(), query: 'after:2026-10-15 release' });
  assert.equal(chat[0]?.args['limit'], RESEARCH.chatLines);
  const mail = candidateSubs('mail_search', { question: 'q', configured: CONFIGURED, evidence: new Map(), query: 'in:inbox newer_than:2d' });
  assert.equal(mail[0]?.args['q'], 'in:inbox newer_than:2d');
});

// --- Telegraphic shaping ---------------------------------------------------------------------

test('shapeBlock emits one mail line per item with a count line, never the id in the snippet', () => {
  const text = '- Budget | from: Alice | date: Mon [unread] | body here [id m1]';
  const block = shapeBlock('mail_search', [sub('gmail_search_messages', text)]);
  assert.equal(block.lines[0], 'Alice | Budget | Mon [unread] | body here');
  assert.match(block.text, /^mail: 1 of 1 shown\nAlice \| Budget/);
});

test('shapeBlock reads labelled list lines and omits an absent sender and date', () => {
  const text = '- Budget | from: Alice | date: Mon | body here [id m1]\n- No sender | body two [id m2]';
  const block = shapeBlock('mail_search', [sub('gmail_search_messages', text)]);
  assert.equal(block.lines[0], 'Alice | Budget | Mon | body here');
  assert.equal(block.lines[1], 'No sender | body two');
  assert.equal(block.text.includes('unknown'), false);
});

test('shapeBlock keeps sender and date from an opened mail, past the to line', () => {
  const text = 'subject: Budget\nfrom: Alice\nto: rob@example.invalid\ndate: Mon\n\nbody text';
  const block = shapeBlock('mail_open', [sub('gmail_read_message', text)]);
  assert.equal(block.lines[0], 'Alice | Budget | Mon | body text');
});

test('shapeBlock collapses knowledge headings to id and title and caps the block', () => {
  const hits = Array.from({ length: 8 }, (_, i) => `### Insight ${i} (PATTERN | 2026-10-0${i}) [id ${i + 1}]\nsome body text for insight ${i}`).join('\n');
  const block = shapeBlock('knowledge_search', [sub('search_knowledge', hits)]);
  assert.equal(block.lines.length, Math.min(8, RESEARCH.knowledgeLines));
  assert.equal(block.total, 8);
  assert.match(block.lines[0]!, /^#1 Insight 0 .*\| some body text/);
});

test('P5-R1: a knowledge hit keeps its whole body, never a 1,200 character snippet', () => {
  const long = 'x'.repeat(4_000);
  const block = shapeBlock('knowledge_search', [sub('search_knowledge', `### Long insight (DECISION | 2026-10-19) [id 7]\n${long}`)]);
  assert.equal(block.lines.length, 1);
  assert.ok(block.lines[0]!.endsWith(long), 'the body the connector sent is kept whole');
  assert.equal(RESEARCH.knowledgeHits, 6, 'up to six hits, each with the bounded body the connector returns');
});

// --- Evidence ids reach the second hops ------------------------------------------------------

test('evidence ids reach mail_open and chat_thread', () => {
  const evidence = new Map<CandidateKind, string>([['mail_search', 'm1'], ['chat_search', 'p1']]);
  const mail = candidateSubs('mail_open', { question: 'q', configured: ['mail'], evidence });
  assert.deepEqual(mail[0], { key: 'mo0', name: 'gmail_read_message', args: { id: 'm1' } });
  const chat = candidateSubs('chat_thread', { question: 'q', configured: ['chat'], evidence });
  assert.deepEqual(chat[0], { key: 'ct0', name: 'mattermost_get_thread', args: { post_id: 'p1' } });
});

test('a mail search id flows into a second read in the same run', async () => {
  const executed: { name: string; args: unknown }[] = [];
  const selector: ResearchSelector = {
    async select(input) {
      const kind = input.candidates.includes('mail_search') ? 'mail_search' : 'mail_open';
      return { questionClass: 'cross_source', actions: [{ kind }], pUseful: { [kind]: 1 } };
    },
  };
  const deps: ResearchDeps = {
    now: () => 0,
    configured: CONFIGURED,
    selector,
    execute: async (subs: readonly IntentSubCall[]) => {
      for (const call of subs) executed.push({ name: call.name, args: call.args });
      return subs.map(call => call.name === 'gmail_search_messages'
        ? sub(call.name, '- Budget | from: Alice | date: Mon [unread] | body here [id m1]', true, call.key)
        : sub(call.name, 'subject: Budget\nfrom: Alice\ndate: Mon\n\nthe body', true, call.key));
    },
    emit: () => undefined,
    log: () => undefined,
    ledger: new ResearchLedger(),
  };
  await runResearch(deps, { action: 'start', question: 'what does the budget mail say' }, new AbortController().signal);
  const read = executed.find(call => call.name === 'gmail_read_message');
  assert.deepEqual(read?.args, { id: 'm1' });
});

// --- Packing and budget ----------------------------------------------------------------------

test('packing floors at one line per source, caps at the reply limit and sets canContinue', async () => {
  const knowledge = Array.from({ length: 8 }, (_, i) => `### Insight ${i} (PATTERN | 2026-10-0${i}) [id ${i + 1}]\n${'k'.repeat(600)}`).join('\n');
  const mail = Array.from({ length: 8 }, (_, i) => `- Subject ${i} | from: Sender ${i} | date: Mon | ${'m'.repeat(190)} [id m${i}]`).join('\n');
  const selector: ResearchSelector = { async select() { return { questionClass: 'cross_source', actions: [{ kind: 'knowledge_search' }, { kind: 'mail_search' }], pUseful: { knowledge_search: 1, mail_search: 1 } }; } };
  const deps: ResearchDeps = {
    now: () => 0, configured: CONFIGURED, selector, replyLimit: 3_000,
    execute: async (subs: readonly IntentSubCall[]) => subs.map(call => sub(call.name, call.name === 'search_knowledge' ? knowledge : mail, true, call.key)),
    emit: () => undefined, log: () => undefined, ledger: new ResearchLedger(),
  };
  // #1021: a content-free question no longer searches knowledge, so the packing test asks a real one.
  const reply = await runResearch(deps, { action: 'start', question: 'what did we decide about the release' }, new AbortController().signal);
  const findings = reply['findings'] as { source: string; text: string }[];
  assert.ok(JSON.stringify(reply).length <= 3_000, `reply was ${JSON.stringify(reply).length}`);
  assert.equal(findings.length, 2, 'at least one line per source with hits');
  for (const finding of findings) assert.match(finding.text, /shown\n/);
  assert.equal(reply['canContinue'], true, 'dropped lines set canContinue');
});

// --- Metadata log shape ----------------------------------------------------------------------

test('research_subcall is a closed metadata shape, never the query or text', () => {
  const good = { event: 'research_subcall', researchId: 'r1', kind: 'mail_search', tool: 'gmail_search_messages', ok: true, items: 3, rawBytes: 100, keptBytes: 80, queryChars: 20, queryAuthor: 'selector' };
  assert.deepEqual(safeEvent(good), good);
  assert.equal(safeEvent({ ...good, query: 'secret terms' }), undefined, 'a query key refuses the whole event');
  assert.equal(safeEvent({ ...good, errorCode: 'invalid-query' })?.errorCode, 'invalid-query');
  assert.equal(safeEvent({ ...good, queryAuthor: 'model' }), undefined);
});

test('research_subcall matches results by position even when execute keys are composed call ids', async () => {
  const subcalls: Record<string, unknown>[] = [];
  const selector: ResearchSelector = { async select() { return { questionClass: 'cross_source', actions: [{ kind: 'mail_search', query: 'in:inbox newer_than:2d' }], pUseful: { mail_search: 1 } }; } };
  const deps: ResearchDeps = {
    now: () => 0, configured: CONFIGURED, selector,
    execute: async (subs: readonly IntentSubCall[]) => subs.map((call, n) => ({ key: `r0~${n}~${call.key}`, name: call.name, ok: true, text: '- Subject | Sender | Mon | body [id m1]', originalCharacters: 40, omittedCharacters: 0 })),
    emit: () => undefined, log: () => undefined, logSubcall: entry => subcalls.push(entry as unknown as Record<string, unknown>), ledger: new ResearchLedger(),
  };
  const reply = await runResearch(deps, { action: 'start', question: 'anything' }, new AbortController().signal);
  assert.equal(subcalls[0]!['ok'], true, 'a composed execute key must still find its result');
  assert.ok((subcalls[0]!['items'] as number) >= 1);
  assert.equal(subcalls[0]!['queryAuthor'], 'selector');
  const findings = reply['findings'] as { text: string }[];
  assert.match(findings[0]!.text, /^mail: 1 of 1 shown/);
});

test('ROUTE-1022: a knowledge read is one search call and logs no second hop', async () => {
  const subcalls: Record<string, unknown>[] = [];
  const selector: ResearchSelector = { async select() { return { questionClass: 'cross_source', actions: [{ kind: 'knowledge_search', query: 'lux didi' }], pUseful: { knowledge_search: 1 } }; } };
  const deps: ResearchDeps = {
    now: () => 0, configured: CONFIGURED, selector,
    execute: async (subs: readonly IntentSubCall[]) => subs.map((call, n) => ({
      key: `r0~${n}~${call.key}`, name: call.name, ok: true,
      text: call.name === 'search_knowledge' ? '### Title (PATTERN) [id 7]\nbody text' : 'full body',
      originalCharacters: 20, omittedCharacters: 0,
    })),
    emit: () => undefined, log: () => undefined, logSubcall: entry => subcalls.push(entry as unknown as Record<string, unknown>), ledger: new ResearchLedger(),
  };
  await runResearch(deps, { action: 'start', question: 'anything' }, new AbortController().signal);
  assert.equal(subcalls.filter(entry => entry['tool'] === 'search_knowledge').length, 1, 'one knowledge search');
  assert.equal(subcalls.filter(entry => entry['tool'] === 'get_insight').length, 0, 'no get_insight second hop');
});

test('extractInsightIds reads the shaped, raw and real knowledge id forms', () => {
  assert.deepEqual(extractInsightIds('### A (PATTERN) [id 5]\nbody'), [5]);
  assert.deepEqual(extractInsightIds('_confidence: low_\n## #12 [note]\ncontent'), [12]);
  assert.deepEqual(extractInsightIds("# Knowledge Search\n_confidence: low_\n**#90082** [BUG_GOTCHA] title\n  excerpt"), [90082]);
});

test('shapeBlock shapes the real knowledge item form too', () => {
  const block = shapeBlock('knowledge_search', [sub('search_knowledge', '**#90082** [BUG_GOTCHA] a title\n  an excerpt line\n  Score: 0.2\n## #4 [pattern]\nother body')]);
  // #1021 K7: the per-hit `Score:` line names two incomparable scales, so the shape never carries it.
  assert.equal(block.lines[0], '#90082 [BUG_GOTCHA] a title | an excerpt line');
  assert.equal(block.lines[1], '#4 [pattern] | other body');
});

test('a failed sub-call is retried once inside the round', async () => {
  let mailCalls = 0;
  const subcalls: Record<string, unknown>[] = [];
  const selector: ResearchSelector = { async select() { return { questionClass: 'cross_source', actions: [{ kind: 'mail_search', query: 'in:inbox newer_than:2d' }], pUseful: { mail_search: 1 } }; } };
  const deps: ResearchDeps = {
    now: () => 0, configured: CONFIGURED, selector,
    execute: async (subs: readonly IntentSubCall[]) => subs.map((call, n) => {
      if (call.name !== 'gmail_search_messages') return { key: `r0~${n}~${call.key}`, name: call.name, ok: true, text: '### Title [id 1]', originalCharacters: 10, omittedCharacters: 0 };
      mailCalls += 1;
      return { key: `r0~${n}~${call.key}`, name: call.name, ok: mailCalls > 1, text: mailCalls > 1 ? '- Subject | Sender | Mon | body [id m1]' : '', originalCharacters: 10, omittedCharacters: 0, ...(mailCalls > 1 ? {} : { code: 'transient' }) };
    }),
    emit: () => undefined, log: () => undefined, logSubcall: entry => subcalls.push(entry as unknown as Record<string, unknown>), ledger: new ResearchLedger(),
  };
  await runResearch(deps, { action: 'start', question: 'anything' }, new AbortController().signal);
  assert.equal(mailCalls >= 2, true, 'the failed call is retried');
  const mailLog = subcalls.find(entry => entry['tool'] === 'gmail_search_messages');
  assert.equal(mailLog!['ok'], true, 'the retried result is the one logged');
});

test('shapeBlock keeps mattermost posts rendered as **header** lines', () => {
  const text = '**harbour | river | 2026-10-11T10:00:00.000Z [post p1]**\nhello there\n**other | alice | t [post p2]**\nsecond post';
  const block = shapeBlock('chat_search', [sub('mattermost_search', text)]);
  assert.equal(block.lines.length, 2);
  assert.equal(block.lines[0], 'harbour | river | 2026-10-11T10:00:00.000Z | hello there');
  assert.equal(block.total, 2);
});

test('the research_run line carries unchecked, canContinue and per-finding char counts', async () => {
  const logs: Record<string, unknown>[] = [];
  const selector: ResearchSelector = { async select() { return { questionClass: 'cross_source', actions: [{ kind: 'knowledge_search' }], pUseful: { knowledge_search: 1 } }; } };
  const deps: ResearchDeps = {
    now: () => 0, configured: CONFIGURED, selector,
    execute: async (subs: readonly IntentSubCall[]) => subs.map(call => sub(call.name, '### Title (PATTERN) [id 1]\nbody', true, call.key)),
    emit: () => undefined, log: entry => logs.push(entry as unknown as Record<string, unknown>), ledger: new ResearchLedger(),
  };
  await runResearch(deps, { action: 'start', question: 'what did we decide about the release' }, new AbortController().signal);
  assert.deepEqual(logs[0]!['unchecked'], ['calendar', 'mail', 'chat']);
  assert.equal(typeof logs[0]!['canContinue'], 'boolean');
  assert.ok(Array.isArray(logs[0]!['findingChars']));
});

test('E8/U2: a 31-event week comes back whole, one line per day, never cut at twelve', () => {
  const lines = Array.from({ length: 31 }, (_, n) => {
    const day = String(25 + Math.floor(n / 6)).padStart(2, '0');
    return `- 2026-10-${day}T10:00:00Z, Synthetic week event ${n} [id w${n}]`;
  });
  const block = shapeBlock('calendar_window', [sub('calendar_list_events', lines.join('\n'))], 'UTC');
  assert.match(block.text, /^calendar: 31 of 31 shown/u);
  for (const n of [0, 12, 30]) assert.match(block.text, new RegExp(`Synthetic week event ${n}\\b`, 'u'));
  assert.equal(block.lines.length, 6, 'one line per day of the window');
  assert.doesNotMatch(block.text, /left out/u);
});

test('CALM-R11: a connector line with a location keeps its title, the calendar is never its stand-in', () => {
  const line = '- 2026-10-16T09:00:00+05:30, Standup, Room 1 | Primary [id e1]';
  const block = shapeBlock('calendar_window', [sub('calendar_list_events', line)], 'Asia/Kolkata');
  assert.match(block.text, /09:00 Standup, Room 1/u, 'the title and the place ride the day line');
  assert.doesNotMatch(block.text, /Primary/u, 'the calendar name never stands in for the title');
  assert.deepEqual(block.lines, ['- Fri 16 Oct: 09:00 Standup, Room 1']);
});

test('CALM-R11: an event with no location and a calendar still keeps its title', () => {
  const line = '- 2026-10-16T09:00:00+05:30, Standup | Primary [id e1]';
  const block = shapeBlock('calendar_window', [sub('calendar_list_events', line)], 'Asia/Kolkata');
  assert.deepEqual(block.lines, ['- Fri 16 Oct: 09:00 Standup'], 'a bare title survives the pipe segment');
  assert.doesNotMatch(block.text, /Primary/u);
});

test('E8/U2: a trimmed calendar block says how many events it left out', () => {
  const lines = Array.from({ length: 40 }, (_, n) => `- 2026-10-25T10:${String(n % 60).padStart(2, '0')}:00Z, Synthetic long week event ${n} with a title that fills the block ${'x'.repeat(120)} [id t${n}]`);
  const block = shapeBlock('calendar_window', [sub('calendar_list_events', lines.join('\n'))], 'UTC');
  assert.match(block.text, /I left out \d+ calendar events to keep this answer short\./u);
  assert.ok(block.total > block.lines.length || /left out/u.test(block.text));
});

// --- MED-1022: a knowledge query keeps the name the owner said and drops the filler ---------------

test('MED-1022: the knowledge query drops filler, keeps the spoken name, and takes ten terms', () => {
  assert.equal(RESEARCH.knowledgeQueryTerms, 10);
  const query = knowledgeQuery('lux meeting transcript results about', 'what did we cover in the prep call with Maria');
  const terms = query.split(' ');
  for (const wanted of ['prep', 'call', 'maria']) assert.ok(terms.includes(wanted), `"${wanted}" survives in "${query}"`);
  for (const filler of ['results', 'about']) assert.equal(terms.includes(filler), false, `"${filler}" never rides in "${query}"`);
  assert.ok(terms.length <= 10, `the budget holds (${terms.length})`);
  const long = knowledgeQuery('what did we decide about the wriggler three layer schema migration deadline for the owner dashboard and the vicuna release train');
  assert.equal(long.split(' ').length, 10, 'a long question fills the wider budget and stops there');
  assert.equal(long.includes('owner'), false, 'a role word is filler for a search too');
});

test('MED-1022: a named meeting and a date word become the connector meeting bounds', () => {
  const now = Date.parse('2026-10-22T06:00:00Z');
  const config = { configured: ['knowledge'] as const, evidence: new Map(), nowMs: now, timeZone: 'Asia/Kolkata' };
  const dated = candidateSubs('knowledge_search', { ...config, question: "what did we decide in yesterday's call about pricing" });
  assert.equal(dated[0]?.args['meeting_date_from'], '2026-10-21', 'yesterday is resolved in the owner zone');
  assert.equal(dated[0]?.args['meeting_date_to'], '2026-10-21');
  assert.equal('participant' in (dated[0]?.args ?? {}), false, 'a name never becomes a hard participant filter');
  const noDate = candidateSubs('knowledge_search', { ...config, question: 'what did we decide in the call about pricing' });
  assert.equal('meeting_date_from' in (noDate[0]?.args ?? {}), false, 'a meeting with no date word is not narrowed');
  const noMeeting = candidateSubs('knowledge_search', { ...config, question: 'what did we ship yesterday' });
  assert.equal('meeting_date_from' in (noMeeting[0]?.args ?? {}), false, 'a date with no meeting named is not narrowed');
  // T-R5: last week is the previous Monday to Sunday in the owner's zone, not an unresolved window.
  const lastWeek = candidateSubs('knowledge_search', { ...config, question: "what did we agree in last week's call" });
  assert.equal(lastWeek[0]?.args['meeting_date_from'], '2026-10-12', 'Monday of the previous week');
  assert.equal(lastWeek[0]?.args['meeting_date_to'], '2026-10-18', 'and its Sunday');
});

test('MED-1022: a chat date word compiles to the ISO operator the connector parses', () => {
  const now = Date.parse('2026-10-22T06:00:00Z');
  const config = { question: 'what did the team say', configured: CONFIGURED, evidence: new Map(), nowMs: now, timeZone: 'Asia/Kolkata' };
  const chat = (query?: string): unknown => candidateSubs('chat_search', { ...config, ...(query === undefined ? {} : { query }) })[0]?.args['query'];
  assert.equal(chat(), 'After:2026-10-21', 'the default names a real day, never a word the parser ignores');
  assert.equal(chat('budget after:yesterday'), 'budget After:2026-10-21');
  assert.equal(chat('budget after:someday'), 'budget', 'an operator no calendar can resolve is dropped');
  const brief = candidateSubs('brief', config);
  assert.equal(brief.find(call => call.name === 'mattermost_search')?.args['query'], 'After:2026-10-21');
});

test('OPEN2-2: a calendar item keeps its open: line in the reply the model is given', () => {
  const text = '- 2026-10-16T09:00:00+05:30, Standup [id e1]\nopen: L1 = Calendar: Standup';
  const block = shapeBlock('calendar_window', [sub('calendar_list_events', text)], 'Asia/Kolkata');
  assert.equal(block.lines.length, 1, 'one day line carries the item and its handle');
  assert.match(block.text, /open: L1 = Calendar: Standup/u, 'the handle line reaches the model');
  assert.match(block.text, /Standup/u);
});

test('OPEN2-2: a mail item keeps its open: line in the reply the model is given', () => {
  const text = '- Standup notes | from: Ana | date: 16 Oct [id m1]\nopen: L2 = Gmail: Standup notes';
  const block = shapeBlock('mail_search', [sub('gmail_search_messages', text)], undefined);
  assert.match(block.text, /open: L2 = Gmail: Standup notes/u, 'the reply keeps the mail item handle');
  assert.match(block.text, /Standup notes/u);
});
