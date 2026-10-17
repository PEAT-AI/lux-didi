import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LOOKUP_SOURCES, MAX_LOOKUPS, RESEARCH, ResearchLedger, calendarWindowOf, normalizeLookups, researchDeclaration, runResearch,
  validateResearch,
  type ResearchDeps, type ResearchRoutedLog, type SourceKind,
} from '../tools/research.js';
import { declarationsFor } from '../tools/declarations.js';
import { safeEvent } from '../host/log.js';
import type { ToolDefinition } from '../adapters/model/types.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';

const CONFIGURED: readonly SourceKind[] = ['knowledge', 'calendar', 'mail', 'chat', 'mongoose'];

function sub(name: string, text: string, ok = true, key = name): IntentSubResult {
  return { key, name, ok, text, originalCharacters: text.length, omittedCharacters: 0 };
}

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

interface Harness {
  deps: ResearchDeps;
  routed: ResearchRoutedLog[];
  executed: string[];
  selectorCalls: () => number;
}

function harness(opts: {
  now?: () => number;
  configured?: readonly SourceKind[];
  execute?: ResearchDeps['execute'];
  memory?: ResearchDeps['memory'];
  selected?: () => void;
} = {}): Harness {
  const routed: ResearchRoutedLog[] = [];
  const executed: string[] = [];
  let selectorCalls = 0;
  const deps: ResearchDeps = {
    now: opts.now ?? (() => 0),
    configured: opts.configured ?? CONFIGURED,
    execute: opts.execute ?? (async (subs: readonly IntentSubCall[]) => {
      for (const call of subs) executed.push(call.name);
      return subs.map(call => sub(call.name, `${call.name} evidence`, true, call.key));
    }),
    emit: () => {},
    log: () => {},
    logRouted: event => routed.push(event),
    // A selector that answers, so "it was not called" is a real observation rather than a refusal.
    selector: { select: async () => { selectorCalls += 1; opts.selected?.(); return { questionClass: 'cross_source' as const, actions: [], pUseful: {} }; } },
    ledger: new ResearchLedger(),
    ...(opts.memory !== undefined ? { memory: opts.memory } : {}),
  };
  return { deps, routed, executed, selectorCalls: () => selectorCalls };
}

test('a routed start skips the selector and reads every named layer at once', async () => {
  let clock = 0;
  const entered: string[] = [];
  const gate = deferred<void>();
  const h = harness({
    now: () => clock,
    execute: async (subs: readonly IntentSubCall[]) => {
      entered.push(subs[0]!.name);
      if (entered.length === 2) gate.resolve();
      else await gate.promise;
      clock += 1_000;
      return subs.map(call => sub(call.name, `${call.name} evidence`, true, call.key));
    },
  });
  const reply = await Promise.race([
    runResearch(h.deps, {
      action: 'start', question: 'where does the project stand and what is waiting on me',
      lookups: [{ source: 'knowledge', query: 'project status' }, { source: 'mail', query: 'from:plantix' }],
    }, new AbortController().signal),
    new Promise<never>((_, reject) => { setTimeout(() => reject(new Error('lookups did not overlap')), 1_000).unref(); }),
  ]);
  assert.equal(h.selectorCalls(), 0, 'the selector is never called on a routed start');
  assert.deepEqual(entered, ['search_knowledge', 'gmail_list'], 'both lookups were dispatched before either was awaited');
  assert.equal(reply['status'], 'answered');
  assert.deepEqual(reply['sources'], { knowledge: 'ok', mail: 'ok' }, 'one combined reply with per-source status');
  const findings = reply['findings'] as { source: string; text: string }[];
  assert.deepEqual(findings.map(finding => finding.source).sort(), ['knowledge', 'mail']);
});

test('the routed receipt names the sources, the count and per-source ms, never a query', async () => {
  let clock = 0;
  const h = harness({ now: () => { clock += 250; return clock; } });
  await runResearch(h.deps, {
    action: 'start', question: 'what did we decide about the release',
    lookups: [{ source: 'knowledge', query: 'release 3k decision' }, { source: 'company', query: 'who reports to whom' }],
  }, new AbortController().signal);
  assert.equal(h.routed.length, 1);
  const receipt = h.routed[0]!;
  assert.deepEqual(receipt.sources, ['knowledge', 'company']);
  assert.equal(receipt.lookups, 2);
  assert.equal(receipt.ms.length, 2);
  assert.ok(receipt.ms.every(ms => Number.isInteger(ms) && ms >= 0));
  assert.deepEqual(receipt.outcomes, ['ok', 'ok']);
  assert.doesNotMatch(JSON.stringify(receipt), /release 3k decision|reports to whom/, 'no query text leaves in the receipt');
  assert.deepEqual(safeEvent(receipt), receipt, 'the host log admits the routed receipt unchanged');
});

test('a routed lookup that fails is isolated and the other layers still answer', async () => {
  const h = harness({
    execute: async (subs: readonly IntentSubCall[]) => {
      if (subs[0]!.name === 'gmail_list') throw Error('mail_down');
      return subs.map(call => sub(call.name, `${call.name} evidence`, true, call.key));
    },
  });
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'what did he send me about the release',
    lookups: [{ source: 'knowledge', query: 'release' }, { source: 'mail', query: 'release' }],
  }, new AbortController().signal);
  assert.deepEqual(reply['sources'], { knowledge: 'ok', mail: 'failed' });
  const findings = reply['findings'] as { source: string }[];
  assert.deepEqual(findings.map(finding => finding.source), ['knowledge'], 'the failed source contributes no finding');
  assert.match(String(reply['note']), /could not reach mail/);
  assert.equal(reply['status'], 'answered', 'one good layer answers the call');
});

test('a source the session did not configure is reported unavailable, never dispatched', async () => {
  const h = harness({ configured: ['knowledge'] });
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'who is on my team',
    lookups: [{ source: 'company', query: 'team structure' }, { source: 'chat', query: 'team' }],
  }, new AbortController().signal);
  assert.deepEqual(h.executed, [], 'nothing is dispatched for an unconfigured source');
  assert.deepEqual(reply['sources'], { company: 'unavailable', chat: 'unavailable' });
  assert.deepEqual(reply['findings'], []);
  assert.equal(reply['status'], 'partial');
});

test('her own memory answers a memory lookup, and is reported unavailable without a reader', async () => {
  const h = harness({
    memory: query => ({
      lines: [`2026-10-14 entry: he asked me to remember the dentist on Friday for ${query}`],
      text: 'ignored',
      total: 1,
    }),
  });
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'what did he ask me to remember',
    lookups: [{ source: 'memory', query: 'dentist' }],
  }, new AbortController().signal);
  assert.deepEqual(reply['sources'], { memory: 'ok' });
  const findings = reply['findings'] as { source: string; text: string }[];
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.source, 'memory');
  assert.match(findings[0]!.text, /dentist on Friday/);

  const bare = harness();
  const empty = await runResearch(bare.deps, {
    action: 'start', question: 'what did he ask me to remember',
    lookups: [{ source: 'memory', query: 'dentist' }],
  }, new AbortController().signal);
  assert.deepEqual(empty['sources'], { memory: 'unavailable' });
  assert.deepEqual(bare.executed, [], 'memory never becomes a connector read');
});

test('an empty memory reader reports empty rather than failed', async () => {
  const h = harness({ memory: () => ({ lines: [], text: '', total: 0 }) });
  const reply = await runResearch(h.deps, {
    action: 'start', question: 'what did he ask me to remember',
    lookups: [{ source: 'memory', query: 'dentist' }],
  }, new AbortController().signal);
  assert.deepEqual(reply['sources'], { memory: 'empty' });
});

test('duplicates collapse and a call carries at most four lookups', () => {
  const lookups = normalizeLookups([
    { source: 'knowledge', query: 'release' },
    { source: 'Knowledge', query: ' RELEASE ' },
    { source: 'mail', query: 'release' },
    { source: 'chat', query: 'release' },
    { source: 'company', query: 'release' },
    { source: 'memory', query: 'release' },
  ]);
  assert.equal(lookups.length, MAX_LOOKUPS);
  assert.deepEqual(lookups.map(lookup => lookup.source), ['knowledge', 'mail', 'chat', 'company']);
  assert.deepEqual(normalizeLookups([{ source: 'nonsense', query: 'x' }, { source: 'mail', query: '  ' }]), []);
  assert.deepEqual(normalizeLookups(undefined), []);
  assert.equal(MAX_LOOKUPS, 4);
});

test('a lookup query is capped like a selector query', () => {
  const [lookup] = normalizeLookups([{ source: 'mail', query: 'x'.repeat(RESEARCH.queryLimitChars + 40) }]);
  assert.equal(lookup!.query.length, RESEARCH.queryLimitChars);
});

test('calendar lookups carry a day or a named window', () => {
  assert.equal(calendarWindowOf('tomorrow'), 'tomorrow');
  assert.equal(calendarWindowOf('week'), 'week');
  assert.equal(calendarWindowOf('2026-10-17'), '2026-10-17');
  assert.equal(calendarWindowOf('meetings on 2026-10-17'), '2026-10-17');
  assert.equal(calendarWindowOf('anything about the release'), 'today');
});

test('the declared lookups key is valid on start only and matches its validator', () => {
  assert.equal(validateResearch({ action: 'start', question: 'q' }), true, 'unrouted start stays valid');
  assert.equal(validateResearch({ action: 'start', question: 'q', lookups: [{ source: 'memory', query: 'x' }] }), true);
  assert.equal(validateResearch({ action: 'start', question: 'q', lookups: [] }), true);
  assert.equal(validateResearch({ action: 'start', question: 'q', lookups: [{ source: 'mail' }] }), false);
  assert.equal(validateResearch({ action: 'start', question: 'q', lookups: [{ source: 'nonsense', query: 'x' }] }), false);
  assert.equal(validateResearch({ action: 'start', question: 'q', lookups: [{ source: 'mail', query: 'x', extra: 1 }] }), false);
  assert.equal(validateResearch({ action: 'continue', researchId: 'r', lookups: [{ source: 'mail', query: 'x' }] }), false,
    'lookups belong to a start');
  assert.equal(validateResearch({ action: 'start', question: 'q', lookups: 'mail' }), false);
});

test('both provider declarations carry lookups, and the Gemini dialect flattens it', () => {
  const declaration = researchDeclaration();
  const properties = declaration.parameters['properties'] as Record<string, { type?: unknown; items?: { properties?: Record<string, { enum?: unknown[] }> } }>;
  const lookups = properties['lookups']!;
  assert.equal(lookups.type, 'array', 'the OpenAI JSON schema keeps the array of objects');
  assert.deepEqual(lookups.items!.properties!['source']!.enum, [...LOOKUP_SOURCES]);
  assert.match(String(declaration.parameters['properties'] && (lookups as unknown as { description: string }).description),
    /memory: .*knowledge: .*company: .*calendar/m, 'the description names the layers one line each');
  const registry: ToolDefinition[] = [{
    name: declaration.name, description: declaration.description, parameters: declaration.parameters, guidance: declaration.guidance,
    effect: 'read', accountId: 'fixture', resourceId: 'fixture', validate: declaration.validate, execute: async () => ({ status: 'failed' as const }),
  }];
  const { declarations } = declarationsFor(registry);
  const gemini = declarations[0]!.parameters['properties'] as Record<string, { type?: unknown; description?: string }>;
  assert.equal(gemini['lookups']!.type, 'STRING', 'the flattened dialect presents lookups as one string');
  assert.match(String(gemini['lookups']!.description), /Original schema: .*"source"/, 'the original schema travels in the description');
});

test('an unrouted start keeps the selector path and never touches memory', async () => {
  const h = harness({ memory: () => { throw Error('memory must not be read'); } });
  await runResearch(h.deps, { action: 'start', question: 'where does the project stand', lookups: [] }, new AbortController().signal);
  assert.equal(h.selectorCalls(), 1, 'no lookups means today\'s selector');
  assert.deepEqual(h.executed, [], 'a selector that answers no action reads nothing');
  assert.deepEqual(h.routed, [], 'no routed receipt without lookups');
});
