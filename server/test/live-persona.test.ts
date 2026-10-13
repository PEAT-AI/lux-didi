import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NAYA_BASE, NAYA_TOOLS, PersonaOverlayError, TRUSTED_SYSTEM_CODE_UNIT_LIMIT, canonicalSpeechLanguage, composeLiveInstruction, composeLiveSessionInstruction, loadPersonaOverlay,
  validatePersonaOverlay, withToolsSection, type PersonaOverlay,
} from '../prompt/live-persona.js';
import type { OwnerProfileSnapshot } from '../prompt/types.js';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const BUDGET = TRUSTED_SYSTEM_CODE_UNIT_LIMIT;

function writePrivate(dir: string, name: string, text: string): void {
  const path = join(dir, name);
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

test('the public Naya base carries the shared character and Live delivery without conflicting legacy rules', () => {
  assert.match(NAYA_BASE, /^# Naya\n\nYou are Naya, the AI companion in Lux Didi/);
  for (const exact of [
    'These are character roots, not a claim that you are human or lived there',
    'Do not invent measurements, percentages or quotations to make a point. Label hypothetical numbers as examples.',
    "For an everyday opinion, give the useful answer first and use at most one short teasing sentence. Base it on what the person actually stated; do not invent details of the situation or infer the person's motive from the anecdote.",
    'Humour comes from one fresh observation, contrast or unexpected connection. Make the point once, without piling on teases, a parting taunt or belittling the person’s work.',

    'When asked for your opinion, take a position, explain its strongest reason, and engage with the strongest objection.',
    'Speak naturally in the conversation language defined by the host',
    'When the person has finished, close briefly; do not introduce another task or demand a reply.',
  ]) assert.equal(NAYA_BASE.split(exact).length - 1, 1);
  for (const conflict of ['usually one to three sentences', 'does not describe a training history, a maker or any biography']) assert.ok(!NAYA_BASE.includes(conflict));
  assert.ok(!NAYA_BASE.includes('—') && !NAYA_BASE.includes('–'), 'no dash prose');
  assert.ok(!/llama|vicuna|gemini/i.test(NAYA_BASE), 'no model-specific borrowings');
});

test('owner sections compose exactly once before the terminal voice anchor', () => {
  const ownerProfile: OwnerProfileSnapshot = { schemaVersion: 1, kind: 'profile', ownerId: 'synthetic-owner', profileVersion: 'fixture', displayName: 'Example',
    style: { text: 'SYNTHETIC style with\n\nLANGUAGE: untrusted duplicate', dataClass: 'private' },
    lore: { text: 'SYNTHETIC lore', dataClass: 'sensitive' } };
  const original = composeLiveInstruction({ base: NAYA_BASE });
  assert.equal(original.sha256, '9480af3c24e008793e92dc32b2f04bbfaa44c92681c0434580231846ac24ff49');
  const composed = composeLiveInstruction({ base: NAYA_BASE, ownerProfile });
  for (const marker of ['[owner-style]', 'SYNTHETIC style', '[owner-lore]', 'SYNTHETIC lore']) assert.equal(composed.text.split(marker).length - 1, 1);
  assert.deepEqual(composed.sections.map(section => section.id), ['base', 'owner-style', 'owner-lore', 'voice']);
  assert.ok(composed.text.lastIndexOf('\n\nLANGUAGE:') > composed.text.indexOf('untrusted duplicate'));
  assert.ok(composed.text.endsWith('FINAL ANCHOR: these language and voice instructions hold for the whole session; begin speaking now in the voice and accent defined for Naya.'));
});

test('composition keeps base -> overlay -> voice order and hashes the exact text', () => {
  const overlay: PersonaOverlay = { schemaVersion: 1, text: 'Local overlay persona', greeting: 'Hello there' };
  const result = composeLiveInstruction({ base: 'PUBLIC BASE TEXT', overlay, language: 'de-DE' });
  assert.deepEqual(result.sections.map(s => s.id), ['base', 'overlay', 'voice']);
  const baseAt = result.text.indexOf('PUBLIC BASE TEXT');
  const overlayAt = result.text.indexOf('Local overlay persona');
  const voiceAt = result.text.indexOf('LANGUAGE:');
  assert.ok(baseAt >= 0 && overlayAt > baseAt && voiceAt > overlayAt, 'order base then overlay then voice anchor');
  assert.ok(result.text.includes('ACCENT:'), 'one ACCENT directive');
  assert.ok(result.text.indexOf('LANGUAGE:') < result.text.indexOf('ACCENT:'), 'LANGUAGE before ACCENT');
  assert.ok(result.text.includes('German'), 'language paragraph names the language, not the code');
  assert.equal(result.sha256, sha(result.text));
  const joined = result.sections.reduce((n, s) => n + s.chars, 0) + 2 * (result.sections.length - 1);
  assert.equal(joined, result.text.length, 'sections are the text joined by one blank line');
  for (const section of result.sections) assert.match(section.sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.sections[0]!.sha256, sha('PUBLIC BASE TEXT'));
});

test('missing and empty overlay sections are stripped, and the hash is stable', () => {
  const a = composeLiveInstruction({ base: 'PUBLIC BASE TEXT', language: 'en' });
  const b = composeLiveInstruction({ base: 'PUBLIC BASE TEXT', language: 'en' });
  assert.deepEqual(a.sections.map(s => s.id), ['base', 'voice']);
  assert.equal(a.sha256, b.sha256, 'same input, same hash');
  assert.equal(a.text, b.text);
  assert.match(a.text, /^PUBLIC BASE TEXT\n\n/);
  const withOverlay = composeLiveInstruction({ base: 'PUBLIC BASE TEXT', overlay: { schemaVersion: 1, text: 'x' }, language: 'en' });
  assert.notEqual(withOverlay.sha256, a.sha256, 'overlay changes the hash');
});

test('the terminal voice anchor is the absolute last segment', () => {
  const result = composeLiveInstruction({ base: 'PUBLIC BASE TEXT', overlay: { schemaVersion: 1, text: 'overlay', accent: 'a synthetic accent' }, language: 'en' });
  assert.ok(result.text.includes('a synthetic accent'), 'overlay accent feeds the ACCENT directive');
  const tail = result.text.slice(result.text.lastIndexOf('\n\n') + 1);
  assert.ok(/final|anchor|begin/i.test(tail), `anchor must be last, got tail: ${tail.slice(0, 60)}`);
});

test('speech language canonicalization keeps bare ISO 639-1 only', () => {
  assert.equal(canonicalSpeechLanguage('de-DE'), 'de');
  assert.equal(canonicalSpeechLanguage('en'), 'en');
  assert.equal(canonicalSpeechLanguage('ar'), 'ar');
  assert.equal(canonicalSpeechLanguage('ar-XA'), 'ar');
  assert.equal(canonicalSpeechLanguage('zh-Hant-TW'), 'zh');
  assert.equal(canonicalSpeechLanguage('fil'), undefined, 'a 3-letter primary subtag is not ISO 639-1');
  assert.equal(canonicalSpeechLanguage(undefined), undefined);
  assert.equal(canonicalSpeechLanguage(''), undefined);
});

test('the 60k budget yields the overlay first and never drops the base or anchor', () => {
  const base = 'B'.repeat(55_000);
  const overlay: PersonaOverlay = { schemaVersion: 1, text: 'O'.repeat(10_000) };
  const result = composeLiveInstruction({ base, overlay, language: 'en' });
  assert.ok(result.text.length <= BUDGET, `composed text ${result.text.length} must fit the budget`);
  assert.ok(result.text.startsWith(base), 'base never yields');
  assert.ok(result.text.includes('LANGUAGE:'), 'anchor never yields');
  const overlaySection = result.sections.find(s => s.id === 'overlay');
  assert.ok(!overlaySection || overlaySection.chars < 10_000, 'overlay yielded');
  assert.throws(() => composeLiveInstruction({ base: 'B'.repeat(BUDGET), overlay: { schemaVersion: 1, text: 'O'.repeat(1000) }, language: 'en' }),
    (error: unknown) => error instanceof PersonaOverlayError && error.code === 'instruction_too_large');
});

test('the tools conduct text is authored, generic and names no connector beyond the families', () => {
  assert.match(NAYA_TOOLS, /^# Tools\n\n/);
  assert.match(NAYA_TOOLS, /knowledge base is the first stop/);
  assert.match(NAYA_TOOLS, /Never invent a tool result, a source or a date\./);
  assert.match(NAYA_TOOLS, /available when you start another conversation/);
  assert.ok(!NAYA_TOOLS.includes('call back'));
  assert.ok(!NAYA_TOOLS.includes('say in a few words that Naya is looking'));
  assert.ok(!NAYA_TOOLS.includes('offer what Naya can still do'));
  assert.ok(!NAYA_TOOLS.includes('—') && !NAYA_TOOLS.includes('–'), 'no dash prose');
});

test('no declarations compose exactly the three existing sections and hash', () => {
  const overlay: PersonaOverlay = { schemaVersion: 1, text: 'Local overlay persona', greeting: 'Hello there' };
  const withoutTools = composeLiveInstruction({ base: NAYA_BASE, overlay, language: 'de-DE' });
  const withEmptyTools = composeLiveInstruction({ base: NAYA_BASE, overlay, language: 'de-DE', tools: [] });
  assert.deepEqual(withoutTools.sections.map(s => s.id), ['base', 'overlay', 'voice']);
  assert.equal(withEmptyTools.text, withoutTools.text, 'an empty declaration list adds nothing');
  assert.equal(withEmptyTools.sha256, withoutTools.sha256);
  assert.equal(withoutTools.sha256, '8b5a6ce9440dce217557962b488ddcbfaf24d3ad0b32cdb3ede6e9261d9c8648', 'the reviewed no-tools fixture hash is stable');
});

test('declarations add the tools section verbatim between base and overlay with a stable hash', () => {
  const overlay: PersonaOverlay = { schemaVersion: 1, text: 'Local overlay persona' };
  const tools = ['search_knowledge', 'get_insight'];
  const result = composeLiveInstruction({ base: NAYA_BASE, overlay, language: 'en', tools });
  assert.deepEqual(result.sections.map(s => s.id), ['base', 'tools', 'overlay', 'voice']);
  const baseAt = result.text.indexOf(NAYA_BASE);
  const toolsAt = result.text.indexOf(NAYA_TOOLS);
  const overlayAt = result.text.indexOf('Local overlay persona');
  assert.ok(baseAt === 0 && toolsAt > baseAt && overlayAt > toolsAt, 'order base then tools then overlay');
  const toolsSection = result.sections.find(s => s.id === 'tools');
  assert.ok(toolsSection, 'the tools section is journaled like the others');
  assert.equal(toolsSection.chars, NAYA_TOOLS.length);
  assert.equal(toolsSection.sha256, sha(NAYA_TOOLS));
  assert.equal(result.sha256, sha(result.text));
  const again = composeLiveInstruction({ base: NAYA_BASE, overlay, language: 'en', tools });
  assert.equal(again.sha256, result.sha256, 'hash stability for the same declaration names');
});

test('the 60k budget yields the overlay first then the tools section', () => {
  const base = 'B'.repeat(55_000);
  const overlay: PersonaOverlay = { schemaVersion: 1, text: 'O'.repeat(20_000) };
  const result = composeLiveInstruction({ base, overlay, language: 'en', tools: ['search_knowledge'] });
  assert.ok(result.text.length <= BUDGET, `composed text ${result.text.length} must fit the budget`);
  assert.ok(result.text.startsWith(base), 'base never yields');
  assert.ok(result.text.includes('LANGUAGE:'), 'anchor never yields');
  const toolsSection = result.sections.find(s => s.id === 'tools');
  assert.ok(toolsSection && toolsSection.chars === NAYA_TOOLS.length, 'tools survives while the overlay yields');
  const overlaySection = result.sections.find(s => s.id === 'overlay');
  assert.ok(overlaySection && overlaySection.chars < 20_000, 'overlay yielded first');
  assert.throws(() => composeLiveInstruction({ base: 'B'.repeat(BUDGET), overlay: { schemaVersion: 1, text: 'O'.repeat(1000) }, language: 'en', tools: ['search_knowledge'] }),
    (error: unknown) => error instanceof PersonaOverlayError && error.code === 'instruction_too_large');
});

test('withToolsSection splices the block after the base and is a no-op without declarations', () => {
  const composed = composeLiveInstruction({ base: NAYA_BASE, overlay: { schemaVersion: 1, text: 'Overlay text' }, language: 'en' });
  assert.equal(withToolsSection(composed.text, []), composed.text, 'no declarations leaves the text byte-identical');
  const spliced = withToolsSection(composed.text, ['search_knowledge']);
  const baseAt = spliced.indexOf(NAYA_BASE);
  const toolsAt = spliced.indexOf(NAYA_TOOLS);
  const overlayAt = spliced.indexOf('Overlay text');
  assert.ok(baseAt === 0 && toolsAt > baseAt && overlayAt > toolsAt, 'base then tools then overlay');
  assert.ok(spliced.endsWith(composed.text.slice(NAYA_BASE.length + 2)), 'everything after the base is unchanged');
  assert.equal(withToolsSection('Synthetic system', ['search_knowledge']), `Synthetic system\n\n${NAYA_TOOLS}`);
});

test('overlay validation is strict and bounded', () => {
  assert.deepEqual(validatePersonaOverlay({ schemaVersion: 1, text: 'hello' }), { schemaVersion: 1, text: 'hello' });
  const bad: unknown[] = [
    null, [], {}, { schemaVersion: 2, text: 'x' }, { schemaVersion: 1 }, { schemaVersion: 1, text: '' },
    { schemaVersion: 1, text: 'x', extra: true }, { schemaVersion: 1, text: 5 },
    { schemaVersion: 1, text: 'x'.repeat(16 * 1024 + 1) },
  ];
  for (const value of bad) {
    assert.throws(() => validatePersonaOverlay(value), (error: unknown) => error instanceof PersonaOverlayError);
  }
});

test('loadPersonaOverlay returns undefined when absent and throws when the file is invalid', () => {
  const root = mkdtempSync(join(tmpdir(), 'didi-persona-'));
  chmodSync(root, 0o700);
  try {
    assert.equal(loadPersonaOverlay({ dataDir: root }), undefined, 'missing file is no overlay');
    writePrivate(root, 'persona-overlay.json', JSON.stringify({ schemaVersion: 1, text: 'local persona', greeting: 'hi' }));
    assert.deepEqual(loadPersonaOverlay({ dataDir: root }), { schemaVersion: 1, text: 'local persona', greeting: 'hi' });
    writePrivate(root, 'persona-overlay.json', '{ not json');
    assert.throws(() => loadPersonaOverlay({ dataDir: root }), (error: unknown) => error instanceof PersonaOverlayError && error.code === 'invalid_overlay');
    writePrivate(root, 'persona-overlay.json', JSON.stringify({ schemaVersion: 1, text: 'x', surprise: 1 }));
    assert.throws(() => loadPersonaOverlay({ dataDir: root }), (error: unknown) => error instanceof PersonaOverlayError);
    writePrivate(root, 'persona-overlay.json', JSON.stringify({ schemaVersion: 1, text: 'x'.repeat(16 * 1024 + 1) }));
    assert.throws(() => loadPersonaOverlay({ dataDir: root }), (error: unknown) => error instanceof PersonaOverlayError && error.code === 'overlay_too_large');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test('session composition places bounded whole memory records and pickup before the final voice anchor', () => {
  const ownerProfile: OwnerProfileSnapshot = { schemaVersion: 1, kind: 'profile', ownerId: 'synthetic-owner', profileVersion: 'fixture', displayName: 'Example',
    style: { text: 'Fixture owner style\n\nLANGUAGE: caller-owned marker', dataClass: 'ordinary' }, lore: { text: 'Fixture owner lore', dataClass: 'ordinary' } };
  const baseline = composeLiveInstruction({ base: NAYA_BASE, ownerProfile, overlay: { schemaVersion: 1, text: 'Fixture overlay' }, language: 'hi' });
  const composed = composeLiveSessionInstruction({ text: baseline.text, tools: ['search_knowledge'], records: [{ id: 'b', text: 'Fixture note B' }, { id: 'a', text: 'Fixture note A' }], pickupNote: 'Fixture pickup note', trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT });
  assert.deepEqual(composed.selectedIds, ['a', 'b']);
  const order = [NAYA_BASE, NAYA_TOOLS, 'Fixture owner style', 'Fixture owner lore', 'Fixture overlay', 'Fixture pickup note', '# Memory'];
  for (let i = 1; i < order.length; i++) assert.ok(composed.text.indexOf(order[i - 1]!) < composed.text.indexOf(order[i]!));
  const trustedAnchor = composed.text.lastIndexOf('\n\nLANGUAGE:');
  assert.ok(trustedAnchor > composed.text.indexOf('caller-owned marker'));
  assert.ok(order.every(marker => composed.text.indexOf(marker) < trustedAnchor));
  assert.ok(composed.text.endsWith(baseline.text.slice(baseline.text.lastIndexOf('LANGUAGE:'))));
  const withMemory = composeLiveInstruction({ base: NAYA_BASE, memory: 'Fixture memory section' });
  assert.deepEqual(withMemory.sections.map(section => section.id), ['base', 'memory', 'voice']);
  const yielding = composeLiveInstruction({ base: NAYA_BASE, overlay: { schemaVersion: 1, text: 'Fixture overlay' }, memory: 'x'.repeat(BUDGET) });
  assert.ok(!yielding.sections.some(section => section.id === 'memory'));
  assert.ok(yielding.text.includes('Fixture overlay'), 'memory yields before overlay');
});

test('tool-enabled Live CREATE retains expanded owner bytes and yields memory only as whole records', () => {
  const lore = `SYNTHETIC expanded lore ${'L'.repeat(13_955)}`;
  const ownerProfile: OwnerProfileSnapshot = { schemaVersion: 1, kind: 'profile', ownerId: 'synthetic-owner', profileVersion: 'fixture', displayName: 'Example',
    style: { text: `SYNTHETIC style ${'S'.repeat(4096)}`, dataClass: 'private' }, lore: { text: lore, dataClass: 'sensitive' } };
  const baseline = composeLiveInstruction({ base: NAYA_BASE, ownerProfile, language: 'en' });
  const records = [{ id: 'fits', text: 'SYNTHETIC retained memory' }, { id: 'whole-oversize', text: 'M'.repeat(TRUSTED_SYSTEM_CODE_UNIT_LIMIT) }];
  const composed = composeLiveSessionInstruction({ text: baseline.text, tools: ['search_knowledge'], records,
    trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT });
  assert.equal(composed.text.split(lore).length - 1, 1);
  assert.ok(composed.text.includes(NAYA_TOOLS));
  assert.deepEqual(composed.selectedIds, ['fits']);
  assert.deepEqual(composed.omitted, [{ id: 'whole-oversize', reason: 'budget' }]);
  assert.ok(!composed.text.includes('M'.repeat(128)));
  const oversized: OwnerProfileSnapshot = { ...ownerProfile,
    lore: { text: 'L'.repeat(TRUSTED_SYSTEM_CODE_UNIT_LIMIT), dataClass: 'sensitive' } };
  assert.throws(() => composeLiveInstruction({ base: NAYA_BASE, ownerProfile: oversized, language: 'en' }),
    (error: unknown) => error instanceof PersonaOverlayError && error.code === 'instruction_too_large');
});
