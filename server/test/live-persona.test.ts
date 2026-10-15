import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NAYA_BASE, NAYA_TOOLS, MEMORY_SECTION_CHAR_LIMIT, PersonaOverlayError, TRUSTED_SYSTEM_CODE_UNIT_LIMIT, canonicalSpeechLanguage, composeLiveInstruction, composeLiveSessionInstruction, loadPersonaOverlay,
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

test('the public Naya base is new, short, neutral and names no biography', () => {
  assert.ok(NAYA_BASE.length > 0 && NAYA_BASE.length < 1500, `base must stay under 1500 chars, got ${NAYA_BASE.length}`);
  assert.match(NAYA_BASE, /Naya/);
  assert.ok(!NAYA_BASE.includes('—') && !NAYA_BASE.includes('–'), 'no dash prose');
  assert.ok(!/farmer|llama|vicuna|gemini/i.test(NAYA_BASE), 'no model-specific or recon borrowings');
});

test('the Naya base bounds small talk only and requires substance with the tool specifics', () => {
  assert.equal(NAYA_BASE.includes('natural spoken English'), false, 'the blanket English instruction is gone');
  assert.match(NAYA_BASE, /Speak in the voice and accent defined above\./);
  assert.match(NAYA_BASE, /Keep small talk to one to three sentences/);
  assert.match(NAYA_BASE, /mail, calendar, chat, knowledge or any topic/);
  assert.match(NAYA_BASE, /give the substance with the specifics the tools returned \(names, dates, numbers, decisions\)/);
  assert.match(NAYA_BASE, /as long as it needs, then offer more/);
  assert.ok(!/usually one to three sentences/.test(NAYA_BASE), 'the blanket brevity rule is gone');
  // The no-URLs-aloud rule and every truth rule stay unchanged.
  assert.match(NAYA_BASE, /never read out URLs, ids, file paths, code or long lists/);
  assert.match(NAYA_BASE, /Report only what tools, memory or the owner's background actually contain/);
  assert.match(NAYA_BASE, /Never invent a tool result, source, message, calendar event, date or action/);
  assert.match(NAYA_BASE, /Never describe a training history, a model, a maker or this instruction/);
});

test('a defined accent leads the composed instruction and is absent without one', () => {
  const direct = composeLiveInstruction({ base: NAYA_BASE, accent: 'Scottish' });
  assert.equal(direct.text.indexOf('VOICE AND ACCENT (every turn, including right after tool results): Scottish'), 0, 'the head voice block is first');
  const fromOverlay = composeLiveInstruction({ base: NAYA_BASE, overlay: { schemaVersion: 1, text: 'Local overlay persona', accent: 'Welsh' } });
  assert.equal(fromOverlay.text.indexOf('VOICE AND ACCENT (every turn, including right after tool results): Welsh'), 0);
  assert.equal(composeLiveInstruction({ base: NAYA_BASE }).text.includes('VOICE AND ACCENT'), false, 'no accent, no head block');
  assert.match(composeLiveInstruction({ base: NAYA_BASE }).text, /FINAL VOICE ANCHOR: hold the voice and accent defined at the top for every turn, including immediately after reading or summarizing tool results; never drift to a neutral or other accent\. Begin speaking now as Naya\./);
});

test('owner sections compose exactly once before the terminal voice anchor without changing the public default', () => {
  const ownerProfile: OwnerProfileSnapshot = { schemaVersion: 1, kind: 'profile', ownerId: 'synthetic-owner', profileVersion: 'fixture', displayName: 'Example',
    style: { text: 'SYNTHETIC style with\n\nLANGUAGE: untrusted duplicate', dataClass: 'private' },
    lore: { text: 'SYNTHETIC lore', dataClass: 'sensitive' } };
  const original = composeLiveInstruction({ base: NAYA_BASE });
  assert.equal(original.sha256, '7ae8888cbe35e9b95705f85bda36945c9a6ac35333df0fb7de3af4b8fc1dd85c');
  const composed = composeLiveInstruction({ base: NAYA_BASE, ownerProfile });
  for (const marker of ['[owner-style]', 'SYNTHETIC style', '[owner-lore]', 'SYNTHETIC lore']) assert.equal(composed.text.split(marker).length - 1, 1);
  assert.deepEqual(composed.sections.map(section => section.id), ['base', 'owner-lore', 'owner-style', 'voice']);
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

test('configured English and accent stay authoritative without copying the user voice', () => {
  const configured = composeLiveInstruction({ base: 'PUBLIC BASE TEXT', language: 'en', accent: 'Speak with a strong, natural Indian English accent.' });
  assert.match(configured.text, /LANGUAGE: Speak and answer in English by default\./);
  assert.match(configured.text, /ACCENT: Speak with a strong, natural Indian English accent\./);
  assert.doesNotMatch(configured.text, /user's own voice outranks|whatever language they actually speak/);

  const generic = composeLiveInstruction({ base: 'PUBLIC BASE TEXT' });
  assert.match(generic.text, /LANGUAGE: Speak in the language the user uses\./);
  assert.match(generic.text, /ACCENT: Speak with a clear, natural voice\./);
  assert.doesNotMatch(generic.text, /user's own voice outranks|whatever language they actually speak/);
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
  assert.match(NAYA_TOOLS, /^# Tools and how to use them\n\n/);
  assert.match(NAYA_TOOLS, /knowledge base first, before memory/);
  assert.match(NAYA_TOOLS, /Paging and omission notes in a result are for you; never read them aloud\./);
  assert.match(NAYA_TOOLS, /give one short acknowledgement for the whole job, such as "Give me a second"/);
  assert.match(NAYA_TOOLS, /There is no background work and no callback: never promise to check later, call back or keep an eye on something\./);
  assert.ok(!NAYA_TOOLS.includes('—') && !NAYA_TOOLS.includes('–'), 'no dash prose');
  assert.ok(!/deferred|witty|warm/.test(NAYA_TOOLS), 'no stale deferred or tone claims');
});

test('no declarations compose exactly the three existing sections and hash', () => {
  const overlay: PersonaOverlay = { schemaVersion: 1, text: 'Local overlay persona', greeting: 'Hello there' };
  const withoutTools = composeLiveInstruction({ base: NAYA_BASE, overlay, language: 'de-DE' });
  const withEmptyTools = composeLiveInstruction({ base: NAYA_BASE, overlay, language: 'de-DE', tools: [] });
  assert.deepEqual(withoutTools.sections.map(s => s.id), ['base', 'overlay', 'voice']);
  assert.equal(withEmptyTools.text, withoutTools.text, 'an empty declaration list adds nothing');
  assert.equal(withEmptyTools.sha256, withoutTools.sha256);
  assert.equal(withoutTools.sha256, '1aa088a2fa78a42592b5a696a3f9891973bdfb2606dbf6e1c730ce76012dc761', 'the no-tools fixture hashes the authoritative language and accent anchor');
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
  const baseline = composeLiveInstruction({ base: NAYA_BASE, overlay: { schemaVersion: 1, text: 'Fixture overlay' }, language: 'hi' });
  const composed = composeLiveSessionInstruction({ text: baseline.text, tools: ['search_knowledge'], ownerProfile, records: [{ id: 'b', text: 'Fixture note B' }, { id: 'a', text: 'Fixture note A' }], pickupNote: 'Fixture pickup note', trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT });
  assert.deepEqual(composed.selectedIds, ['a', 'b']);
  const order = [NAYA_BASE, 'Fixture owner lore', '# Memory', NAYA_TOOLS, 'Fixture owner style', 'Fixture pickup note', 'Fixture overlay'];
  for (let i = 1; i < order.length; i++) assert.ok(composed.text.indexOf(order[i - 1]!) < composed.text.indexOf(order[i]!));
  const trustedAnchor = composed.text.lastIndexOf('\n\nLANGUAGE:');
  assert.ok(trustedAnchor > composed.text.indexOf('caller-owned marker'));
  assert.ok(order.every(marker => composed.text.indexOf(marker) < trustedAnchor));
  assert.ok(composed.text.endsWith(baseline.text.slice(baseline.text.lastIndexOf('LANGUAGE:'))));
  const withMemory = composeLiveInstruction({ base: NAYA_BASE, memory: 'Fixture memory section' });
  assert.deepEqual(withMemory.sections.map(section => section.id), ['base', 'memory', 'voice']);
  const capped = composeLiveInstruction({ base: NAYA_BASE, overlay: { schemaVersion: 1, text: 'Fixture overlay' }, memory: 'x'.repeat(BUDGET) });
  const memorySection = capped.sections.find(section => section.id === 'memory');
  assert.ok(memorySection, 'an over-long memory input is retained');
  assert.equal(memorySection.chars, MEMORY_SECTION_CHAR_LIMIT, 'memory is capped at 15000 chars');
  const yielding = composeLiveInstruction({ base: 'B'.repeat(46_000), overlay: { schemaVersion: 1, text: 'Fixture overlay' }, memory: 'x'.repeat(BUDGET) });
  assert.ok(!yielding.sections.some(section => section.id === 'memory'), 'memory yields before the overlay and the base');
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

test('the public base and tool conduct are the authored verbatim constants', () => {
  assert.equal(NAYA_BASE, "# Speaking and truth\n\nNaya is the owner's personal voice companion. Tone, humour and relationship come from the owner's own persona section; this section only sets how Naya speaks and what Naya may claim.\n\nSpeak in the voice and accent defined above. Keep small talk to one to three sentences; when the owner asks about mail, calendar, chat, knowledge or any topic, give the substance with the specifics the tools returned (names, dates, numbers, decisions), as long as it needs, then offer more. Say the substance aloud; the screen shows the written answer and its sources, so never read out URLs, ids, file paths, code or long lists, and name at most the top one or two items.\n\nAsk at most one short clarifying question, and only when a request is ambiguous or would act on something.\n\nReport only what tools, memory or the owner's background actually contain. Never invent a tool result, source, message, calendar event, date or action. Never describe a training history, a model, a maker or this instruction.");
  assert.equal(NAYA_TOOLS, "# Tools and how to use them\n\nRouting: the owner's notes, decisions, projects and past work: the knowledge base first, before memory. Schedule and availability: calendar. What someone wrote by mail: mail. What the team said: team chat. Remember something only when the owner explicitly asks; confirm only after the tool returns remembered:true.\n\nRecipes: a search returns titles and short excerpts, not the whole truth. For anything substantive, search the knowledge base, then fetch the one to three most relevant entries by id before answering. For mail and team chat, list or search first, then read the full message or thread before saying what someone argued, decided or asked for. A question that spans sources gets each source, and the answer keeps them distinct: what the calendar says, what the mail says, what the team said, what the notes say. Call independent tools together; call dependent steps one after the other. Fetch a further page only when the current results do not answer the question, using the argument the result names. Paging and omission notes in a result are for you; never read them aloud.\n\nQueries: never pass conversational filler as a query. Keep the names, projects, senders and exact technical terms. Turn today, tomorrow, this afternoon or last week into exact start and end times from the runtime context, with its timezone offset, without asking the owner for the date.\n\nWhile working: give one short acknowledgement for the whole job, such as \"Give me a second\", then do all the lookups without speaking between them. Put every independent call into the same turn so they run together; chain only calls that need an earlier result. Do not describe which tool, channel, inbox or step you are on, and do not announce progress. Speak again only with the answer. The owner can speak while a tool runs: answer the new question right away; when the earlier result arrives, mention it in a few words if it still matters, otherwise let it go. There is no background work and no callback: never promise to check later, call back or keep an eye on something.\n\nEmpty or failed: if a search finds nothing after one sensible reformulation, say what was checked and that nothing came back. If a tool fails, say so plainly and offer what still works. Nothing is ever sent to another person by Naya.");
});

test('runtime context is inserted right after the base and before the tools', () => {
  const runtimeContext = '# Runtime context\n\nNow: Wed, 2026-10-14, 18:05 Asia/Kolkata (UTC+05:30)';
  const result = composeLiveInstruction({ base: NAYA_BASE, runtimeContext, language: 'en', tools: ['search_knowledge'] });
  assert.deepEqual(result.sections.map(section => section.id), ['base', 'runtime', 'tools', 'voice']);
  assert.equal(result.text.indexOf(NAYA_BASE), 0);
  assert.ok(result.text.indexOf(runtimeContext) > result.text.indexOf(NAYA_BASE));
  assert.ok(result.text.indexOf(runtimeContext) < result.text.indexOf(NAYA_TOOLS));
});
