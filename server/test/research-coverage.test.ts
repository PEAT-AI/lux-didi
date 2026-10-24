import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RESEARCH, ResearchLedger, runResearch, type ResearchDeps, type ResearchProgress, type ResearchRunLog, type SourceKind } from '../tools/research.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';

function sub(name: string, text: string, ok = true, key = name): IntentSubResult {
  return { key, name, ok, text, originalCharacters: text.length, omittedCharacters: 0 };
}

interface Harness {
  deps: ResearchDeps;
  executed: { name: string; args: Record<string, unknown> }[];
  progress: ResearchProgress[];
  logs: ResearchRunLog[];
}

function harness(opts: { execute?: ResearchDeps['execute']; configured?: readonly SourceKind[]; replyLimit?: number } = {}): Harness {
  const executed: { name: string; args: Record<string, unknown> }[] = [];
  const progress: ResearchProgress[] = [];
  const logs: ResearchRunLog[] = [];
  const deps: ResearchDeps = {
    now: () => 0,
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

const BODY_SCOPE = { endpointId: 'local', transport: 'stdio' as const, bindingDigest: 'sha256:compose-scope', schemaDigest: 'sha256:compose-schema', toolName: 'gmail_read_message' };
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
  const h = harness({ execute: async (subs: readonly IntentSubCall[]) => subs.map(call => {
    if (call.name === 'gmail_search_messages') {
      return String(call.args['q'] ?? '').includes('lease')
        ? sub(call.name, '', true, call.key)
        : sub(call.name, '- Deposit move | from: Landlord | date: 2026-10-20 [id m1]', true, call.key);
    }
    if (call.name === 'gmail_read_message') return bodyResult(call);
    return sub(call.name, '', true, call.key);
  }) });
  const reply = await runResearch(h.deps, {
    action: 'start',
    question: 'what did the landlord write about the deposit',
    lookups: [{ source: 'mail', mail: { q: 'landlord lease deposit' } }],
  }, new AbortController().signal);
  const searches = h.executed.filter(entry => entry.name === 'gmail_search_messages');
  assert.equal(searches.length, 2, 'one search and exactly one broadened retry, never a second round');
  assert.notEqual(searches[1]!.args['q'], searches[0]!.args['q'], 'the retry asks a broader question');
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

test('COMPOSE 2: every reply opens with the coverage header, and a reply at the cap keeps the header, the note and one line per source', async () => {
  const wide = (name: string, n: number): string => Array.from({ length: n }, (_v, i) => `- ${name} line ${i} the release plan moved to the autumn window with a longer sentence`).join('\n');
  const h = harness({
    replyLimit: 700,
    execute: async (subs: readonly IntentSubCall[]) => subs.map(call => sub(call.name,
      call.name === 'gmail_search_messages' ? wide('mail', 12) : wide('knowledge', 12), true, call.key)),
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
  assert.ok(JSON.stringify(reply).length <= 700 + 1_200, 'the prose envelope keeps its bound and the header rides outside it');
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
  const words = Array.from({ length: 40 }, (_v, i) => `token${String(i).padStart(2, '0')}`);
  const fixture = words.join(' ');
  const h = harness({
    replyLimit: 480,
    execute: async (subs: readonly IntentSubCall[]) => subs.map(call => sub(call.name,
      Array.from({ length: 10 }, (_v, i) => `- ${i} ${fixture}`).join('\n'), true, call.key)),
  });
  const reply = await runResearch(h.deps, {
    action: 'start',
    question: 'what do we know about the release plan',
    lookups: [{ source: 'knowledge', query: 'release plan' }],
  }, new AbortController().signal);
  const finding = (reply['findings'] as { source: string; text: string }[]).find(entry => entry.source === 'knowledge');
  const present = finding === undefined ? 0 : finding.text.split('\n').filter(line => line.startsWith('- ')).length;
  const known = new Set(words);
  for (const token of (finding?.text ?? '').split(/[^a-z0-9]+/u).filter(Boolean)) {
    if (!/^token/u.test(token)) continue;
    assert.ok(known.has(token), `no clipped fragment leaves the reply: ${token}`);
  }
  const match = /knowledge truncated_to_budget (\d+) of (\d+) shown/u.exec(String(reply['coverage']));
  assert.ok(match, 'the header names the truncation');
  assert.equal(Number(match[2]), 10, 'the header names the lines the read returned');
  assert.equal(Number(match[1]), present, 'and the lines it kept, so the omitted count is the lines dropped');
});
