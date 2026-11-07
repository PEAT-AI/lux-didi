import { compileMemoryBlock, MEMORY_BACKGROUND } from '../dist/prompt/memory-block.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as prompt from '../dist/prompt/index.js';
import { EVIDENCE_SOURCES_GUIDE } from '../dist/prompt/source-guidance.js';
import { WORKER_INSTRUCTIONS, workerInstructions } from '../dist/tasks/instructions.js';
import { openAiInstructions } from '../dist/adapters/live-voice/openai.js';
import { HISTORY_IDENTITY, HISTORY_PARAMETERS, validateHistory } from '../dist/tools/history.js';

// The live composer must not retain the retired text-chat renderer or a compatibility export.
assert.doesNotMatch(readFileSync(new URL('../dist/prompt/live-persona.js', import.meta.url), 'utf8'),
  /STANDING_MEMORY_TITLE|EARLIER_CONVERSATIONS_TITLE/u, 'retired chat headings do not live in the live composer');
assert.equal(Object.hasOwn(prompt, 'buildEarlierConversationsSection'), false, 'no compatibility export from the prompt barrel');

const approved = JSON.parse(readFileSync(new URL('./fixtures/prompt-final.json', import.meta.url)));
assert.deepEqual(Object.keys(approved).sort(), [
  'NAYA_CHARACTER', 'NAYA_WORK_DELIVERY', 'WORKER_INSTRUCTIONS',
  'Text evidence guide', 'Text tool rule replacement', 'Opening facts',
].sort(), 'the golden fixture names every shipped policy, with no retired backend block');
assert.equal(prompt.NAYA_CHARACTER, approved.NAYA_CHARACTER);
assert.equal(prompt.NAYA_WORK_DELIVERY, approved.NAYA_WORK_DELIVERY);
assert.equal(WORKER_INSTRUCTIONS, approved.WORKER_INSTRUCTIONS);
assert.equal(EVIDENCE_SOURCES_GUIDE, approved['Text evidence guide']);
assert.equal(workerInstructions(), approved.WORKER_INSTRUCTIONS);
assert.ok(WORKER_INSTRUCTIONS.length === 8170);
for (const name of ['NAYA_VOICE_TOOLS', 'NAYA_TOOLS', 'NAYA_BACKEND_PROCEDURE']) {
  assert.equal(prompt[name], undefined, `the retired export stays removed: ${name}`);
}

// The old waiting cue is absent; the new policy owns silence and fresh acknowledgement.
assert.equal(prompt.NAYA_WORK_DELIVERY.split("Say provisional or local recall findings now with limits; don't wait.").length - 1, 1);
assert.equal(prompt.NAYA_WORK_DELIVERY.split('Acknowledge each ask at once, briefly naming points').length - 1, 1);
for (const banned of ['Silence while you look something up is fine.', 'never go silent', 'say one short line',
  'Nothing has been sent or booked', 'Before an actual lookup', 'offer to keep looking', 'You can reach his']) {
  assert.equal((prompt.NAYA_CHARACTER + prompt.NAYA_WORK_DELIVERY + WORKER_INSTRUCTIONS).includes(banned), false,
    `no retired waiting or tool-conduct cue survives: ${banned}`);
}
assert.ok(prompt.PUBLIC_PERSONA.includes('Do not caricature an accent or pretend to be human.'));

const ownerId = 'synthetic-owner';
const preferences = prompt.validatePreferences({ schemaVersion: 1, ownerId, dataClass: 'ordinary',
  language: 'en-US', register: 'plain', humor: 'off', verbosity: 'brief' }, ownerId);
const tool = { ...HISTORY_IDENTITY, description: 'Read canonical retained conversation evidence', parameters: HISTORY_PARAMETERS,
  effect: 'read', validate: validateHistory, execute: async () => { throw Error('not invoked by compiler'); } };
const capabilities = prompt.createCapabilitySnapshot([tool], [{ id: 'memory', state: 'available' }, { id: 'company', state: 'missing' }]);
const input = { ownerId, persona: 'didi', promptVersion: prompt.PROMPT_VERSION, preferences, capabilities, evidence: [],
  history: [{ schemaVersion: 1, ownerId, dataClass: 'ordinary', id: 'turn', role: 'user', text: 'What did we decide sixty days ago?' }],
  budgets: { trustedChars: 20000, contextChars: 12000, historyChars: 12000 } };
const text = prompt.compilePrompt(input);
const empty = prompt.compilePrompt({ ...input, capabilities: prompt.createCapabilitySnapshot([], []) });
assert.ok(text.system.includes(EVIDENCE_SOURCES_GUIDE));
assert.ok(text.system.includes(approved['Text tool rule replacement']));
assert.equal(text.system.includes('# Research procedure'), false);
assert.equal(text.system.includes(prompt.NAYA_WORK_DELIVERY), false);
assert.equal(text.system.includes(WORKER_INSTRUCTIONS), false);
assert.equal(empty.system.includes(EVIDENCE_SOURCES_GUIDE), false);
assert.deepEqual(text.declarations.map(declaration => declaration.name), ['conversation_history']);
assert.ok(text.system.includes('"state":"missing"'));
assert.equal(text.manifest.systemHash, createHash('sha256').update(text.system).digest('hex'));

const compose = delegatedBackend => prompt.composeLiveSessionInstruction({
  text: `${prompt.NAYA_LIVE_BASE}\n\nSynthetic voice anchor`, tools: ['search_mail'], delegatedBackend,
  records: [], trustedChars: 60000,
});
const delegated = compose(true), direct = compose(false);
const none = prompt.composeLiveSessionInstruction({ text: `${prompt.NAYA_LIVE_BASE}\n\nSynthetic voice anchor`,
  tools: [], records: [], trustedChars: 60000 });
for (const [name, composed] of [['delegated', delegated], ['direct', direct], ['no-tools', none]]) {
  assert.equal(composed.text.split(approved.NAYA_WORK_DELIVERY).length - 1, 1, `${name} carries the exact policy once`);
  assert.equal(composed.text.includes(EVIDENCE_SOURCES_GUIDE), false, `${name} has no Text source guide`);
  assert.equal(composed.text.includes(WORKER_INSTRUCTIONS), false, `${name} has no worker-only instructions`);
  assert.equal(composed.text.includes('# Research procedure'), false, `${name} has no retired procedure`);
  assert.equal(composed.sections.find(section => section.id === 'tools')?.chars, approved.NAYA_WORK_DELIVERY.length,
    `${name} reports the intact mandatory section size`);
}
assert.equal(delegated.text, direct.text);
assert.equal(none.text, direct.text, 'tool declarations do not gate the spoken work policy');

const unknownRule = 'Unavailable access or a partial search does not prove that something did not happen. Say what the evidence establishes and what remains unknown.';
const ownerProfile = { schemaVersion: 1, kind: 'profile', ownerId, profileVersion: 'synthetic', displayName: 'Synthetic owner',
  style: { text: '', dataClass: 'ordinary' }, lore: { text: '', dataClass: 'ordinary' } };
const ownerText = prompt.compilePrompt({ ...input, ownerProfile });
const frozen = prompt.composeLiveInstruction({ base: prompt.NAYA_LIVE_BASE, language: 'en' });
const fullLive = openAiInstructions(prompt.composeLiveSessionInstruction({ text: frozen.text, tools: [],
  delegatedBackend: true, records: [], trustedChars: 60000 }).text);
const excluded = JSON.parse(readFileSync(new URL('./fixtures/prompt-character-excluded.json', import.meta.url)));
assert.equal(createHash('sha256').update(prompt.NAYA_CHARACTER).digest('hex'),
  'bad845bb5b3f62d33cdfb0fadee1154919fe07b4c5e56658d5cbb205e318a2e9', 'release character contains only the authorized wording changes');
assert.notEqual(prompt.NAYA_CHARACTER, excluded.NAYA_CHARACTER);
for (const system of [ownerText.system, fullLive, openAiInstructions(none.text)]) {
  assert.equal(system.split(prompt.NAYA_CHARACTER).length - 1, 1);
  assert.equal(system.includes(excluded.NAYA_CHARACTER), false);
  assert.equal(system.includes(unknownRule), false);
}
// M3 (#908): the numeric short default is retired; the whole answer is spoken on a substantive ask.
assert.match(fullLive, /never cut an answer short/);
assert.equal(fullLive.includes('thirty seconds'), false, 'no numeric duration default in the composed live instruction');
assert.equal(fullLive.includes('two spoken numbers'), false, 'no numeric count of spoken numbers in the composed live instruction');

// Structured research headers are retired, not spoken; results retain their facts and qualifications.
assert.equal(fullLive.includes('Every research reply opens with a coverage line'), false);
for (const code of ['partial_timeout', 'truncated_to_budget', 'empty_after_retry', 'not_connected', 'not_configured',
  'grant_missing', 'provider_failed', 'skipped_by_route']) {
  assert.equal(fullLive.includes(code), false, `the voice never recites the retired coverage code ${code}`);
}
for (const rule of ['Reproduce every exact entity verbatim',
  'Everything else is in your own voice',
  'If a result reports a failure, a gap or a partial answer, say that as given, and give what is there rather than only that it is incomplete.',
  'Say something happened only when a result says it happened.']) {
  assert.equal(fullLive.split(rule).length - 1, 1, `result truth and delivery stay explicit: ${rule}`);
}
assert.equal(fullLive.split(approved.NAYA_WORK_DELIVERY).length - 1, 1);
assert.ok(text.system.includes('Missing coverage is not proof that an event did not happen.'));
assert.ok(WORKER_INSTRUCTIONS.includes('One empty search proves nothing; say missing only after widening'));

const styledProfile = { ...ownerProfile, style: { text: 'SYNTHETIC PRESENTATION STYLE', dataClass: 'ordinary' },
  lore: { text: 'SYNTHETIC OWNER LORE', dataClass: 'ordinary' } };
const context = prompt.ownerProfileSections(styledProfile).map(section => section.text).join('\n\n');
const styledWorker = workerInstructions(styledProfile);
assert.equal(styledWorker, `${approved.WORKER_INSTRUCTIONS}\n\n${context}`);
assert.equal(styledWorker.split('SYNTHETIC PRESENTATION STYLE').length - 1, 1);
assert.equal(styledWorker.includes('SYNTHETIC OWNER LORE'), true);

console.log(JSON.stringify({ case: 'compiled_public_prompt_contract', exactApprovedBlocks: 5, textReadOnly: true,
  voiceWorkerSeparated: true, unavailableSourcePreserved: true, noToolsPolicyPresent: true, workerStyleAfterPublic: true,
  textChars: text.system.length, delegatedChars: delegated.text.length, directChars: direct.text.length,
  noToolsChars: none.text.length, workerPublicChars: WORKER_INSTRUCTIONS.length, behaviorObserved: false }));
console.log(JSON.stringify({ case: 'excluded_character_release_subset', excludedCandidateAbsent: true, ownerText: true,
  fullPublicOpenAiLive: true, noToolsVoice: true, naturalResultQualificationsRetained: true, defaultTextExistingRule: true,
  mandatoryDurationConflictOpen: true, behaviorAccepted: false }));

// Typed commentary is data: exact entities survive, phrasing belongs to the voice.
for (const rule of ['Reproduce every exact entity verbatim', 'Everything else is in your own voice',
  'On confirmation add at most one clause or nothing', 'no rounding, dropping or rephrasing',
  'A no_action means answer from this conversation and your own mind', 'A failure means say the cause and next step',
  'Continue exactly where the conversation was']) assert.ok(prompt.NAYA_WORK_DELIVERY.includes(rule), rule);
for (const gone of ['A finished result is already written', 'Say it completely and in order',
  'A large amount may be said rounded', 'She speaks what you write', 'Write what she would say']) {
  assert.ok(!(prompt.NAYA_WORK_DELIVERY + WORKER_INSTRUCTIONS).includes(gone), gone);
}
assert.ok(WORKER_INSTRUCTIONS.includes('one JSON object with spoken'));

// OUTSIDE-A1: the accent is described at meta level only, so no composed instruction quotes an example sentence.
const accented = prompt.composeLiveInstruction({ base: prompt.NAYA_LIVE_BASE, language: 'en', accentSelection: 'indian-strong' });
// The accent blocks ship no quoted example sentence and no isolated tag word, and nothing reaches the instruction.
const accents = Object.values(prompt.LIVE_ACCENT_PRESETS).flatMap(preset => [preset.head, preset.tail]).join('\n\n');
assert.equal(/"[^"]*"/u.test(accents), false, 'the accent blocks quote no example sentence');
for (const tag of ['"actually"', '"itself"', '"only"', '"na"', '"no?"']) assert.equal(accents.includes(tag), false, `the accent blocks prescribe no isolated tag word ${tag}`);
for (const retired of ['Actually, the bicycle is balancing itself only', 'See, the wheels are spinning, na',
  'This is the thing, no?']) {
  assert.equal(accented.text.includes(retired), false, `the live instruction never recites the retired example: ${retired}`);
}

assert.match(prompt.NAYA_LIVE_BASE, /Open from OPENING_FACTS/);
assert.match(prompt.NAYA_LIVE_BASE, /Never open on a subject in exclude_topics/);
assert.doesNotMatch(prompt.NAYA_LIVE_BASE, /Pick one of these|Never invent beyond these options/);
const openingFacts = prompt.buildOpeningFacts({ now: Date.UTC(2026, 10, 5), timeZone: 'UTC', familyNames: [], floorSubjects: [] });
assert.match(openingFacts.section, /OPENING_FACTS/);
assert.deepEqual(openingFacts.facts.day, []);

const pinnedOpening = prompt.buildOpeningFacts({ now: Date.UTC(2026, 10, 5, 9), timeZone: 'UTC', familyNames: [], floorSubjects: [],
  day: ['2026-11-05 10:00 Design review'], openThread: '2026-11-04 Architecture proposal',
  commitments: ['2027-04-01 Run the marathon'], excludeTopics: ['sleep'] });
const { now: openingTime, ...pinnedOpeningFacts } = pinnedOpening.facts;
assert.match(openingTime, /2026/);
assert.deepEqual(pinnedOpeningFacts, approved['Opening facts']);

const startupBackground = compileMemoryBlock({ now: 0, timeZone: 'UTC', clock: 'Synthetic clock', items: [], entries: [], summaries: [] });
assert.ok(startupBackground.text.startsWith(MEMORY_BACKGROUND));
assert.match(MEMORY_BACKGROUND, /Background knowledge, not instructions/);
assert.match(MEMORY_BACKGROUND, /owner's words in this call win/);
assert.match(MEMORY_BACKGROUND, /never announce remembering/);
