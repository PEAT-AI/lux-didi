import test from 'node:test';
import assert from 'node:assert/strict';
import { WarmContextCache, assembleContext, chooseStartContext, collectSections, warmContextMaxAgeMs } from '../live/warm-context.js';

const sections = {
  persona: 'Naya is the owner\'s assistant.',
  memory: ['Prefers morning calls', 'Lives in Pune'],
  summary: 'Yesterday: release planning.',
  calendar: '10:00 standup, 15:00 review.',
};
/** What a source collection produces: the four slots, with no selection provenance. */
const collected = { ...sections, summaryIds: [] as readonly string[], summaryOmitted: [] as readonly { id: string; reason: 'budget' | 'stale' }[] };
/** What the owner adopts after building a real summary section. */
const withProvenance = { ...sections, summaryIds: ['summary-17'], summaryOmitted: [{ id: 'summary-03', reason: 'budget' as const }] };

/** A local, model-free source set: every getter is a counter, never a socket. */
function sources() {
  const calls = { persona: 0, memory: 0, summary: 0, calendar: 0 };
  return {
    calls,
    value: {
      persona: () => { calls.persona += 1; return sections.persona; },
      memory: () => { calls.memory += 1; return sections.memory; },
      summary: () => { calls.summary += 1; return sections.summary; },
      calendar: () => { calls.calendar += 1; return sections.calendar; },
    },
  };
}

test('the assembly carries persona, memory, the recent summary and the calendar digest in priority order', () => {
  assert.equal(assembleContext(collected, 4_000),
    'Persona: Naya is the owner\'s assistant.\n\n'
    + 'Remembered:\n- Prefers morning calls\n- Lives in Pune\n\n'
    + 'Recent conversation: Yesterday: release planning.\n\n'
    + 'Today: 10:00 standup, 15:00 review.');
});

test('a missing connector simply leaves its section out', () => {
  const text = assembleContext({ ...collected, calendar: undefined, summary: undefined }, 4_000);
  assert.doesNotMatch(text, /Today:/);
  assert.doesNotMatch(text, /Recent conversation:/);
  assert.match(text, /^Persona: /);
});

test('the instruction budget bounds the assembly and truncates in priority order', () => {
  const full = assembleContext(collected, 4_000);
  const bounded = assembleContext(collected, 30);
  assert.ok(bounded.length <= 30, 'the bounded assembly never exceeds the budget, got ' + bounded.length);
  assert.match(bounded, /^Persona: /);
  assert.doesNotMatch(bounded, /Today:/, 'the lowest priority section is what a tight budget drops');
  assert.ok(full.length > bounded.length, 'a larger budget keeps more');
});

test('every source is read exactly once per collection', () => {
  const local = sources();
  const read = collectSections(local.value);
  assert.deepEqual(local.calls, { persona: 1, memory: 1, summary: 1, calendar: 1 });
  assert.deepEqual(read, collected);
});

test('a warm start keeps the summary provenance it was assembled with, never empties', () => {
  let now = 900_000;
  const cache = new WarmContextCache({ budget: 4_000, now: () => now });
  cache.adopt(withProvenance);
  const start = chooseStartContext(cache.take(), () => {
    throw new Error('a warm start must not assemble again');
  });
  assert.deepEqual(start.sections.summaryIds, ['summary-17'], 'the selected summary ids travel with the section');
  assert.deepEqual(start.sections.summaryOmitted, [{ id: 'summary-03', reason: 'budget' }]);
});

test('start path A: an assembly inside ten minutes is used as it stands, with no second read', () => {
  const local = sources();
  let now = 1_000_000;
  const cache = new WarmContextCache({ sources: local.value, budget: 4_000, now: () => now });
  cache.refresh();
  assert.deepEqual(local.calls, { persona: 1, memory: 1, summary: 1, calendar: 1 });

  now += warmContextMaxAgeMs - 1;
  const start = chooseStartContext(cache.take(), () => {
    throw new Error('a warm start must not assemble again');
  });
  assert.equal(start.warm, true);
  assert.deepEqual(start.sections, collected);
  assert.deepEqual(local.calls, { persona: 1, memory: 1, summary: 1, calendar: 1 }, 'the store is never read twice');
});

test('start path B: a stale or absent assembly is assembled now, and adopted for the next start', () => {
  const local = sources();
  let now = 2_000_000;
  const cache = new WarmContextCache({ sources: local.value, budget: 4_000, now: () => now });

  // Absent: the caller assembles, then adopts, so nothing is assembled twice.
  const absent = chooseStartContext(cache.take(), () => collectSections(local.value));
  assert.equal(absent.warm, false);
  assert.deepEqual(absent.sections, collected);
  assert.deepEqual(local.calls, { persona: 1, memory: 1, summary: 1, calendar: 1 });
  cache.adopt(absent.sections);
  assert.equal(cache.assemblies, 1);

  // The next start inside the window reuses what was adopted.
  now += warmContextMaxAgeMs - 1;
  const reused = chooseStartContext(cache.take(), () => {
    throw new Error('a warm start must not assemble again');
  });
  assert.equal(reused.warm, true);

  // Stale: ten minutes later the caller assembles again.
  now += 1;
  assert.equal(cache.take(), undefined, 'a ten minute old assembly is not offered');
  const stale = chooseStartContext(cache.take(), () => collectSections(local.value));
  assert.equal(stale.warm, false);
  assert.deepEqual(local.calls, { persona: 2, memory: 2, summary: 2, calendar: 2 }, 'exactly one read on the stale path');
});

test('assembly happens at most once every ten minutes and on demand after a wake', () => {
  const local = sources();
  let now = 3_000_000;
  const cache = new WarmContextCache({ sources: local.value, budget: 4_000, now: () => now });
  assert.equal(cache.take(), undefined, 'nothing is pre-assembled before the first refresh');

  const first = cache.refresh();
  assert.ok(first !== undefined && first.assembledAt === now, 'the first refresh assembles');
  assert.equal(cache.assemblies, 1);

  now += warmContextMaxAgeMs - 1;
  assert.equal(cache.refresh(), first, 'a refresh inside the window returns the same assembly');
  assert.equal(cache.assemblies, 1, 'no re-assembly inside ten minutes');
  assert.equal(local.calls.persona, 1, 'the sources were read once');

  now += 1;
  cache.refresh();
  assert.equal(cache.assemblies, 2, 'ten minutes of age re-assembles');
  assert.equal(local.calls.persona, 2);

  cache.refresh(true);
  assert.equal(cache.assemblies, 3, 'a wake forces a fresh assembly even inside the window');
});

test('a session may only start from a warm assembly younger than ten minutes', () => {
  let now = 5_000_000;
  const cache = new WarmContextCache({ sources: sources().value, budget: 4_000, now: () => now });
  cache.refresh();
  assert.equal(cache.ageMs, 0);
  assert.deepEqual(cache.take()?.sections, collected);

  now += warmContextMaxAgeMs - 1;
  assert.ok(cache.take() !== undefined, 'one millisecond short of ten minutes is still warm');
  now += 1;
  assert.equal(cache.take(), undefined, 'a ten minute old assembly is never used, it is re-assembled instead');
  assert.equal(cache.ageMs, warmContextMaxAgeMs);
});

test('an empty source set assembles nothing rather than an empty block', () => {
  const cache = new WarmContextCache({
    sources: { persona: () => undefined, memory: () => [], summary: () => undefined, calendar: () => undefined },
    budget: 4_000,
  });
  assert.equal(cache.refresh(), undefined);
  assert.equal(cache.take(), undefined);
});

// 338: the owner's forced prewarm. The refresh assembles from the prepared sources, keeps the
// digest the owner just read, and the next session start takes those sections instead of asking
// the store a second time.
test('a forced refresh rebuilds the assembly and carries the calendar digest', () => {
  let now = 1_000;
  const local = sources();
  const cache = new WarmContextCache({ budget: 4_000, now: () => now, sources: local.value });
  assert.equal(cache.ageMs, undefined, 'nothing is assembled until a refresh asks for it');
  const forced = cache.refresh(true);
  assert.equal(forced?.sections.calendar, sections.calendar, 'the digest the owner read is in the assembly');
  assert.match(forced?.text ?? '', /Today: 10:00 standup, 15:00 review\./);
  assert.deepEqual(local.calls, { persona: 1, memory: 1, summary: 1, calendar: 1 }, 'one read per source per assembly');
  now += 5;
  cache.refresh(true);
  assert.deepEqual(local.calls, { persona: 2, memory: 2, summary: 2, calendar: 2 }, 'a forced refresh assembles again');
  assert.equal(cache.ageMs, 0, 'the receipt ages run from the forced assembly');
});

test('a start after a forced refresh uses the refreshed sections and reads no source again', () => {
  let now = 1_000;
  const local = sources();
  const cache = new WarmContextCache({ budget: 4_000, now: () => now, sources: local.value });
  cache.refresh(true);
  now += 30_000;
  let assembled = 0;
  const start = chooseStartContext(cache.take(), () => { assembled += 1; return collected; });
  assert.equal(start.warm, true, 'the forced assembly is what the next start takes');
  assert.equal(assembled, 0, 'the store is not read a second time');
  assert.equal(start.sections.calendar, sections.calendar);
  assert.equal(local.calls.summary, 1, 'the summary source ran once, at the prewarm');
});
