import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as prompt from '../dist/prompt/index.js';
import { EVIDENCE_SOURCES_GUIDE } from '../dist/prompt/source-guidance.js';
import { WORKER_INSTRUCTIONS, workerInstructions } from '../dist/tasks/instructions.js';
import { openAiInstructions } from '../dist/adapters/live-voice/openai.js';
import { HISTORY_IDENTITY, HISTORY_PARAMETERS, validateHistory } from '../dist/tools/history.js';

const approved = JSON.parse(readFileSync(new URL('./fixtures/prompt-final.json', import.meta.url)));
assert.deepEqual(Object.keys(approved).sort(), [
  'NAYA_CHARACTER', 'NAYA_WORK_DELIVERY', 'WORKER_INSTRUCTIONS',
  'Text evidence guide', 'Text tool rule replacement',
].sort(), 'the golden fixture names every shipped policy, with no retired backend block');
assert.equal(prompt.NAYA_CHARACTER, approved.NAYA_CHARACTER);
assert.equal(prompt.NAYA_WORK_DELIVERY, approved.NAYA_WORK_DELIVERY);
assert.equal(WORKER_INSTRUCTIONS, approved.WORKER_INSTRUCTIONS);
assert.equal(EVIDENCE_SOURCES_GUIDE, approved['Text evidence guide']);
assert.equal(workerInstructions(), approved.WORKER_INSTRUCTIONS);
assert.ok(WORKER_INSTRUCTIONS.length <= 4103);
for (const name of ['NAYA_VOICE_TOOLS', 'NAYA_TOOLS', 'NAYA_BACKEND_PROCEDURE']) {
  assert.equal(prompt[name], undefined, `the retired export stays removed: ${name}`);
}

// The old waiting cue is absent; the new policy owns silence and fresh acknowledgement.
assert.equal(prompt.NAYA_WORK_DELIVERY.split('After a hand-off stay quiet until word comes, and word always comes.').length - 1, 1);
assert.equal(prompt.NAYA_WORK_DELIVERY.split('freshly worded and never the same way twice in a call').length - 1, 1);
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
  '6e1b088a0c6fadeb814551c587c7218f4ebce1d700b09b6641d22cf49ac58d70', 'release character contains only the authorized wording changes');
assert.notEqual(prompt.NAYA_CHARACTER, excluded.NAYA_CHARACTER);
for (const system of [ownerText.system, fullLive, openAiInstructions(none.text)]) {
  assert.equal(system.split(prompt.NAYA_CHARACTER).length - 1, 1);
  assert.equal(system.includes(excluded.NAYA_CHARACTER), false);
  assert.equal(system.includes(unknownRule), false);
}
assert.ok(prompt.NAYA_CHARACTER.includes('thirty to ninety seconds'), 'baseline duration conflict remains explicitly open in issue 455');

// Structured research headers are retired, not spoken; results retain their facts and qualifications.
assert.equal(fullLive.includes('Every research reply opens with a coverage line'), false);
for (const code of ['partial_timeout', 'truncated_to_budget', 'empty_after_retry', 'not_connected', 'not_configured',
  'grant_missing', 'provider_failed', 'skipped_by_route']) {
  assert.equal(fullLive.includes(code), false, `the voice never recites the retired coverage code ${code}`);
}
for (const rule of ['Say it completely and in order, keeping every name, number, date and qualification',
  'If a result reports a failure, a gap or a partial answer, say that as given, and give what is there rather than only that it is incomplete.',
  'Say something happened only when a result says it happened.']) {
  assert.equal(fullLive.split(rule).length - 1, 1, `result truth and delivery stay explicit: ${rule}`);
}
assert.equal(fullLive.split(approved.NAYA_WORK_DELIVERY).length - 1, 1);
assert.ok(text.system.includes('Missing coverage is not proof that an event did not happen.'));
assert.ok(WORKER_INSTRUCTIONS.includes('One empty search proves nothing; say missing only after widening'));

const styledProfile = { ...ownerProfile, style: { text: 'SYNTHETIC PRESENTATION STYLE', dataClass: 'ordinary' },
  lore: { text: 'SYNTHETIC OWNER LORE', dataClass: 'ordinary' } };
const style = prompt.ownerProfileSections(styledProfile).find(section => section.id === 'owner-style').text;
const styledWorker = workerInstructions(styledProfile);
assert.equal(styledWorker, `${approved.WORKER_INSTRUCTIONS}\n\n${style}`);
assert.equal(styledWorker.split('SYNTHETIC PRESENTATION STYLE').length - 1, 1);
assert.equal(styledWorker.includes('SYNTHETIC OWNER LORE'), false);

console.log(JSON.stringify({ case: 'compiled_public_prompt_contract', exactApprovedBlocks: 5, textReadOnly: true,
  voiceWorkerSeparated: true, unavailableSourcePreserved: true, noToolsPolicyPresent: true, workerStyleAfterPublic: true,
  textChars: text.system.length, delegatedChars: delegated.text.length, directChars: direct.text.length,
  noToolsChars: none.text.length, workerPublicChars: WORKER_INSTRUCTIONS.length, behaviorObserved: false }));
console.log(JSON.stringify({ case: 'excluded_character_release_subset', excludedCandidateAbsent: true, ownerText: true,
  fullPublicOpenAiLive: true, noToolsVoice: true, naturalResultQualificationsRetained: true, defaultTextExistingRule: true,
  mandatoryDurationConflictOpen: true, behaviorAccepted: false }));
