import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_LOOKUPS, RESEARCH, ResearchLedger, broaderQueryOf, clip, coverageLine, parseResearch, researchDeclaration, runResearch, statusAsk, type ResearchDeps, type ResearchProgress, type ResearchRunLog, type SourceKind } from '../tools/research.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';
import { shapeGcalList } from '../tools/live-shape.js';

function sub(name: string, text: string, ok = true, key = name): IntentSubResult {
  return { key, name, ok, text, originalCharacters: text.length, omittedCharacters: 0 };
}

/** Knowledge headings in the shape the real reader returns, one line each. */
function knowledgeHits(count: number): string {
  return Array.from({ length: count }, (_v, index) => `### Release plan ${index} (decision | 2026-10-17) [id ${100 + index}]`).join('\n');
}

/** Mail rows in the connector's own shaped line, one message each. */
function mailRows(count: number): string {
  return Array.from({ length: count }, (_v, index) => `- Release note ${index} | from: Ana | date: 2026-10-16 [id m${index}]`).join('\n');
}

interface Harness {
  deps: ResearchDeps;
  executed: { name: string; args: Record<string, unknown> }[];
  progress: ResearchProgress[];
  logs: ResearchRunLog[];
}

function harness(opts: { execute?: ResearchDeps['execute']; configured?: readonly SourceKind[]; replyLimit?: number; now?: () => number; schedule?: ResearchDeps['schedule']; unavailableNow?: ResearchDeps['unavailableNow']; web?: ResearchDeps['web'] } = {}): Harness {
  const executed: { name: string; args: Record<string, unknown> }[] = [];
  const progress: ResearchProgress[] = [];
  const logs: ResearchRunLog[] = [];
  const deps: ResearchDeps = {
    now: opts.now ?? (() => 0),
    ...(opts.schedule === undefined ? {} : { schedule: opts.schedule }),
    configured: opts.configured ?? ['knowledge', 'calendar', 'mail', 'chat'],
    ...(opts.unavailableNow === undefined ? {} : { unavailableNow: opts.unavailableNow }),
    ...(opts.web === undefined ? {} : { web: opts.web }),
    execute: opts.execute ?? (async (subs: readonly IntentSubCall[]) => subs.map(call => sub(call.name, 'evidence', true, call.key))),
    emit: event => progress.push(event),
    log: entry => logs.push(entry),
    ledger: new ResearchLedger(),
    ...(opts.replyLimit === undefined ? {} : { replyLimit: opts.replyLimit }),
  };
  const execute = deps.execute;
  deps.execute = async (calls, signal) => {
    for (const call of calls) executed.push({ name: call.name, args: call.args });
    return execute(calls, signal);
  };
  return { deps, executed, progress, logs };
}

const BODY_SCOPE = {
  endpointId: 'local', transport: 'stdio' as const, bindingDigest: 'sha256:compose-scope', schemaDigest: 'sha256:compose-schema',
  toolName: 'gmail_read_message', generation: 1, account: 'owner', resource: 'mail',
};
const BODY_EVIDENCE = {
  kind: 'remote-body' as const, source: BODY_SCOPE, entitySha256: 'e'.repeat(64), bodySha256: 'b'.repeat(64),
  expiresAt: Date.now() + 600_000, tool: 'gmail_read_message', upstreamComplete: true, upstreamOmitted: false,
  body: 'The landlord wrote that the deposit moves to the new account on Monday. '.repeat(3),
};

function bodyResult(call: IntentSubCall): IntentSubResult {
  return {
    ...sub(call.name, '', true, call.key),
    binding: { executionId: 'exec-compose', name: call.name, contentIndex: 0, partIndex: 0, result: { id: 'compose-body-1', sha256: 'c'.repeat(64) } },
    hostEvidence: BODY_EVIDENCE,
  };
}

test('COMPOSE 1: a mail ask whose first query matches nothing broadens once and reads the top body inside the same call', async () => {
  let searches = 0;
  const h = harness({ execute: async (subs: readonly IntentSubCall[]) => subs.map(call => {
    if (call.name === 'gmail_search_messages') {
      searches += 1;
      return searches === 1
        ? sub(call.name, '', true, call.key)
        : sub(call.name, '- Deposit move | from: Landlord | date: 2026-10-20 [id m1]', true, call.key);
    }
    if (call.name === 'gmail_read_message') return bodyResult(call);
    return sub(call.name, '', true, call.key);
  }) });
  const reply = await runResearch(h.deps, {
    action: 'start',
    question: 'what did the landlord write about the deposit',
    topic: 'landlord lease deposit',
    lookups: [{ source: 'mail', mail: { q: 'landlord lease deposit' } }],
  }, new AbortController().signal);
  const sent = h.executed.filter(entry => entry.name === 'gmail_search_messages');
  assert.equal(sent.length, 2, 'one search and exactly one broadened retry, never a second round');
  assert.notEqual(sent[1]!.args['q'], sent[0]!.args['q'], 'the retry asks a broader question');
  assert.ok(String(sent[0]!.args['q']).includes('landlord'), 'the first search carries the owner name');
  const reads = h.executed.filter(entry => entry.name === 'gmail_read_message');
  assert.equal(reads.length, 1, 'the top body is read inside the same call');
  assert.equal(reads[0]!.args['id'], 'm1');
  const slices = reply['bodySlices'] as { text: string }[] | undefined;
  assert.ok(Array.isArray(slices) && slices.length > 0, 'the body comes back in the one reply');
  assert.match(String(reply['coverage']), /^coverage: /u);
  assert.match(String(reply['coverage']), /mail complete/u);
  assert.notEqual(reply['canContinue'], true, 'the ask is answered, nothing is left to page through');
  assert.equal(h.logs.length, 1, 'one research invocation');
});

test('COMPOSE 1b: the broadened query drops fillers and never an authored operator', () => {
  assert.equal(broaderQueryOf('what did the landlord say about the deposit'), 'landlord about deposit', 'the fillers go, the name and the content stay');
  assert.equal(broaderQueryOf('from:ana invoice'), undefined, 'an authored operator is the owner predicate');
  assert.equal(broaderQueryOf('"release plan"'), undefined, 'and so is a quoted phrase');
});

test('COMPOSE 2: every reply opens with the coverage header, and a reply at the cap keeps the header, the note and one line per source', async () => {
  const h = harness({
    replyLimit: 900,
    execute: async (subs: readonly IntentSubCall[]) => subs.map(call => sub(call.name,
      call.name === 'gmail_search_messages' ? mailRows(12) : knowledgeHits(12), true, call.key)),
  });
  const reply = await runResearch(h.deps, {
    action: 'start',
    question: 'what do we know about the release plan and the mail about it',
    lookups: [{ source: 'knowledge', query: 'release plan' }, { source: 'mail', mail: { q: 'release plan' } }],
  }, new AbortController().signal);
  assert.equal(Object.keys(reply)[0], 'coverage', 'the header is the first thing the voice reads');
  const header = String(reply['coverage']);
  assert.match(header, /^coverage: /u);
  assert.match(header, /knowledge truncated_to_budget \d+ of \d+ shown/u, 'the knowledge source says what it left out');
  assert.match(header, /mail truncated_to_budget \d+ of \d+ shown/u, 'and so does mail');
  const findings = reply['findings'] as { source: string; text: string }[];
  for (const source of ['knowledge', 'mail']) {
    assert.ok(findings.some(finding => finding.source === source), `one finding line for ${source}`);
  }
  assert.match(String(reply['note'] ?? ''), /more available/iu, 'the note survives the trim');
  assert.doesNotMatch(String(reply['note'] ?? ''), /I did not search/u, 'the header is the one place an unread source is named');
  assert.ok(JSON.stringify(reply).length <= 900, `the header counts inside the cap: ${JSON.stringify(reply).length} chars`);
});

test('CAPHEADER 2 (#634): a header over its share of the cap names every source by status word, and drops none', () => {
  const searched = [{ source: 'knowledge' as const, status: 'truncated_to_budget' as const, shown: 3, total: 9 }, { source: 'mail' as const, status: 'complete' as const, shown: 2, total: 2 }];
  const unsearched = [{ source: 'calendar' as const, reason: 'skipped_by_route' as const }, { source: 'chat' as const, reason: 'skipped_by_route' as const }, { source: 'web' as const, reason: 'not_configured' as const }];
  const detailed = coverageLine(searched, unsearched, 2_000);
  assert.match(detailed, /knowledge truncated_to_budget 3 of 9 shown/u, 'a header with room keeps its counts');
  const brief = coverageLine(searched, unsearched, 600);
  assert.ok(brief.length <= 150, `the brief header keeps its quarter of the cap: ${brief.length} of 150`);
  for (const name of ['knowledge', 'mail', 'calendar', 'chat', 'web']) {
    assert.match(brief, new RegExp(`(?:^|: |; )${name} \\w+`, 'u'), `the header still names ${name}: ${brief}`);
  }
  assert.doesNotMatch(brief, /say: /u, 'the spoken clauses go before a source does');
  assert.doesNotMatch(brief, /not shown/u, 'nothing is counted out of the header');
});

test('COMPOSE 3: a source the ask routes to but the session never configured is not_configured, and a failed source is provider_failed', async () => {
  const h = harness({
    configured: ['mail'],
    execute: async (subs: readonly IntentSubCall[]) => subs.map(call => call.name === 'gmail_search_messages'
      ? sub(call.name, '', false, call.key)
      : sub(call.name, '', true, call.key)),
  });
  const reply = await runResearch(h.deps, {
    action: 'start',
    question: 'check the web and my mail for the release note',
    lookups: [{ source: 'mail', mail: { q: 'release note' } }, { source: 'web', query: 'release note' }],
  }, new AbortController().signal);
  const header = String(reply['coverage']);
  assert.match(header, /mail provider_failed/u, 'a source that answered with a failure is never an empty search');
  assert.match(header, /web not_configured/u, 'a source the session never wired says so');
  assert.doesNotMatch(header, /web (?:empty|complete)/u);
  assert.match(header, /say: /u, 'each unsearched source carries the one clause the voice can say');
});

test('COMPOSE 4: the allocator clips at a word boundary and the header counts the lines it dropped', async () => {
  const h = harness({
    replyLimit: 480,
    execute: async (subs: readonly IntentSubCall[]) => subs.map(call => sub(call.name, knowledgeHits(10), true, call.key)),
  });
  const reply = await runResearch(h.deps, {
    action: 'start',
    question: 'what do we know about the release plan',
    lookups: [{ source: 'knowledge', query: 'release plan' }],
  }, new AbortController().signal);
  const finding = (reply['findings'] as { source: string; text: string }[]).find(entry => entry.source === 'knowledge');
  assert.ok(finding, 'the source keeps its evidence');
  const counts = /: (\d+) of (\d+) shown/u.exec(finding.text);
  assert.ok(counts, 'the finding names what it shows');
  const lines = finding.text.split('\n').slice(1).filter(Boolean).length;
  assert.equal(Number(counts[1]), lines, 'the count equals the lines it kept');
  assert.ok(Number(counts[2]) > Number(counts[1]), 'the read matched more than the reply could keep');
  const header = /knowledge truncated_to_budget (\d+) of (\d+) shown/u.exec(String(reply['coverage']));
  assert.ok(header, 'the header names the truncation');
  assert.equal(Number(header[1]), Number(counts[1]), 'the header counts the lines the finding carries');
  assert.equal(Number(header[2]), Number(counts[2]), 'and the lines the read matched');
  assert.equal(clip('alpha bravo charlie', 14), 'alpha bravo\u2026', 'a clip ends on a whole word');
  assert.equal(clip('alpha bravo charlie', 30), 'alpha bravo charlie', 'a text inside its room is untouched');
});

// --- #635: a read still in flight is still reading in the header, the same thing the note says --------

interface FakeClock { now: () => number; schedule: (callback: () => void, delayMs: number) => { unref: () => void; cancel: () => void }; advance: (to: number) => void }

function fakeClock(): FakeClock {
  let at = 0;
  const timers: { due: number; callback: () => void; done: boolean }[] = [];
  return {
    now: () => at,
    schedule: (callback, delayMs) => {
      const entry = { due: at + delayMs, callback, done: false };
      timers.push(entry);
      return { unref: () => {}, cancel: () => { entry.done = true; } };
    },
    advance: to => {
      at = to;
      for (let guard = 0; guard < 20; guard++) {
        const due = timers.filter(entry => !entry.done && entry.due <= at);
        if (due.length === 0) return;
        for (const entry of due) { entry.done = true; entry.callback(); }
      }
    },
  };
}

test('#635: a chat read still in flight when the reply is composed says still_reading, matching the note', async () => {
  const clock = fakeClock();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = harness({ now: clock.now, schedule: clock.schedule, execute: async (subs: readonly IntentSubCall[]) => {
    if (subs.some(call => call.name === 'mattermost_search')) await gate;
    return subs.map(call => sub(call.name, call.name === 'gmail_search_messages' ? mailRows(2) : 'evidence', true, call.key));
  } });

  const call = runResearch(h.deps, {
    action: 'start', question: 'what did the team say in chat about the release, and what does my mail say',
    lookups: [{ source: 'mail', mail: { q: 'release' } }, { source: 'chat', query: 'release' }],
  }, new AbortController().signal);
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
  clock.advance(RESEARCH.firstAnswerMs);
  const reply = await call;
  const header = String(reply['coverage']);
  assert.match(header, /chat still_reading/u, `the header names the read still in flight (${header})`);
  assert.doesNotMatch(header, /chat skipped_by_route/u, 'a read nobody skipped is never called skipped');
  assert.match(String(reply['note']), /Still reading: chat/u, 'and the note says the same thing');
  release();
});

// #639: the header and the voice both name the company source a question only company ask wanted, so an
// endpoint that is not signed in is never silence in the reply.
test('#639: a question only company ask carries the company source in the header and says it is not signed in', async () => {
  const h = harness({
    configured: ['knowledge', 'calendar', 'mail', 'chat', 'mongoose'],
    unavailableNow: () => [{ source: 'mongoose', reason: 'not_signed_in' }],
    execute: async (subs: readonly IntentSubCall[]) => subs.map(call => sub(call.name,
      call.name === 'search_knowledge' ? knowledgeHits(2) : 'evidence', true, call.key)),
  });
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'which of our customers are on the renewal',
  }, new AbortController().signal);
  const header = String(reply['coverage']);
  assert.match(header, /mongoose \w+/u, `the header names the company source the ask wanted (${header})`);
  assert.match(header, /knowledge complete/u, `and the knowledge base beside it (${header})`);
  const note = String(reply['note'] ?? '');
  assert.match(note, /company knowledge: unavailable \(not signed in\)/u, `the voice says why the company layer is missing (${note})`);
});


// --- #654: an old researchId never carries a new source or a new topic into the run it names ---------

test('#654: an old researchId carrying a new source starts a fresh run and issues no mail call', async () => {
  const h = harness({ configured: ['knowledge', 'mail', 'chat'] });
  const signal = new AbortController().signal;
  const first = await runResearch(h.deps, {
    action: 'start', question: 'the renewal mail from the customer', topic: 'renewal',
    lookups: [{ source: 'mail', mail: { q: 'renewal' } }],
  }, signal);
  const oldId = String(first['researchId']);
  assert.ok(h.executed.some(call => call.name === 'gmail_search_messages'), 'the first run reads mail');
  const more = await runResearch(h.deps, { action: 'continue', researchId: oldId, direction: 'more' }, signal);
  assert.equal(String(more['researchId']), oldId, 'a request for more continues the run it names');
  h.executed.length = 0;
  const fresh = await runResearch(h.deps, {
    action: 'continue', researchId: oldId, question: 'search the web for the release notes',
    direction: 'search the web', lookups: [{ source: 'knowledge', query: 'release notes' }],
  }, signal);
  assert.notEqual(String(fresh['researchId']), oldId, 'the new source runs under its own researchId');
  assert.match(String(fresh['note']), /fresh lookup, not a continuation/u, `the reply says it started fresh (${String(fresh['note'])})`);
  assert.ok(!h.executed.some(call => call.name === 'gmail_search_messages'), 'the web ask issues no mail read');
});

// --- #653: a status ask names what each source actually did ------------------------------------------

test('#653: a status ask on a closed run names each source by its closed outcome, never still reading', async () => {
  const clock = fakeClock();
  const h = harness({
    now: clock.now, schedule: clock.schedule, configured: ['calendar', 'mail', 'chat'],
    // A real read is cut by the signal its deadline carries, so the fake waits for that signal.
    execute: async (subs: readonly IntentSubCall[], signal?: AbortSignal) => {
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) return reject(new Error('cut'));
        signal?.addEventListener('abort', () => reject(new Error('cut')));
      });
      return subs.map(call => sub(call.name, '', true, call.key));
    },
  });
  const call = runResearch(h.deps, { action: 'start', question: 'are my tools working', topic: 'tools' }, new AbortController().signal);
  for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
  clock.advance(RESEARCH.startDeadlineMs + 1);
  const reply = await call;
  const note = String(reply['note']);
  assert.match(note, /team chat did not answer within 10 seconds/u, `chat is named by its closed outcome (${note})`);
  assert.match(note, /mail did not answer within 12 seconds/u, `mail is named by its closed outcome (${note})`);
  assert.doesNotMatch(note, /alive|working/iu, 'no source is called alive or working');
  assert.doesNotMatch(note, /Still reading/u, 'a closed run never says still reading');
});

test('#653: a status ask says a calendar that answered nothing, in plain words', async () => {
  const h = harness({
    configured: ['calendar', 'mail'],
    execute: async (subs: readonly IntentSubCall[]) => subs.map(call => (call.name.startsWith('calendar_')
      ? { key: call.key, name: call.name, ok: true, text: '', originalCharacters: 0, omittedCharacters: 0, calendarPage: { events: [], unread: 0, upstreamIncomplete: false } }
      : sub(call.name, call.name === 'gmail_search_messages' ? mailRows(1) : '', true, call.key)) as IntentSubResult),
  });
  const reply = await runResearch(h.deps, { action: 'start', question: 'is my calendar alive today', topic: 'tools' }, new AbortController().signal);
  const note = String(reply['note']);
  assert.match(note, /calendar answered, nothing/u, `a source that answered empty says so (${note})`);
  assert.doesNotMatch(note, /alive|working/iu, 'and no source is called alive or working');
});

// --- #657 item 1: a test-all ask wider than the lookup limit is batched, never refused ----------------

test('#657 item 1: a six-source test-all ask is served in one batch and names the rest', async () => {
  const h = harness({ configured: ['calendar', 'mail', 'chat', 'knowledge', 'mongoose'] });
  const reply = await runResearch(h.deps, { action: 'start', question: 'test all tools', topic: 'tools' }, new AbortController().signal);
  const kindOf = (name: string): string => name === 'gmail_search_messages' ? 'mail'
    : name === 'mattermost_search' ? 'chat'
      : name === 'calendar_list_events' || name === 'calendar_list_calendars' ? 'calendar'
        : name === 'search_knowledge' ? 'knowledge' : name;
  const read = new Set(h.executed.map(call => kindOf(call.name)));
  assert.ok(read.size <= MAX_LOOKUPS, `the first batch stays within the limit (${[...read].join(',')})`);
  assert.match(String(reply['note']), /The rest come next: company knowledge/u, `the reply names the sources it left for the next call (${String(reply['note'])})`);
  assert.equal(reply['canContinue'], true, 'and the rest can be asked for');
  const lookups = [
    { source: 'calendar', query: 'today' }, { source: 'mail', query: 'inbox' }, { source: 'chat', query: 'release' },
    { source: 'knowledge', query: 'release' }, { source: 'company', query: 'renewal' }, { source: 'web', query: 'release' },
  ];
  const parsed = parseResearch({ action: 'start', question: 'test all tools', topic: 'tools', lookups });
  assert.equal(parsed.ok, true, 'a six-source test-all ask is never refused whole');
});

// --- #657 item 2: a status check reads one page of mail, never one message per call ------------------

test('#657 item 2: a status check reads one page of mail, not one message per call', async () => {
  const h = harness({ configured: ['mail'] });
  await runResearch(h.deps, {
    action: 'start', question: 'are my tools working', topic: 'tools',
    lookups: [{ source: 'mail', mail: { q: 'in:inbox newer_than:14d', maxResults: 1 } }],
  }, new AbortController().signal);
  const pages = h.executed.filter(call => call.name === 'gmail_search_messages');
  assert.equal(pages.length, 1, 'one mail page, one call');
  assert.equal(Number(pages[0]!.args['maxResults']), RESEARCH.pageResults.mail, 'the page is the connector page, not one message');
});


// --- REVIEWFIX F1: a status ask is about the tools themselves, never an ordinary question ------------

test('#653 review: an ordinary question that mentions a source and a status word is not a status ask', () => {
  for (const ordinary of ['is there mail from the bank up to Friday', 'are the numbers in the report working out', 'is my inbox up to date']) {
    assert.equal(statusAsk(ordinary), false, `"${ordinary}" is a real question, not a status ask`);
  }
  for (const about of ['are my tools working', 'is my calendar alive today', 'test all tools', 'check the tools', 'is chat connected']) {
    assert.equal(statusAsk(about), true, `"${about}" asks about the tools`);
  }
});

test('#653 review: an ordinary mail question is never answered by a status sweep', async () => {
  const h = harness({ configured: ['calendar', 'chat', 'mail'] });
  const reply = await runResearch(h.deps, { action: 'start', question: 'is there mail from the bank up to Friday', topic: 'bank' }, new AbortController().signal);
  const read = new Set(h.executed.map(call => call.name));
  assert.ok(read.has('gmail_search_messages'), `the mail question reads mail (${[...read].join(',')})`);
  assert.equal(read.has('mattermost_search'), false, 'and it is not answered by a chat status read');
  assert.doesNotMatch(String(reply['note']), /answered|did not answer within/u, 'and no status sentence replaces the answer note');
});

// --- REVIEWFIX F2: a continuation with no direction is judged on its question and lookups -----------

test('#654 review: a continuation with no direction that names an unread source starts fresh', async () => {
  const h = harness({ configured: ['knowledge', 'mail', 'chat'] });
  const first = await runResearch(h.deps, {
    action: 'start', question: 'the renewal mail from the customer', topic: 'renewal',
    lookups: [{ source: 'mail', mail: { q: 'renewal' } }],
  }, new AbortController().signal);
  const oldId = String(first['researchId']);
  const fresh = await runResearch(h.deps, {
    action: 'continue', researchId: oldId, question: 'read the web for the release notes',
    lookups: [{ source: 'knowledge', query: 'release notes' }],
  }, new AbortController().signal);
  assert.notEqual(String(fresh['researchId']), oldId, 'the unread source runs under its own researchId');
});

test('#654 review: a continuation with no direction on a new topic starts fresh and the same topic continues', async () => {
  const h = harness({ configured: ['knowledge', 'mail', 'chat'] });
  const first = await runResearch(h.deps, {
    action: 'start', question: 'the renewal mail from the customer', topic: 'renewal',
    lookups: [{ source: 'mail', mail: { q: 'renewal' } }],
  }, new AbortController().signal);
  const oldId = String(first['researchId']);
  const same = await runResearch(h.deps, {
    action: 'continue', researchId: oldId, question: 'more about the renewal mail from the customer',
    lookups: [{ source: 'mail', mail: { q: 'renewal' } }],
  }, new AbortController().signal);
  assert.equal(String(same['researchId']), oldId, 'the same topic continues the run it names');
  const fresh = await runResearch(h.deps, {
    action: 'continue', researchId: oldId, question: 'how did the quarterly forecast end',
    lookups: [{ source: 'mail', mail: { q: 'forecast' } }],
  }, new AbortController().signal);
  assert.notEqual(String(fresh['researchId']), oldId, 'a new topic starts its own run');
});

// --- REVIEWFIX F3: the declaration states the lookup keys and the limit ------------------------------

test('#657 review: the tool declaration states the lookup limit and the allowed keys', () => {
  const text = JSON.stringify(researchDeclaration(['knowledge', 'mail', 'chat']));
  assert.match(text, /at most 4 lookups, each with source/iu, 'the first sentence names the limit and the source key');
  assert.match(text, /query, mail or history/u, 'and the three other keys a lookup may carry');
  assert.match(text, /memory, knowledge, company, calendar, mail, chat, replies or web/u, 'and the values the source key takes');
});

// --- REVIEWFIX G1: the second status alternative matched ordinary content questions -------------------

test('#653 review 2: an ordinary question that only shares a source word and a state word is not a status ask', () => {
  for (const ordinary of ['the mail thread we were working on yesterday', 'what did the calendar say about the working group']) {
    assert.equal(statusAsk(ordinary), false, `"${ordinary}" is a real question, not a status ask`);
  }
  for (const about of ['are my tools working', 'is my calendar alive today', 'test all tools', 'check the tools', 'is chat connected']) {
    assert.equal(statusAsk(about), true, `"${about}" asks about the tools`);
  }
});

// --- REVIEWFIX G2: a lookups-free continuation is judged on its question too -------------------------

test('#654 review 2: a lookups-free continuation on a new topic starts fresh', async () => {
  const h = harness({ configured: ['knowledge', 'mail', 'chat'] });
  const first = await runResearch(h.deps, {
    action: 'start', question: 'the renewal mail from the customer', topic: 'renewal',
    lookups: [{ source: 'mail', mail: { q: 'renewal' } }],
  }, new AbortController().signal);
  const oldId = String(first['researchId']);
  const fresh = await runResearch(h.deps, {
    action: 'continue', researchId: oldId, question: 'how did the Blackwell contract win go',
  }, new AbortController().signal);
  assert.notEqual(String(fresh['researchId']), oldId, 'a new topic with no lookups starts its own run');
});

test('#654 review 2: a lookups-free continuation that points back at the run still continues', async () => {
  const h = harness({ configured: ['knowledge', 'mail', 'chat'] });
  const first = await runResearch(h.deps, {
    action: 'start', question: 'the renewal mail from the customer', topic: 'renewal',
    lookups: [{ source: 'mail', mail: { q: 'renewal' } }],
  }, new AbortController().signal);
  const oldId = String(first['researchId']);
  const same = await runResearch(h.deps, {
    action: 'continue', researchId: oldId, question: 'explain the prior discussion and identify the relevant blocker',
  }, new AbortController().signal);
  assert.equal(String(same['researchId']), oldId, 'a question that points back at the run continues it');
  const plain = await runResearch(h.deps, { action: 'continue', researchId: oldId }, new AbortController().signal);
  assert.equal(String(plain['researchId']), oldId, 'a bare continue still continues');
});

// --- RESEARCHFIX-R2: a continuation word is not a new topic ------------------------------------------

test('#654 ruling R2: a finish continuation on the same topic continues the run', async () => {
  const h = harness({ configured: ['knowledge', 'mail', 'chat'] });
  const first = await runResearch(h.deps, {
    action: 'start', question: 'the renewal mail from the customer', topic: 'renewal',
    lookups: [{ source: 'mail', mail: { q: 'renewal' } }],
  }, new AbortController().signal);
  const oldId = String(first['researchId']);
  const same = await runResearch(h.deps, {
    action: 'continue', researchId: oldId, question: 'finish the results on the renewal mail from the customer',
  }, new AbortController().signal);
  assert.equal(String(same['researchId']), oldId, 'a finish continuation on the same topic continues the run');
});

// --- #675: a status ask names every configured source, in the shape that source's own ask uses -------

/** Every configured source answers in its own real shape, except the company one, which is signed out. */
function statusFixture(): { execute: ResearchDeps['execute']; web: NonNullable<ResearchDeps['web']> } {
  return {
    web: {
      search: async () => ({ ok: true as const, evidence: {
        answer: 'The bridge reopens on Monday.', claims: [{ text: 'The bridge reopens on Monday.', sourceIndexes: [0] }],
        sources: [{ title: 'Bridge notice', url: 'https://example.com/bridge' }], retrievedAt: '2026-10-25T07:00:00.000Z',
      } }),
    },
    execute: async (subs: readonly IntentSubCall[]) => subs.map(call => {
      if (call.name === 'calendar_list_calendars') return sub(call.name, '- Main [primary]', true, call.key);
      if (call.name === 'calendar_list_events') {
        return { key: call.key, name: call.name, ok: true, ...shapeGcalList({ events: [{ id: 'd1', start: '2026-10-19T10:00:00Z', summary: 'Release review' }] }) } as IntentSubResult;
      }
      if (call.name === 'gmail_search_messages') return sub(call.name, mailRows(2), true, call.key);
      if (call.name === 'mattermost_search') return sub(call.name, '- the release thread, from Ana', true, call.key);
      return sub(call.name, knowledgeHits(1), true, call.key);
    }),
  };
}

const STATUS_SOURCES = ['knowledge', 'calendar', 'mail', 'chat', 'mongoose', 'web'] as const;
const STATUS_SIGNED_OUT = () => [{ source: 'mongoose' as const, reason: 'not_signed_in' }];

test('#675: a status ask names every configured source across the batch it announces, and reads each one its own way', async () => {
  const fixture = statusFixture();
  const h = harness({ configured: STATUS_SOURCES, web: fixture.web, unavailableNow: STATUS_SIGNED_OUT, execute: fixture.execute });
  const first = await runResearch(h.deps, { action: 'start', question: 'test all the tools' }, new AbortController().signal);
  const firstNote = String(first['note']);
  // The calendar is read with a real window, so it is never called failed on the status path.
  for (const label of ['knowledge base', 'calendar', 'mail', 'team chat']) {
    assert.match(firstNote, new RegExp(`${label} answered`), `the first answer names ${label} (${firstNote})`);
  }
  assert.doesNotMatch(firstNote, /failed|could not|not answer/u, `no read source is called failed (${firstNote})`);
  assert.match(firstNote, /The rest come next: company knowledge, the web/u, `the answer announces the rest (${firstNote})`);
  const second = await runResearch(h.deps, {
    action: 'continue', researchId: String(first['researchId']), question: 'test all the tools', lookups: [],
  }, new AbortController().signal);
  const secondNote = String(second['note']);
  assert.match(secondNote, /company knowledge is signed out/u, `a signed out source says so (${secondNote})`);
  assert.match(secondNote, /the web answered/u, `the web is read and named (${secondNote})`);
  for (const label of ['knowledge base answered', 'calendar answered', 'mail answered', 'team chat answered']) {
    assert.match(secondNote, new RegExp(label), `the second answer keeps what the first read (${secondNote})`);
  }
  // The host's own status shape decides the read, so the model lookups never change the counts it states.
  const looked = harness({ configured: STATUS_SOURCES, web: fixture.web, unavailableNow: STATUS_SIGNED_OUT, execute: fixture.execute });
  const lookupsMode = await runResearch(looked.deps, {
    action: 'start', question: 'test all the tools',
    lookups: [{ source: 'mail', query: 'from:ana' }, { source: 'knowledge', query: 'release' }],
  }, new AbortController().signal);
  // Source order follows how the batch was assembled, so the lines are compared as a set, never by order.
  const clauseOf = (text: string): string[] => text.split(/;\s*/u).map(line => line.trim()).filter(Boolean).sort();
  assert.deepEqual(clauseOf(String(lookupsMode['note'])), clauseOf(firstNote), 'the model lookups never change what a status answer says');
  assert.deepEqual(clauseOf(String(lookupsMode['coverage'] ?? '')), clauseOf(String(first['coverage'] ?? '')), 'and the counts it states come from the same read');
});

// --- #675: a closed code that is not a sign-out is never called signed out --------------------------

test('#675: a token budget code is not read as a sign-out', async () => {
  const h = harness({
    configured: ['mongoose'],
    unavailableNow: () => [{ source: 'mongoose', reason: 'token_budget_exhausted' }],
  });
  const reply = await runResearch(h.deps, { action: 'start', question: 'are my tools working' }, new AbortController().signal);
  const note = String(reply['note']);
  assert.doesNotMatch(note, /signed out/u, `an exhausted token budget is not a sign-out (${note})`);
  assert.match(note, /company knowledge/u, `the source is still named (${note})`);
});

// L8-13: a continue whose mail deadline was already spent ran no mail read at all (0 ms, no dispatch), and
// the header still said `mail partial_timeout` with "My mail read took too long". The label is the outcome.
test('L8-13: a mail read that never ran is never called a read that took too long', async () => {
  const { shapeGmailList } = await import('../tools/live-shape.js');
  let at = 0;
  const timers: { due: number; callback: () => void; done: boolean }[] = [];
  const schedule: NonNullable<ResearchDeps['schedule']> = (callback, delayMs) => {
    const entry = { due: at + delayMs, callback, done: false };
    timers.push(entry);
    return { unref: () => {}, cancel: () => { entry.done = true; } };
  };
  const advance = (to: number): void => {
    at = to;
    for (let guard = 0; guard < 20; guard++) {
      const due = timers.filter(entry => !entry.done && entry.due <= at);
      if (due.length === 0) return;
      for (const entry of due) { entry.done = true; entry.callback(); }
    }
  };
  const flushed = async (): Promise<void> => { for (let tick = 0; tick < 20; tick += 1) await new Promise(resolve => setImmediate(resolve)); };
  const page = shapeGmailList({ nextPageToken: 'p2', messages: [1, 2, 3].map(n => ({ id: `m${n}`, threadId: `t${n}`, internalDate: '1792900000000', snippet: 'about the demo',
    payload: { headers: [{ name: 'Subject', value: `Demo ${n}` }, { name: 'From', value: 'Ana <ana@example.invalid>' }] } })) });
  let mailPages = 0;
  const h = harness({ now: () => at, schedule, web: { search: () => new Promise(() => {}) },
    execute: async calls => calls.map(call => {
      if (call.name.includes('gmail')) { mailPages += 1; return { key: call.key, name: call.name, ok: true, ...page }; }
      return sub(call.name, knowledgeHits(1), true, call.key);
    }) });
  const signal = new AbortController().signal;
  const started = runResearch(h.deps, { action: 'start', question: 'who is on the demo meeting tomorrow and what do mails say about it',
    lookups: [{ source: 'mail', query: 'demo meeting attendees' }, { source: 'knowledge', query: 'demo meeting attendees' }, { source: 'web', query: 'example company demo' }] }, signal);
  await flushed(); advance(1000); await flushed(); advance(RESEARCH.firstAnswerMs + 100); await flushed();
  const first = await started;
  const pagesBefore = mailPages;
  const continued = runResearch(h.deps, { action: 'continue', researchId: String(first['researchId']) }, signal);
  await flushed(); advance(RESEARCH.answerCapMs * 2); await flushed();
  const second = await continued;
  assert.equal(mailPages, pagesBefore, 'the continue ran no mail page, the case this pins');
  const header = String(second['coverage'] ?? '');
  assert.doesNotMatch(header, /mail partial_timeout/u, `a read that never ran is not a timeout: ${header}`);
  assert.doesNotMatch(String(second['note'] ?? ''), /mail read took too long/u, `and the note never says it took too long: ${String(second['note'])}`);
  assert.match(header, /mail never_ran \(say: [^)]+\)/u, `the header names the real outcome with its clause: ${header}`);
});
