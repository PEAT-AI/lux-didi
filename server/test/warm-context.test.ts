import test from 'node:test';
import assert from 'node:assert/strict';
import { WarmContextCache, assembleContext, warmContextMaxAgeMs } from '../live/warm-context.js';

/** A local, model-free source set: every getter is a counter, never a socket. */
function sources() {
  const calls = { persona: 0, memory: 0, summary: 0, calendar: 0 };
  return {
    calls,
    value: {
      persona: () => { calls.persona += 1; return 'Naya is the owner\'s assistant.'; },
      memory: () => { calls.memory += 1; return ['Prefers morning calls', 'Lives in Pune']; },
      summary: () => { calls.summary += 1; return 'Yesterday: release planning.'; },
      calendar: () => { calls.calendar += 1; return '10:00 standup, 15:00 review.'; },
    },
  };
}

test('the assembly carries persona, memory, the recent summary and the calendar digest in priority order', () => {
  const text = assembleContext(sources().value, 4_000);
  assert.equal(text,
    'Persona: Naya is the owner\'s assistant.\n\n'
    + 'Remembered:\n- Prefers morning calls\n- Lives in Pune\n\n'
    + 'Recent conversation: Yesterday: release planning.\n\n'
    + 'Today: 10:00 standup, 15:00 review.');
});

test('a missing connector simply leaves its section out', () => {
  const text = assembleContext({ ...sources().value, calendar: () => undefined, summary: () => undefined }, 4_000);
  assert.doesNotMatch(text, /Today:/);
  assert.doesNotMatch(text, /Recent conversation:/);
  assert.match(text, /^Persona: /);
});

test('the instruction budget bounds the assembly and truncates in priority order', () => {
  const full = assembleContext(sources().value, 4_000);
  const bounded = assembleContext(sources().value, 30);
  assert.ok(bounded.length <= 30, 'the bounded assembly never exceeds the budget, got ' + bounded.length);
  assert.match(bounded, /^Persona: /);
  assert.doesNotMatch(bounded, /Today:/, 'the lowest priority section is what a tight budget drops');
  assert.ok(full.length > bounded.length, 'a larger budget keeps more');
});

test('assembly happens at most once every ten minutes and on demand after a wake', () => {
  const local = sources();
  let now = 1_000_000;
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
  assert.deepEqual(cache.take(), cache.refresh(), 'a fresh assembly is what a start uses');

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
