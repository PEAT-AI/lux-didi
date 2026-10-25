import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RESEARCH, ResearchLedger, budgetFor, raiseBudget, requestedEntities, runResearch } from '../tools/research.js';
import type { ResearchDeps } from '../tools/research.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';
import type { SourceKind } from '../tools/research.js';

/** C-DEPTH items 1, 2 and 4: tiered budgets, an entity aware allocator, honest coverage. */

function sub(name: string, text: string, ok = true, key = name): IntentSubResult {
  return { key, name, ok, text, originalCharacters: text.length, omittedCharacters: 0 };
}

/** One run on a signal nothing aborts: the tests assert composition, not cancellation. */
function research(deps: ResearchDeps, call: Parameters<typeof runResearch>[1]): ReturnType<typeof runResearch> {
  return runResearch(deps, call, new AbortController().signal);
}

const BODY = 'detail from the record '.repeat(6);

function knowledgeHits(count: number): string {
  return Array.from({ length: count }, (_v, index) =>
    `### Release plan ${index} (decision | 2026-10-17) [id ${100 + index}] ${BODY}`).join('\n');
}

/** Long hits, so a reply budget and not the read's own line cap is what binds. */
function longKnowledgeHits(count: number): string {
  return Array.from({ length: count }, (_v, index) =>
    `### Release plan ${index} (decision | 2026-10-17) [id ${100 + index}] ${'detail from the record '.repeat(20)}`).join('\n');
}

function mailRows(count: number): string {
  return Array.from({ length: count }, (_v, index) =>
    `- Release note ${index} | from: Ana | date: 2026-10-16 [id m${index}] ${BODY}`).join('\n');
}

function chatLines(count: number): string {
  return Array.from({ length: count }, (_v, index) =>
    `- #release ${index} | Ana | 2026-10-16 | ${BODY}`).join('\n');
}

/** One knowledge hit that holds three requested people, which is the Clifton shape from lane 11. */
const THREE_PROFILES = [
  '### Ana Clifton (person | 2026-09-14) [id 301] Leads the rollout and owns the vendor review.',
  '### Ben Clifton (person | 2026-09-02) [id 302] Runs the family trust and signs off on spend.',
  '### Cara Clifton (person | 2026-08-21) [id 303] Chairs the foundation and hosts the October dinner.',
].join('\n');

interface Harness { deps: ResearchDeps; text: Record<string, string> }

function harness(opts: {
  text?: Record<string, string>;
  memory?: (query: string) => { lines: string[]; text: string; total: number };
  configured?: readonly SourceKind[];
  replyLimit?: number;
} = {}): Harness {
  const text: Record<string, string> = opts.text ?? {};
  const deps: ResearchDeps = {
    now: () => 0,
    configured: opts.configured ?? (['knowledge', 'mail', 'chat', 'memory'] as const),
    execute: async (subs: readonly IntentSubCall[]) =>
      subs.map(call => sub(call.name, text[call.name] ?? '', true, call.key)),
    emit: () => {},
    log: () => {},
    ledger: new ResearchLedger(),
    ...(opts.replyLimit === undefined ? {} : { replyLimit: opts.replyLimit }),
  };
  if (opts.memory !== undefined) {
    const inner = deps.execute;
    const memory = opts.memory;
    deps.execute = async (subs: readonly IntentSubCall[], signal: AbortSignal) => {
      if (!subs.every(call => call.name === 'conversation_history')) return inner(subs, signal);
      return subs.map(call => {
        const found = memory(String(call.args['query'] ?? ''));
        return {
          key: call.key, name: call.name, ok: true, text: '', originalCharacters: 0, omittedCharacters: 0,
          binding: { executionId: call.key } as NonNullable<IntentSubResult['binding']>,
          historyPage: { status: 'ok', hits: found.lines.map(snippet => ({ snippet })), totalMatches: found.total, nextCursor: null },
        } as IntentSubResult;
      });
    };
  }
  return { deps, text };
}

function evidenceOf(reply: Record<string, unknown>, source: string): string {
  const findings = (reply['findings'] ?? []) as { source: string; text: string }[];
  return findings.filter(finding => finding.source === source).map(finding => finding.text).join('\n');
}

function allEvidence(reply: Record<string, unknown>): string {
  const findings = (reply['findings'] ?? []) as { source: string; text: string }[];
  return findings.map(finding => finding.text).join('\n');
}

test('BUDGET 1: the tiered budgets are the three C-DEPTH sizes, classified from the owner request', () => {
  assert.deepEqual(RESEARCH.budgets, { default: 12_000, analytical: 16_000, depth: 20_000 });
  assert.equal(budgetFor('what is the plan for the release'), RESEARCH.budgets.default, 'a plain ask is the default tier');
  assert.equal(budgetFor('compare the two release plans and the team implications'),
    RESEARCH.budgets.analytical, 'a comparison with implications is the analytical tier');
  assert.equal(budgetFor('go deep on the Clifton profiles, in detail'), RESEARCH.budgets.depth,
    'an explicit ask for depth is the depth tier');
  assert.equal(budgetFor('compare them in detail'), RESEARCH.budgets.depth, 'the depth ask wins over the comparison');
});

test('BUDGET 2: a classification may raise the budget during retrieval and never lower it', () => {
  assert.equal(raiseBudget(RESEARCH.budgets.depth, 'what is the plan'), RESEARCH.budgets.depth,
    'a depth run is never narrowed by a later plain question');
  assert.equal(raiseBudget(RESEARCH.budgets.default, 'compare the plans in detail'), RESEARCH.budgets.depth,
    'a later deeper question raises the budget');
});

test('BUDGET 3: the default tier delivers more evidence than the old 2,500 char cap', async () => {
  const h = harness({ text: { search_knowledge: knowledgeHits(30) } });
  const reply = await research(h.deps, {
    action: 'start', question: 'what do we know about the release plan',
    lookups: [{ source: 'knowledge', query: 'release plan' }],
  });
  assert.ok(allEvidence(reply as Record<string, unknown>).length > 2_500,
    `the default tier is deeper than the old cap: ${allEvidence(reply as Record<string, unknown>).length}`);
  assert.ok(JSON.stringify(reply).length <= RESEARCH.budgets.default,
    `the whole reply stays inside the budget: ${JSON.stringify(reply).length}`);
});

test('ALLOC 1 Clifton regression: one hit holding three requested people delivers all three', async () => {
  const fragments = Array.from({ length: 5 }, (_v, index) => `- fragment ${index} prefers the thin evidence budget`);
  const h = harness({
    text: { search_knowledge: THREE_PROFILES },
    memory: () => ({ lines: fragments, text: fragments.join('\n'), total: fragments.length }),
  });
  const reply = await research(h.deps, {
    action: 'start', question: 'what do we know about Ana, Ben and Cara Clifton',
    lookups: [{ source: 'knowledge', query: 'Clifton' }, { source: 'memory', query: 'Clifton' }],
  });
  const evidence = evidenceOf(reply as Record<string, unknown>, 'knowledge');
  for (const person of ['Ana', 'Ben', 'Cara']) {
    assert.match(evidence, new RegExp(`\\b${person} Clifton\\b`, 'u'), `${person} is delivered even beside memory`);
  }
  assert.equal(evidenceOf(reply as Record<string, unknown>, 'memory'), '',
    'memory the ask did not refer to gets no allocation beside a named person');
});

test('ALLOC 2: an ask that names no person may use her memory', async () => {
  const lines = ['- last time we agreed the deposit moves on Monday', '- and the invoice waits for the trust'];
  const h = harness({ memory: () => ({ lines, text: lines.join('\n'), total: lines.length }) });
  const reply = await research(h.deps, {
    action: 'start', question: 'what did we say last time about the deposit',
    lookups: [{ source: 'memory', query: 'deposit' }],
  });
  assert.match(evidenceOf(reply as Record<string, unknown>, 'memory'), /deposit moves on Monday/u,
    'a past conversation ask is answered from memory');
});

test('ALLOC 3: every non empty source gets substantive evidence, not just its first line', async () => {
  const h = harness({
    text: {
      search_knowledge: knowledgeHits(20),
      gmail_search_messages: mailRows(20),
      mattermost_search: chatLines(20),
    },
  });
  const reply = await research(h.deps, {
    action: 'start', question: 'what do we know about the release plan and the mail and chat about it',
    lookups: [{ source: 'knowledge', query: 'release plan' }, { source: 'mail', query: 'release' },
      { source: 'chat', query: 'release' }],
  });
  for (const source of ['knowledge', 'mail', 'chat']) {
    const chars = evidenceOf(reply as Record<string, unknown>, source).length;
    assert.ok(chars >= RESEARCH.sourceFloorChars * 0.8, `${source} keeps about its floor: ${chars}`);
  }
});

test('ALLOC 4: a repeated hit across two reads is shown once', async () => {
  const h = harness({ text: { search_knowledge: knowledgeHits(6) } });
  const reply = await research(h.deps, {
    action: 'start', question: 'what do we know about the release plan',
    lookups: [{ source: 'knowledge', query: 'release plan' }, { source: 'knowledge', query: 'release plan 3' }],
  });
  const evidence = evidenceOf(reply as Record<string, unknown>, 'knowledge');
  assert.equal(evidence.split('Release plan 3 (').length - 1, 1, `one copy of a repeated hit: ${evidence.length}`);
});

test('ALLOC 5: conflicting dated evidence survives both dates', async () => {
  const lines = [
    '### Release date (decision | 2026-09-01) [id 401] The release lands on 2026-10-10.',
    '### Release date (decision | 2026-10-01) [id 402] The release moved to 2026-11-02.',
  ].join('\n');
  const h = harness({ text: { search_knowledge: lines } });
  const reply = await research(h.deps, {
    action: 'start', question: 'when is the release date',
    lookups: [{ source: 'knowledge', query: 'release date' }],
  });
  const evidence = evidenceOf(reply as Record<string, unknown>, 'knowledge');
  assert.match(evidence, /2026-10-10/u, 'the older statement is not deleted by the newer one');
  assert.match(evidence, /2026-11-02/u, 'and the newer one is there');
});

test('ALLOC 6: a requested person with no evidence is named missing and never invented', async () => {
  const twoOnly = THREE_PROFILES.split('\n').slice(0, 2).join('\n');
  const h = harness({ text: { search_knowledge: twoOnly } });
  const reply = await research(h.deps, {
    action: 'start', question: 'what do we know about Ana, Ben and Cara Clifton',
    lookups: [{ source: 'knowledge', query: 'Clifton' }],
  });
  const header = String(reply['coverage']);
  assert.match(header, /missing: Cara/u, `the header names the person it could not cover: ${header}`);
  assert.doesNotMatch(allEvidence(reply as Record<string, unknown>), /\bCara\b/u, 'nothing is invented for her');
});

test('COVER 1: the header counts per source what was represented, and says full or excerpt', async () => {
  const h = harness({
    text: { search_knowledge: knowledgeHits(200), gmail_search_messages: mailRows(3) },
  });
  const reply = await research(h.deps, {
    action: 'start', question: 'what do we know about the release plan and the mail about it',
    lookups: [{ source: 'knowledge', query: 'release plan' }, { source: 'mail', query: 'release' }],
  });
  const header = String(reply['coverage']);
  assert.match(header, /^coverage: /u);
  assert.match(header, /knowledge \w+ \d+ of \d+/u, `per source represented of returned: ${header}`);
  assert.match(header, /mail full/u, 'mail fits, so it is called full');
  assert.match(header, /knowledge excerpt/u, 'knowledge was cut, so it is called an excerpt');
});

test('COVER 2: an asked for entity that was covered is counted, and an excerpt is never called full', async () => {
  const h = harness({ text: { search_knowledge: THREE_PROFILES } });
  const reply = await research(h.deps, {
    action: 'start', question: 'what do we know about Ana and Ben',
    lookups: [{ source: 'knowledge', query: 'Clifton' }],
  });
  const header = String(reply['coverage']);
  assert.match(header, /entities 2 of 2/u, `both asked entities are counted covered: ${header}`);
  assert.doesNotMatch(header, /missing:/u, 'nothing is missing');
});

test('DEPTH 1: the depth tier delivers more evidence, not more metadata', async () => {
  const text = { search_knowledge: longKnowledgeHits(60) };
  const shallow = harness({ text: { ...text }, replyLimit: RESEARCH.budgets.default });
  const deep = harness({ text: { ...text }, replyLimit: RESEARCH.budgets.depth });
  const ask = {
    action: 'start' as const, question: 'what do we know about the release plan and the mail about it',
    lookups: [{ source: 'knowledge' as const, query: 'release plan' }, { source: 'mail' as const, query: 'release' }],
  };
  const shallowReply = await research(shallow.deps, ask);
  const deepReply = await research(deep.deps, ask);
  const shallowEvidence = allEvidence(shallowReply as Record<string, unknown>).length;
  const deepEvidence = allEvidence(deepReply as Record<string, unknown>).length;
  assert.ok(deepEvidence > shallowEvidence, `depth carries more evidence: ${deepEvidence} over ${shallowEvidence}`);
  const metadata = (reply: Record<string, unknown>): number => String(reply['coverage'] ?? '').length;
  assert.ok(metadata(deepReply as Record<string, unknown>) - metadata(shallowReply as Record<string, unknown>) < 400,
    'the extra room goes to evidence, not to the header');
});

test('ENTITIES 1: the requested people and documents come from the question, not from a model call', () => {
  assert.deepEqual(requestedEntities('what do we know about Ana, Ben and Cara Clifton'), ['Ana', 'Ben', 'Cara', 'Clifton']);
  assert.deepEqual(requestedEntities('summarise the "vendor review" note'), ['vendor review'],
    'a quoted document is an entity');
  assert.deepEqual(requestedEntities('what is waiting on me'), [], 'an ask naming nobody requests no entity');
});
