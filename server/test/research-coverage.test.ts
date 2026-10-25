import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RESEARCH, ResearchLedger, broaderQueryOf, clip, coverageLine, runResearch, type ResearchDeps, type ResearchProgress, type ResearchRunLog, type SourceKind } from '../tools/research.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';

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

function harness(opts: { execute?: ResearchDeps['execute']; configured?: readonly SourceKind[]; replyLimit?: number; now?: () => number; schedule?: ResearchDeps['schedule'] } = {}): Harness {
  const executed: { name: string; args: Record<string, unknown> }[] = [];
  const progress: ResearchProgress[] = [];
  const logs: ResearchRunLog[] = [];
  const deps: ResearchDeps = {
    now: opts.now ?? (() => 0),
    ...(opts.schedule === undefined ? {} : { schedule: opts.schedule }),
    configured: opts.configured ?? ['knowledge', 'calendar', 'mail', 'chat'],
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
