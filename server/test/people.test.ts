// W15: the owner's people roster. Every identity here is synthetic; no real person's name, address or
// handle appears in this file. The roster file is read beside the active owner profile, validated
// strictly, rendered into one instructions section and resolved by one host-owned pure function.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PEOPLE_CHAR_LIMIT, loadPeople, parsePeople, renderPeople, resolveSpoken, splitSpoken, installPeople,
  peopleSnapshot, peopleSection, lookupPeople, personByEmail, ambiguityQuestion, PEOPLE_LOOKUP_DECLARATION,
  peopleLookupResult, validatePeopleLookup, type PeopleSnapshot,
} from '../people/index.js';
import { LIVE_INSTRUCTION_HARD_LIMIT, composeLiveSessionInstruction, ownerProfileSections } from '../prompt/index.js';
import { validateOwnerProfile } from '../prompt/index.js';
import { safeEvent } from '../host/log.js';
import { compileMailQuery } from '../tools/research.js';
import { attendeeName } from '../tools/live-shape.js';
import { groupHoldsAll } from '../connectors/mattermost.js';

/** One roster of synthetic people that carries the failure of the call: two Jitendras, and a Sandy. */
export function fixturePeople(): Record<string, unknown> {
  return {
    version: 1,
    people: [
      { id: 'ravi-example', name: 'Ravi Example', aliases: ['Ravi', 'Robby'], role: 'head of sales India', circle: 'plantix', project: '', tier: 1,
        email: ['ravi.example@example.test'], mattermost: 'ravi.e', note: '' },
      { id: 'sandeep-example', name: 'Sandeep Example', aliases: ['Sandy'], role: 'field agronomist', circle: 'plantix', project: '', tier: 1,
        email: ['sandeep.example@example.test'], mattermost: 'sandeep.e', note: 'Punjab' },
      { id: 'jitendra-example', name: 'Jitendra Example', aliases: ['Jitendra'], role: 'data engineer', circle: 'plantix', project: '', tier: 2,
        email: ['jitendra.example@example.test'], mattermost: 'jitendra.e', note: '' },
      { id: 'jitendra-second', name: 'Jitendra Second', aliases: ['Jitendra'], role: 'sales', circle: 'plantix', project: '', tier: 1,
        email: ['jitendra.second@example.test'], mattermost: 'jitendra.s', note: '' },
      { id: 'bianca-example', name: 'Bianca Example', aliases: ['Bibi'], role: 'friend', circle: 'friend', project: 'Dogtation', tier: 1,
        email: ['bianca@example.test'], mattermost: '', note: '' },
    ],
  };
}

function install(): PeopleSnapshot {
  const snapshot = parsePeople(fixturePeople());
  installPeople(snapshot);
  return snapshot;
}

test('people: the schema accepts the documented shape and freezes it', () => {
  const snapshot = install();
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.people.length, 5);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.people[0]!.aliases));
  installPeople(null);
});

test('people: the schema rejects a malformed file and never yields a partial roster', () => {
  const bad: Record<string, unknown>[] = [
    { version: 2, people: [] },
    { version: 1, people: [], extra: true },
    { version: 1, people: 'none' },
    { version: 1, people: [{ id: 'x', name: 'X', aliases: [], role: 'r', circle: 'nowhere', tier: 1, email: [], mattermost: '' }] },
    { version: 1, people: [{ id: 'x', name: 'X', aliases: [], role: 'r', circle: 'plantix', tier: 3, email: [], mattermost: '' }] },
    { version: 1, people: [{ id: 'x', name: 'X', aliases: [], role: 'r', circle: 'plantix', tier: 1, email: [], mattermost: '', colour: 'red' }] },
    { version: 1, people: [{ id: 'x', name: 'X', aliases: [], role: 'r', circle: 'plantix', tier: 1, email: ['not-an-address'], mattermost: '' }] },
    { version: 1, people: [
      { id: 'x', name: 'X', aliases: [], role: 'r', circle: 'plantix', tier: 1, email: [], mattermost: '' },
      { id: 'x', name: 'Y', aliases: [], role: 'r', circle: 'plantix', tier: 1, email: [], mattermost: '' },
    ] },
    { version: 1, people: [{ id: 'x', name: 'X', aliases: [], role: 'r', circle: 'plantix', tier: 1, email: [], mattermost: '', note: 'x'.repeat(81) }] },
  ];
  for (const raw of bad) assert.throws(() => parsePeople(raw), /people/i, JSON.stringify(raw).slice(0, 60));
  assert.equal(peopleSnapshot(), null);
});

test('people: rendering keeps file order, tier shapes and drops tier 2 lines from the end at the ceiling', () => {
  const snapshot = install();
  const whole = renderPeople(snapshot, 10_000);
  const lines = whole.text.split('\n');
  assert.equal(whole.droppedTier2, 0);
  assert.equal(lines[1], 'Ravi Example (Ravi, Robby) - head of sales India - plantix - ravi.example - @ravi.e');
  assert.equal(lines[3], 'Jitendra Example - data engineer');
  assert.equal(lines[5], 'Bianca Example (Bibi) - friend - friend/Dogtation - bianca');
  const tight = renderPeople(snapshot, lines.slice(0, 4).join('\n').length + 40);
  assert.equal(tight.droppedTier2, 1);
  assert.ok(!tight.text.includes('Jitendra Example - data engineer'));
  assert.ok(tight.text.length <= lines.slice(0, 4).join('\n').length + 40);
  installPeople(null);
});

test('people: the resolver binds a curated alias, reports the shared alias ambiguous and lets a full name win', () => {
  const snapshot = install();
  const sandy = resolveSpoken(snapshot, 'Sandy');
  assert.equal(sandy.length, 1);
  assert.equal(sandy[0]!.kind, 'resolved');
  assert.equal(sandy[0]!.kind === 'resolved' ? sandy[0]!.person.name : '', 'Sandeep Example');
  const both = resolveSpoken(snapshot, 'Jitendra and Sandy');
  assert.equal(both.length, 2);
  assert.equal(both[0]!.kind, 'ambiguous');
  const candidates = both[0]!.kind === 'ambiguous' ? both[0]!.people.map(person => person.name) : [];
  assert.deepEqual(candidates, ['Jitendra Example', 'Jitendra Second']);
  assert.equal(both[1]!.kind === 'resolved' ? both[1]!.person.name : '', 'Sandeep Example');
  const exact = resolveSpoken(snapshot, 'Jitendra Second');
  assert.equal(exact[0]!.kind === 'resolved' ? exact[0]!.person.name : '', 'Jitendra Second');
  assert.equal(resolveSpoken(snapshot, 'Wasim')[0]!.kind, 'unknown');
  assert.equal(resolveSpoken(snapshot, 'ravi.e')[0]!.kind, 'resolved');
  assert.equal(resolveSpoken(snapshot, 'RAVI')[0]!.kind, 'resolved');
  assert.deepEqual(splitSpoken('Jitendra and Sandy'), ['Jitendra', 'Sandy']);
  installPeople(null);
});

test('people: an ambiguous spoken name asks with the roster role, never a connector list', () => {
  install();
  assert.equal(ambiguityQuestion('Jitendra', parsePeople(fixturePeople()).people.filter(person => person.aliases.includes('Jitendra'))),
    'Jitendra Example in data engineer or Jitendra Second in sales?');
  installPeople(null);
});

test('people: lookup returns roster entries without any connector, and email maps back to a person', () => {
  const snapshot = install();
  assert.deepEqual(lookupPeople(snapshot, 'Sandy').map(person => person.name), ['Sandeep Example']);
  assert.equal(personByEmail(snapshot, 'SANDEEP.example@example.test')?.name, 'Sandeep Example');
  assert.equal(personByEmail(snapshot, 'nobody@example.test'), undefined);
  const result = peopleLookupResult({ name: 'Sandy' });
  assert.equal(result.people[0]?.name, 'Sandeep Example');
  assert.equal(PEOPLE_LOOKUP_DECLARATION.name, 'people_lookup');
  assert.deepEqual(PEOPLE_LOOKUP_DECLARATION.parameters.required, ['name']);
  assert.equal(validatePeopleLookup({ name: 'Sandy' }), true);
  assert.equal(validatePeopleLookup({ name: '' }), false);
  assert.equal(validatePeopleLookup({ name: 'Sandy', extra: 1 }), false);
  installPeople(null);
});

test('people: the loader reads people.json beside the owner profile and fails loud on a bad file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-people-'));
  try {
    const profile = join(dir, 'naya-local.json');
    writeFileSync(profile, '{}');
    assert.equal(loadPeople(profile).status, 'absent');
    writeFileSync(join(dir, 'people.json'), JSON.stringify(fixturePeople()));
    chmodSync(join(dir, 'people.json'), 0o600);
    const loaded = loadPeople(profile);
    assert.equal(loaded.status, 'loaded');
    assert.equal(loaded.status === 'loaded' ? loaded.snapshot.people.length : 0, 5);
    writeFileSync(join(dir, 'people.json'), '{"version":1,"people":[{"id":"x"}]}');
    chmodSync(join(dir, 'people.json'), 0o600);
    const broken = loadPeople(profile);
    assert.equal(broken.status, 'invalid');
    assert.equal(broken.status === 'invalid' ? typeof broken.reason : '', 'string');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('people: a 130 person roster renders under its ceiling and the whole instruction stays under the hard limit', () => {
  const people = [] as Record<string, unknown>[];
  for (let n = 0; n < 130; n += 1) {
    people.push({
      id: `person-${n}`, name: `Person Number${n}`, aliases: [`Nick${n}`], role: 'colleague in the field team',
      circle: n % 7 === 0 ? 'friend' : 'plantix', project: '', tier: n < 60 ? 1 : 2,
      email: [`person.${n}@example.test`], mattermost: `person.${n}`, note: '',
    });
  }
  const snapshot = parsePeople({ version: 1, people });
  const rendered = renderPeople(snapshot, PEOPLE_CHAR_LIMIT);
  assert.ok(rendered.text.length <= PEOPLE_CHAR_LIMIT, `${rendered.text.length} over ${PEOPLE_CHAR_LIMIT}`);
  installPeople(snapshot);
  // Today's measured section sizes (host.log live_instruction_sizes, 2026-10-26): earlier-conversations
  // 8,957; owner-style 5,745; owner-lore 10,289; the rest about 3,900 below the base and tools text.
  const profile = validateOwnerProfile({
    schemaVersion: 1, kind: 'profile', ownerId: 'owner-1', profileVersion: 'test',
    displayName: 'Owner Example',
    style: { text: `# Style\n${'s'.repeat(5745)}`, dataClass: 'ordinary' },
    lore: { text: `# Lore\n${'l'.repeat(10289)}`, dataClass: 'ordinary' },
  }, 'owner-1');
  assert.equal(ownerProfileSections(profile).length, 2);
  const composed = composeLiveSessionInstruction({
    text: '# BASE\n' + 'b'.repeat(5086), tools: ['research', 'mattermost_chat'], records: [], trustedChars: LIVE_INSTRUCTION_HARD_LIMIT,
    ownerProfile: profile, earlierConversations: 'x'.repeat(8957), accentSelection: 'indian-strong',
  });
  assert.ok(composed.sections.some(section => section.id === 'people'), composed.sections.map(section => section.id).join(','));
  assert.ok(composed.text.length < LIVE_INSTRUCTION_HARD_LIMIT, `${composed.text.length} over the hard limit`);
  assert.ok(peopleSection() !== undefined);
  installPeople(null);
});

test('people: the mail query carries the resolved address, never the spoken text', () => {
  install();
  const query = compileMailQuery('what did Sandy email me about the invoice', undefined, Date.parse('2026-10-26T08:00:00Z'));
  assert.ok(query.includes('from:sandeep.example@example.test'), query);
  assert.ok(query.includes('to:sandeep.example@example.test'), query);
  installPeople(null);
  // An unknown spoken name still falls through to the connector's own text path.
  assert.ok(compileMailQuery('what did Wasim email me about the invoice', undefined, Date.parse('2026-10-26T08:00:00Z')).includes('from:wasim'));
});

test('people: a calendar attendee is named from the roster email', () => {
  install();
  assert.equal(attendeeName({ email: 'ravi.example@example.test', displayName: 'ravi.example' }), 'Ravi Example');
  assert.equal(attendeeName({ email: 'stranger@example.test', displayName: 'A Stranger' }), 'A Stranger');
  installPeople(null);
});

test('people: a group conversation whose members are a superset of the resolved people is found', () => {
  const channel = { id: 'g1', type: 'G', members: ['owner.example', 'ravi.e', 'sandeep.e', 'extra.e'] };
  assert.equal(groupHoldsAll(channel, ['ravi.e', 'sandeep.e']), true);
  assert.equal(groupHoldsAll(channel, ['ravi.e', 'missing.e']), false);
  assert.equal(groupHoldsAll({ id: 'g2', type: 'G', displayName: 'ravi.e, sandeep.e, extra.e' }, ['ravi.e']), true);
});

test('people: ambiguous is true only when a spoken part is ambiguous', () => {
  install();
  // A fully resolved pair is not an ambiguity, even though it names two people.
  const pair = peopleLookupResult({ name: 'Sandy and Ravi' });
  assert.equal(pair.ambiguous, false);
  assert.deepEqual(pair.people.map(person => person.name), ['Sandeep Example', 'Ravi Example']);
  // One part that two roster people share is the ambiguity, and its candidates come along.
  const shared = peopleLookupResult({ name: 'Jitendra and Sandy' });
  assert.equal(shared.ambiguous, true);
  assert.deepEqual(shared.people.map(person => person.name), ['Jitendra Example', 'Jitendra Second', 'Sandeep Example']);
  assert.equal(peopleLookupResult({ name: 'Wasim' }).ambiguous, false);
  installPeople(null);
});

test('people: the three closed events survive the host log allowlist and refuse foreign keys', () => {
  assert.deepEqual(safeEvent({ event: 'people_loaded', count: 5, bytes: 900, chars: 400 }),
    { event: 'people_loaded', count: 5, bytes: 900, chars: 400 });
  assert.equal(safeEvent({ event: 'people_loaded', count: 5, bytes: 900, chars: 400, name: 'Ravi Example' }), undefined);
  assert.equal(safeEvent({ event: 'people_loaded', count: -1, bytes: 900, chars: 400 }), undefined);
  assert.deepEqual(safeEvent({ event: 'people_invalid', reason: 'duplicate_id' }), { event: 'people_invalid', reason: 'duplicate_id' });
  assert.equal(safeEvent({ event: 'people_invalid', reason: 'Ravi Example' }), undefined);
  assert.deepEqual(safeEvent({ event: 'people_trimmed', dropped: 3, tier2: 3 }), { event: 'people_trimmed', dropped: 3, tier2: 3 });
  assert.equal(safeEvent({ event: 'people_trimmed', dropped: -1, tier2: 0 }), undefined);
  assert.equal(safeEvent({ event: 'people_trimmed', dropped: 3 }), undefined);
});

test('people: the live tool registry ships people_lookup as a read tool', () => {
  // The registration lives in server/tools/index.ts, whose liveDefinitions needs a full run row; the
  // shipped artifact is read instead, so a definition dropped from the registry or moved off the read
  // effect turns this test red.
  const built = readFileSync(fileURLToPath(new URL('../tools/index.js', import.meta.url)), 'utf8');
  assert.match(built, /\.\.\.PEOPLE_LOOKUP_DECLARATION, effect: 'read'/u);
  assert.match(built, /peopleLookupResult\(args\)/u);
});

test('people: an over-ceiling roster file reports the tier 2 lines it dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-people-trim-'));
  try {
    const profile = join(dir, 'naya-local.json');
    writeFileSync(profile, '{}');
    const people = [] as Record<string, unknown>[];
    for (let n = 0; n < 200; n += 1) {
      people.push({ id: `person-${n}`, name: `Person Number${n} Longfamily`, aliases: [], role: 'colleague in the field team for the region',
        circle: 'plantix', project: '', tier: 2, email: [], mattermost: '' });
    }
    writeFileSync(join(dir, 'people.json'), JSON.stringify({ version: 1, people }));
    chmodSync(join(dir, 'people.json'), 0o600);
    const loaded = loadPeople(profile);
    assert.equal(loaded.status, 'loaded');
    if (loaded.status !== 'loaded') return;
    assert.ok(loaded.rendered.dropped > 0, 'the ceiling must drop lines');
    assert.equal(loaded.rendered.droppedTier2, loaded.rendered.dropped);
    assert.ok(loaded.rendered.text.length <= PEOPLE_CHAR_LIMIT);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('people: a full lore plus a 130 person roster still composes under the hard limit', () => {
  const people = [] as Record<string, unknown>[];
  for (let n = 0; n < 130; n += 1) {
    people.push({
      id: `person-${n}`, name: `Person Number${n}`, aliases: [`Nick${n}`], role: 'colleague in the field team',
      circle: 'plantix', project: '', tier: 1, email: [`person.${n}@example.test`], mattermost: `person.${n}`, note: '',
    });
  }
  const snapshot = parsePeople({ version: 1, people });
  const events: { event: string; dropped?: number; tier2?: number }[] = [];
  installPeople(snapshot, event => { events.push(event as { event: string }); });
  const profile = validateOwnerProfile({
    schemaVersion: 1, kind: 'profile', ownerId: 'owner-1', profileVersion: 'test',
    displayName: 'Owner Example',
    style: { text: '# Style\nstyle', dataClass: 'ordinary' },
    lore: { text: `# Lore\n${'l'.repeat(14_000)}`, dataClass: 'ordinary' },
  }, 'owner-1');
  const composed = composeLiveSessionInstruction({
    text: `# BASE\n${'b'.repeat(20_000)}`, tools: ['research', 'mattermost_chat'], records: [], trustedChars: LIVE_INSTRUCTION_HARD_LIMIT,
    ownerProfile: profile, earlierConversations: 'x'.repeat(8_957), accentSelection: 'indian-strong',
  });
  assert.ok(composed.text.length < LIVE_INSTRUCTION_HARD_LIMIT, `${composed.text.length} over the hard limit`);
  const section = composed.sections.find(entry => entry.id === 'people');
  assert.ok(section !== undefined, 'the people section must still be present');
  assert.ok(section.chars <= PEOPLE_CHAR_LIMIT);
  const trimmed = events.filter(event => event.event === 'people_trimmed');
  assert.equal(trimmed.length, 1, JSON.stringify(events));
  assert.ok((trimmed[0]!.dropped ?? 0) > 0);
  installPeople(null);
});
