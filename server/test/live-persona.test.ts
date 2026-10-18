import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NAYA_CHARACTER, NAYA_VOICE_SURFACE, NAYA_LIVE_BASE, NAYA_TOOLS, NAYA_VOICE_TOOLS, NAYA_BACKEND_PROCEDURE, MEMORY_SECTION_CHAR_LIMIT, STANDING_MEMORY_CHAR_LIMIT, STANDING_MEMORY_PREFACE, LIVE_INSTRUCTION_HARD_LIMIT, LIVE_INSTRUCTION_TARGET_CHARS, OWNER_LORE_CHAR_LIMIT,
  LIVE_RECOVERY_PICKUP,
  PersonaOverlayError, TRUSTED_SYSTEM_CODE_UNIT_LIMIT, canonicalSpeechLanguage, composeLiveInstruction, composeLiveSessionInstruction, loadPersonaOverlay,
  validatePersonaOverlay, withToolsSection, buildEarlierConversationsSection, EARLIER_CONVERSATIONS_HEADER, ownerProfileSections, LIVE_INSTRUCTION_SECTION_IDS, earlierConversationsBudget,
  LIVE_ACCENTS, LIVE_DEFAULT_ACCENT, LIVE_ACCENT_PRESETS, accentPreset, type PersonaOverlay,
} from '../prompt/live-persona.js';
import { safeEvent } from '../host/log.js';
import type { OwnerProfileSnapshot } from '../prompt/types.js';

/**
 * K6, verbatim from the owner's brief: the lookup procedure opens on the three knowledge layers, so
 * the executing model knows where his world lives from its instructions and not only from tool names.
 */
const WHERE_HIS_WORLD_LIVES = `# Where his world lives
Pick the layer where the answer most likely lives and name it in lookups:
- memory: your own memory of your conversations with him: what he told you, what he asked you to remember, his commitments and dates. First stop for anything you two discussed before.
- knowledge: his knowledge base: decisions, project status, technical notes, meeting transcripts, his ideas and personal projects, the record of his work sessions. First stop for how a project stands or what was decided.
- company: the company knowledge base: Plantix as an organisation: who reports to whom, teams, roles, customers, partners, products, company numbers. First stop for questions about people and structure at work.
- calendar for time and meetings, mail for what someone sent, chat for what someone wrote, replies for what is waiting on him.
When a question spans layers, put all of them in one call: they run in parallel, and one call with the right two or three sources beats several calls in a row. Write each query for its source. If the likely layers come back empty, widen once to the next most likely layer, then answer with what you have and say what you checked. Query exactly the time window the question names, so today means today, and skip listing calendars unless he asks which calendars exist.`;

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const BUDGET = TRUSTED_SYSTEM_CODE_UNIT_LIMIT;

function writePrivate(dir: string, name: string, text: string): void {
  const path = join(dir, name);
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

test('the public Naya character is new, bounded, neutral and names no biography', () => {
  assert.ok(NAYA_CHARACTER.length > 0 && NAYA_CHARACTER.length <= 3_200, `character must stay at or under 3200 chars, got ${NAYA_CHARACTER.length}`);
  assert.match(NAYA_CHARACTER, /Naya/);
  assert.ok(!NAYA_CHARACTER.includes('—') && !NAYA_CHARACTER.includes('–'), 'no dash prose');
  assert.ok(!/farmer|llama|vicuna|gemini/i.test(NAYA_CHARACTER), 'no model-specific or recon borrowings');
});

test('the Naya character sets depth and dialogue and drops every brevity cap', () => {
  assert.equal(NAYA_CHARACTER.includes('natural spoken English'), false, 'the blanket English instruction is gone');
  assert.match(NAYA_CHARACTER, /Depth follows the topic, never the turn\./);
  assert.match(NAYA_CHARACTER, /Give the strongest objection to your own chain or to his/);
  assert.match(NAYA_CHARACTER, /Hold him to the commitments he has stated/);
  assert.match(NAYA_CHARACTER, /with specifics: names, numbers, dates, mechanisms, history, books\./);
  assert.ok(!/one to three sentences/.test(NAYA_CHARACTER), 'the small-talk brevity cap is gone');
  assert.ok(!/at most the top one or two items/.test(NAYA_CHARACTER), 'the top-items cap is gone');
  assert.ok(!/at most one short clarifying question/.test(NAYA_CHARACTER), 'the clarifying-question cap is gone');
  assert.ok(!/Keep spoken answers brief/.test(NAYA_CHARACTER), 'the old blanket brevity rule is gone');
  // The no-URLs-aloud rule moved to the voice surface; every truth rule stays in the character.
  assert.match(NAYA_VOICE_SURFACE, /never read out URLs, ids, file paths or code/);
  assert.match(NAYA_CHARACTER, /report only what tools, memory or his background contain/);
  assert.match(NAYA_CHARACTER, /never invent a message, event, date, source or action/);
  assert.match(NAYA_CHARACTER, /Never describe a training history, a model, a maker or this instruction/);
});

test('the composed Live instruction carries NAYA_CHARACTER and NAYA_VOICE_SURFACE verbatim', () => {
  const composed = composeLiveInstruction({ base: NAYA_LIVE_BASE, language: 'en' });
  assert.equal(NAYA_LIVE_BASE, `${NAYA_CHARACTER}\n\n${NAYA_VOICE_SURFACE}`, 'the Live base is the character plus the voice surface');
  assert.ok(composed.text.includes(NAYA_CHARACTER), 'the composed instruction carries the character verbatim');
  assert.ok(composed.text.includes(NAYA_VOICE_SURFACE), 'the composed instruction carries the voice surface verbatim');
  for (const retired of ['short, expressive', 'point first', 'Small talk short']) assert.equal(composed.text.includes(retired), false, `retired brevity string: ${retired}`);
});

test('a defined accent leads the composed instruction and is absent without one', () => {
  const direct = composeLiveInstruction({ base: NAYA_LIVE_BASE, accent: 'Scottish' });
  // PV1: the host accent block leads, and the overlay's own accent detail follows it in the same head section.
  assert.equal(direct.text.indexOf(accentPreset(LIVE_DEFAULT_ACCENT)!.head), 0, 'the accent block is first');
  assert.ok(direct.text.indexOf('VOICE AND ACCENT (every turn, including right after tool results): Scottish') > 0, 'the overlay detail follows it');
  const fromOverlay = composeLiveInstruction({ base: NAYA_LIVE_BASE, overlay: { schemaVersion: 1, text: 'Local overlay persona', accent: 'Welsh' } });
  assert.ok(fromOverlay.text.indexOf('VOICE AND ACCENT (every turn, including right after tool results): Welsh') > 0);
  assert.equal(composeLiveInstruction({ base: NAYA_LIVE_BASE, accentSelection: 'voice-default' }).text.includes('VOICE AND ACCENT'), false, 'the voice default has no overlay head block either');
  assert.match(composeLiveInstruction({ base: NAYA_LIVE_BASE }).text, /FINAL VOICE ANCHOR: hold the voice and accent defined at the top for every turn, including immediately after reading or summarizing tool results; never drift to a neutral or other accent\. Begin speaking now as Naya\./);
});

test('the terminal anchor restates the accent after the language line and before the closing line, and is unchanged without one', () => {
  const accent = 'SYNTHETIC-ACCENT-DESCRIPTION';
  const text = composeLiveInstruction({ base: NAYA_LIVE_BASE, accent, language: 'de' }).text;
  const repeat = `VOICE AND ACCENT (repeat): ${accent}`;
  assert.equal(text.split(repeat).length - 1, 1, 'the accent is restated exactly once');
  assert.ok(text.indexOf('LANGUAGE:') < text.indexOf(repeat), 'the restatement follows the language line');
  assert.ok(text.indexOf(repeat) < text.indexOf('Begin speaking now as Naya.'), 'the restatement precedes the closing line');
  const noAccent = composeLiveInstruction({ base: NAYA_LIVE_BASE, language: 'de' }).text;
  assert.equal(noAccent.includes('VOICE AND ACCENT (repeat)'), false, 'no accent, no restatement');
  assert.match(noAccent, /never drift to a neutral or other accent\. Begin speaking now as Naya\./, 'the closing line still precedes the accent tail');
});

test('owner sections compose exactly once before the terminal voice anchor without changing the public default', () => {
  const ownerProfile: OwnerProfileSnapshot = { schemaVersion: 1, kind: 'profile', ownerId: 'synthetic-owner', profileVersion: 'fixture', displayName: 'Example',
    style: { text: 'SYNTHETIC style with\n\nLANGUAGE: untrusted duplicate', dataClass: 'private' },
    lore: { text: 'SYNTHETIC lore', dataClass: 'sensitive' } };
  const original = composeLiveInstruction({ base: NAYA_LIVE_BASE });
  assert.equal(original.sha256, sha(original.text), 'the hash is the text it labels');
  const composed = composeLiveInstruction({ base: NAYA_LIVE_BASE, ownerProfile });
  for (const marker of ['[owner-style]', 'SYNTHETIC style', '[owner-lore]', 'SYNTHETIC lore']) assert.equal(composed.text.split(marker).length - 1, 1);
  assert.deepEqual(composed.sections.map(section => section.id), ['voice-head', 'owner-style', 'base', 'owner-lore', 'voice']);
  assert.ok(composed.text.lastIndexOf('\n\nLANGUAGE:') > composed.text.indexOf('untrusted duplicate'));
  assert.ok(composed.text.includes('FINAL VOICE ANCHOR: hold the voice and accent defined at the top for every turn, including immediately after reading or summarizing tool results; never drift to a neutral or other accent. Begin speaking now as Naya.'));
  assert.ok(composed.text.endsWith(accentPreset(LIVE_DEFAULT_ACCENT)!.tail), 'the accent tail closes the instruction');
});

test('composition keeps base -> overlay -> voice order and hashes the exact text', () => {
  const overlay: PersonaOverlay = { schemaVersion: 1, text: 'Local overlay persona', greeting: 'Hello there' };
  const result = composeLiveInstruction({ base: 'PUBLIC BASE TEXT', overlay, language: 'de-DE' });
  assert.deepEqual(result.sections.map(s => s.id), ['voice-head', 'overlay', 'base', 'voice']);
  const baseAt = result.text.indexOf('PUBLIC BASE TEXT');
  const overlayAt = result.text.indexOf('Local overlay persona');
  const voiceAt = result.text.indexOf('LANGUAGE:');
  assert.ok(baseAt >= 0 && overlayAt < baseAt && voiceAt > baseAt, 'order overlay then base then voice anchor');
  assert.doesNotMatch(result.text, /ACCENT: /, 'no competing ACCENT directive');
  assert.ok(result.text.includes('German'), 'language paragraph names the language, not the code');
  assert.equal(result.sha256, sha(result.text));
  const joined = result.sections.reduce((n, s) => n + s.chars, 0) + 2 * (result.sections.length - 1);
  assert.equal(joined, result.text.length, 'sections are the text joined by one blank line');
  for (const section of result.sections) assert.match(section.sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.sections.find(section => section.id === 'base')!.sha256, sha('PUBLIC BASE TEXT'));
});

test('missing and empty overlay sections are stripped, and the hash is stable', () => {
  const a = composeLiveInstruction({ base: 'PUBLIC BASE TEXT', language: 'en' });
  const b = composeLiveInstruction({ base: 'PUBLIC BASE TEXT', language: 'en' });
  assert.deepEqual(a.sections.map(s => s.id), ['voice-head', 'base', 'voice']);
  assert.equal(a.sha256, b.sha256, 'same input, same hash');
  assert.equal(a.text, b.text);
  assert.ok(a.text.startsWith(`${accentPreset(LIVE_DEFAULT_ACCENT)!.head}\n\nPUBLIC BASE TEXT\n\n`), 'the accent head leads, then the base');
  const withOverlay = composeLiveInstruction({ base: 'PUBLIC BASE TEXT', overlay: { schemaVersion: 1, text: 'x' }, language: 'en' });
  assert.notEqual(withOverlay.sha256, a.sha256, 'overlay changes the hash');
});

test('the terminal voice anchor closes the instruction and the accent tail is the absolute last segment', () => {
  const result = composeLiveInstruction({ base: 'PUBLIC BASE TEXT', overlay: { schemaVersion: 1, text: 'overlay', accent: 'a synthetic accent' }, language: 'en' });
  assert.ok(result.text.includes('a synthetic accent'), 'overlay accent feeds the ACCENT directive');
  const tail = result.text.slice(result.text.lastIndexOf('\n\n') + 2);
  assert.equal(tail, accentPreset(LIVE_DEFAULT_ACCENT)!.tail, 'the accent tail is last');
  const anchor = result.text.slice(result.text.indexOf('FINAL VOICE ANCHOR'), result.text.length - tail.length - 2);
  assert.ok(/Begin speaking now as Naya\.$/.test(anchor), `the anchor closes right before the tail, got: ${anchor.slice(-40)}`);
});

test('configured English and accent stay authoritative without copying the user voice', () => {
  const configured = composeLiveInstruction({ base: 'PUBLIC BASE TEXT', language: 'en', accent: 'Speak with a strong, natural Indian English accent.' });
  assert.match(configured.text, /LANGUAGE: Speak and answer in English by default\./);
  assert.match(configured.text, /VOICE AND ACCENT \(every turn, including right after tool results\): Speak with a strong, natural Indian English accent\./);
  assert.doesNotMatch(configured.text, /user's own voice outranks|whatever language they actually speak/);

  const generic = composeLiveInstruction({ base: 'PUBLIC BASE TEXT' });
  assert.match(generic.text, /LANGUAGE: Speak in the language the user uses\./);
  assert.doesNotMatch(generic.text, /ACCENT: /, 'no accent is invented without one');
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

test('the target budget yields memory first and never drops the base, overlay or anchor', () => {
  // PV1: the target is 30,000 now, so the overlay has to be larger than it was for memory to be the section
  // that yields; the rule under test is the yield order, not the size that used to reach it.
  const ownerProfile = syntheticOwner('S'.repeat(8_000), 'OWNER LORE BLOCK');
  const overlay: PersonaOverlay = { schemaVersion: 1, text: 'O'.repeat(16_000) };
  const result = composeLiveInstruction({ base: NAYA_LIVE_BASE, ownerProfile, overlay, language: 'en', memory: 'M'.repeat(20_000),
    runtimeContext: 'R'.repeat(20_000) });
  assert.ok(result.text.length <= LIVE_INSTRUCTION_HARD_LIMIT, `composed text ${result.text.length} must fit the hard limit`);
  assert.ok(result.text.includes(NAYA_LIVE_BASE), 'base never yields');
  assert.ok(result.text.includes('O'.repeat(16_000)), 'overlay never yields');
  assert.ok(result.text.includes('LANGUAGE:'), 'anchor never yields');
  // PV2: a yielded section is reported with a zero size, so the size line names exactly what was dropped.
  assert.equal(result.sections.find(section => section.id === 'memory')?.chars, 0, 'memory yields first');
  assert.throws(() => composeLiveInstruction({ base: 'B'.repeat(LIVE_INSTRUCTION_HARD_LIMIT), language: 'en' }),
    (error: unknown) => error instanceof PersonaOverlayError && error.code === 'instruction_too_large');
});

test('the tools conduct text is authored, generic and names no connector beyond the families', () => {
  assert.match(NAYA_TOOLS, /^# Tools and how to use them\n\n/);
  // S4b: layer selection and the lookup procedure belong to the executing model. They ride in the
  // backend procedure, and the direct-tool path keeps them inside the full NAYA_TOOLS conduct.
  assert.ok(NAYA_BACKEND_PROCEDURE.includes(WHERE_HIS_WORLD_LIVES), 'the layer routing text is verbatim in the backend procedure');
  assert.ok(NAYA_TOOLS.includes(WHERE_HIS_WORLD_LIVES), 'and the direct-tool conduct still carries it');
  assert.ok(NAYA_BACKEND_PROCEDURE.indexOf(WHERE_HIS_WORLD_LIVES) < NAYA_BACKEND_PROCEDURE.indexOf('research returns the findings'),
    'the layer routing text opens the lookup procedure');
  // S4b: the voice prompt keeps only who decides and how a result is spoken.
  assert.match(NAYA_VOICE_TOOLS, /# Delegation policy/);
  assert.match(NAYA_VOICE_TOOLS, /Delegate when: /);
  assert.match(NAYA_VOICE_TOOLS, /Do not delegate when: /);
  assert.ok(NAYA_VOICE_TOOLS.includes('You can reach his memory, his knowledge, the company knowledge base, his calendar, his mail, his chat and replies, and you can open a web page, a file in his home folder or an app.'), 'the plain-word reach names every family the backend can reach');
  assert.ok(NAYA_VOICE_TOOLS.includes('When you open something, say what you are opening, then open it.'), 'the voice model says what it opens');
  // K6-R1: the item comes from what research already returned. The 3j smoke showed four research
  // calls in a row and never a spoken answer, so a second call is the failure to avoid.
  assert.ok(NAYA_BACKEND_PROCEDURE.includes('Name the exact item from what research already returned; call research again only when nothing it returned fits.'), 'the backend opens the exact item research returned');
  assert.ok(NAYA_TOOLS.includes('Use his vault for his philosophy and decisions, company knowledge for the company, chat and mail for what people actually said; batch independent lookups and follow a new lead when it matters.'), 'the batched query procedure is carried in full');
  // #263: a name after a colon reads as a tool name to the model. The retired routing targets must never
  // reappear, because the Live session declares only research and remember_note.
  for (const retired of ['calendar', 'mail', 'brief', 'search', 'chat']) {
    assert.doesNotMatch(NAYA_TOOLS, new RegExp(`:\\s*${retired}\\b`, 'i'), `retired routing target: ${retired}`);
    assert.doesNotMatch(NAYA_VOICE_TOOLS, new RegExp(`:\\s*${retired}\\b`, 'i'), `retired voice routing target: ${retired}`);
  }
  // It names every configured source family the research tool reaches, instead of routing to a tool per
  // family. Mail is included because it was the incident's working case (R2 stage 1).
  assert.match(NAYA_BACKEND_PROCEDURE, /- memory: your own memory of your conversations with him/);
  assert.match(NAYA_BACKEND_PROCEDURE, /- knowledge: his knowledge base: decisions, project status, technical notes/);
  assert.match(NAYA_BACKEND_PROCEDURE, /- company: the company knowledge base: Plantix as an organisation/);
  assert.match(NAYA_BACKEND_PROCEDURE, /- calendar for time and meetings, mail for what someone sent, chat for what someone wrote, replies for what is waiting on him\./);
  assert.match(NAYA_BACKEND_PROCEDURE, /When a question spans layers, put all of them in one call: they run in parallel/);
  // Q5-R2: a cut lookup is voiced in one clause, never kept silent and never read aloud raw.
  assert.match(NAYA_VOICE_TOOLS, /When a lookup is cut short, say so in a few words and keep going with what you have or ask one precise follow-up; never hand the research back to him\./);
  // PV1-R3: the old cue rule is gone from the composed instructions, so only the OUTCOME 6 sentence steers it.
  assert.doesNotMatch(NAYA_TOOLS, /three to five word/i);
  assert.doesNotMatch(NAYA_TOOLS, /never announce progress/i);
  assert.doesNotMatch(NAYA_TOOLS, /One moment/i);
  assert.doesNotMatch(NAYA_TOOLS, /or call it at once/i);
  assert.match(NAYA_VOICE_TOOLS, /There is no background work and no callback: never promise to check later, call back or keep an eye on something\./);
  assert.ok(!NAYA_TOOLS.includes('—') && !NAYA_TOOLS.includes('–'), 'no dash prose');
  assert.ok(!NAYA_VOICE_TOOLS.includes('—') && !NAYA_VOICE_TOOLS.includes('–'), 'no dash prose in the voice conduct');
  assert.ok(!/deferred|witty|warm/.test(NAYA_TOOLS), 'no stale deferred or tone claims');
});

test('no declarations compose exactly the three existing sections and hash', () => {
  const overlay: PersonaOverlay = { schemaVersion: 1, text: 'Local overlay persona', greeting: 'Hello there' };
  const withoutTools = composeLiveInstruction({ base: NAYA_LIVE_BASE, overlay, language: 'de-DE' });
  const withEmptyTools = composeLiveInstruction({ base: NAYA_LIVE_BASE, overlay, language: 'de-DE', tools: [] });
  assert.deepEqual(withoutTools.sections.map(s => s.id), ['voice-head', 'overlay', 'base', 'voice']);
  assert.equal(withEmptyTools.text, withoutTools.text, 'an empty declaration list adds nothing');
  assert.equal(withEmptyTools.sha256, withoutTools.sha256);
  assert.equal(withoutTools.sha256, sha(withoutTools.text), 'the no-tools fixture hashes its own text');
});

test('declarations add the tools section verbatim between base and overlay with a stable hash', () => {
  const overlay: PersonaOverlay = { schemaVersion: 1, text: 'Local overlay persona' };
  const tools = ['search_knowledge', 'get_insight'];
  const result = composeLiveInstruction({ base: NAYA_LIVE_BASE, overlay, language: 'en', tools });
  assert.deepEqual(result.sections.map(s => s.id), ['voice-head', 'overlay', 'base', 'tools', 'voice']);
  const baseAt = result.text.indexOf(NAYA_LIVE_BASE);
  const toolsAt = result.text.indexOf(NAYA_TOOLS);
  const overlayAt = result.text.indexOf('Local overlay persona');
  assert.ok(overlayAt >= 0 && overlayAt < baseAt && toolsAt > baseAt, 'order overlay then base then tools');
  const toolsSection = result.sections.find(s => s.id === 'tools');
  assert.ok(toolsSection, 'the tools section is journaled like the others');
  assert.equal(toolsSection.chars, NAYA_TOOLS.length);
  assert.equal(toolsSection.sha256, sha(NAYA_TOOLS));
  assert.equal(result.sha256, sha(result.text));
  const again = composeLiveInstruction({ base: NAYA_LIVE_BASE, overlay, language: 'en', tools });
  assert.equal(again.sha256, result.sha256, 'hash stability for the same declaration names');
});

test('PV2: the target budget yields memory whole and then the tools conduct whole, and never drops the overlay', () => {
  // Under the target nothing yields at all.
  const ownerProfile = syntheticOwner('S'.repeat(6_000), 'OWNER LORE BLOCK');
  const overlay: PersonaOverlay = { schemaVersion: 1, text: 'O'.repeat(20_000) };
  const roomy = composeLiveInstruction({ base: NAYA_LIVE_BASE, ownerProfile, overlay, language: 'en', tools: ['search_knowledge'], memory: 'M'.repeat(20_000) });
  assert.ok(roomy.text.length <= LIVE_INSTRUCTION_TARGET_CHARS, `composed text ${roomy.text.length} must fit the target`);
  assert.equal(roomy.sections.some(section => section.chars === 0), false, 'nothing yields under the target');
  // Past it the memory goes first and whole, and the tools conduct stays complete rather than trimmed. The
  // runtime context is sized from the target so that yielding the memory alone brings the text back under it.
  const base = { base: NAYA_LIVE_BASE, ownerProfile, overlay, language: 'en' as const };
  const withoutMemory = composeLiveInstruction({ ...base, tools: ['search_knowledge'] });
  const result = composeLiveInstruction({ ...base, tools: ['search_knowledge'], memory: 'M'.repeat(1_500),
    runtimeContext: 'R'.repeat(LIVE_INSTRUCTION_TARGET_CHARS - withoutMemory.text.length - 1_000) });
  assert.ok(result.text.length <= LIVE_INSTRUCTION_TARGET_CHARS, `composed text ${result.text.length} must fit the target`);
  assert.ok(result.text.includes('O'.repeat(20_000)), 'the overlay never yields');
  assert.ok(result.text.includes('LANGUAGE:'), 'anchor never yields');
  assert.equal(result.sections.find(section => section.id === 'memory')?.chars, 0, 'memory yields first');
  const toolsSection = result.sections.find(s => s.id === 'tools');
  assert.equal(toolsSection?.chars, NAYA_TOOLS.length, 'a surviving tools conduct is complete, never a prefix');
  assert.throws(() => composeLiveInstruction({ base: 'B'.repeat(LIVE_INSTRUCTION_HARD_LIMIT), language: 'en', tools: ['search_knowledge'] }),
    (error: unknown) => error instanceof PersonaOverlayError && error.code === 'instruction_too_large');
});

test('withToolsSection splices the block after the base and is a no-op without declarations', () => {
  const composed = composeLiveInstruction({ base: NAYA_LIVE_BASE, overlay: { schemaVersion: 1, text: 'Overlay text' }, language: 'en' });
  assert.equal(withToolsSection(composed.text, []), composed.text, 'no declarations leaves the text byte-identical');
  const spliced = withToolsSection(composed.text, ['search_knowledge']);
  const baseAt = spliced.indexOf(NAYA_LIVE_BASE);
  const toolsAt = spliced.indexOf(NAYA_TOOLS);
  const overlayAt = spliced.indexOf('Overlay text');
  assert.ok(overlayAt >= 0 && overlayAt < baseAt && toolsAt > baseAt, 'overlay then base then the spliced tools');
  assert.equal(spliced.replace(`${'\n\n'}${NAYA_TOOLS}`, ''), composed.text, 'the splice only inserts the tools block');
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
  const baseline = composeLiveInstruction({ base: NAYA_LIVE_BASE, language: 'hi' });
  const composed = composeLiveSessionInstruction({ text: baseline.text, tools: ['search_knowledge'], ownerProfile, overlay: { schemaVersion: 1, text: 'Fixture overlay' }, records: [{ id: 'b', text: 'Fixture note B' }, { id: 'a', text: 'Fixture note A' }], pickupNote: 'Fixture pickup note', trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT });
  assert.deepEqual(composed.selectedIds, ['a', 'b']);
  const order = ['Fixture owner style', 'Fixture overlay', NAYA_LIVE_BASE, NAYA_TOOLS, 'Fixture owner lore', '# Memory', 'Fixture pickup note'];
  for (let i = 1; i < order.length; i++) assert.ok(composed.text.indexOf(order[i - 1]!) < composed.text.indexOf(order[i]!));
  const trustedAnchor = composed.text.lastIndexOf('\n\nLANGUAGE:');
  assert.ok(trustedAnchor > composed.text.indexOf('caller-owned marker'));
  assert.ok(order.every(marker => composed.text.indexOf(marker) < trustedAnchor));
  assert.ok(composed.text.endsWith(baseline.text.slice(baseline.text.lastIndexOf('LANGUAGE:'))));
  const withMemory = composeLiveInstruction({ base: NAYA_LIVE_BASE, memory: 'Fixture memory section' });
  assert.deepEqual(withMemory.sections.map(section => section.id), ['voice-head', 'base', 'memory', 'voice']);
  const capped = composeLiveInstruction({ base: NAYA_LIVE_BASE, overlay: { schemaVersion: 1, text: 'Fixture overlay' }, memory: 'x'.repeat(BUDGET) });
  const memorySection = capped.sections.find(section => section.id === 'memory');
  assert.ok(memorySection, 'an over-long memory input is retained');
  assert.equal(memorySection.chars, MEMORY_SECTION_CHAR_LIMIT, 'memory is capped at 1500 chars');
  // PV1: the target moved to 30,000, so the overlay is sized from the target itself rather than a fixed number.
  const yieldingSize = LIVE_INSTRUCTION_TARGET_CHARS - baseline.text.length + 1;
  const yielding = composeLiveInstruction({ base: NAYA_LIVE_BASE, ownerProfile, overlay: { schemaVersion: 1, text: 'O'.repeat(yieldingSize) }, memory: 'x'.repeat(BUDGET) });
  assert.equal(yielding.sections.find(section => section.id === 'memory')?.chars, 0, 'memory yields before the overlay and the base');
  assert.ok(yielding.text.includes('O'.repeat(yieldingSize)), 'memory yields before the overlay');
});

test('tool-enabled Live CREATE retains expanded owner bytes and yields memory only as whole records', () => {
  const lore = `SYNTHETIC expanded lore ${'L'.repeat(4_000)}`;
  const ownerProfile: OwnerProfileSnapshot = { schemaVersion: 1, kind: 'profile', ownerId: 'synthetic-owner', profileVersion: 'fixture', displayName: 'Example',
    style: { text: `SYNTHETIC style ${'S'.repeat(4096)}`, dataClass: 'private' }, lore: { text: lore, dataClass: 'sensitive' } };
  const baseline = composeLiveInstruction({ base: NAYA_LIVE_BASE, ownerProfile, language: 'en' });
  const records = [{ id: 'fits', text: 'SYNTHETIC retained memory' }, { id: 'whole-oversize', text: 'M'.repeat(TRUSTED_SYSTEM_CODE_UNIT_LIMIT) }];
  const composed = composeLiveSessionInstruction({ text: baseline.text, tools: ['search_knowledge'], records,
    trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT });
  assert.equal(composed.text.split(lore).length - 1, 1);
  assert.ok(composed.text.includes(NAYA_TOOLS));
  assert.deepEqual(composed.selectedIds, ['fits']);
  assert.deepEqual(composed.omitted, [{ id: 'whole-oversize', reason: 'budget' }]);
  assert.ok(!composed.text.includes('M'.repeat(128)));
  const oversized: OwnerProfileSnapshot = { ...ownerProfile,
    style: { text: 'S'.repeat(LIVE_INSTRUCTION_HARD_LIMIT), dataClass: 'private' } };
  assert.throws(() => composeLiveInstruction({ base: NAYA_LIVE_BASE, ownerProfile: oversized, language: 'en' }),
    (error: unknown) => error instanceof PersonaOverlayError && error.code === 'instruction_too_large');
});

test('the public character, voice surface and tool conduct are the authored verbatim constants', () => {
  // Byte guards: a change to any authored block fails here until its hash is deliberately updated.
  assert.equal(sha(NAYA_CHARACTER), '1dfc5e4140bf249f8fb63c3d45ec6ff5c3277ad88ba722b0caf1a3d901f79063');
  assert.equal(sha(NAYA_VOICE_SURFACE), '43d542607473e43f13d813122c4c407057b28f5d86de032601b0909ac48a0658');
  assert.equal(sha(NAYA_VOICE_TOOLS), '4a94f95aa29a8439139cb9f389dda29f6b7dc506ad652f1271a7ec37cba71b78');
  assert.equal(sha(NAYA_BACKEND_PROCEDURE), '60e007689b0afdf0a2feb43b3bcbcfa97a97142ce0168deabc6cf08653d767a5');
  assert.equal(sha(NAYA_TOOLS), '946c1651d007df23ee1085b013c8c664d4be04d2ac17145123f0df20cf6a59a0');
  assert.equal(NAYA_LIVE_BASE, `${NAYA_CHARACTER}\n\n${NAYA_VOICE_SURFACE}`);
  assert.ok(NAYA_TOOLS.startsWith('# Tools and how to use them\n\n'));
  assert.ok(NAYA_VOICE_TOOLS.endsWith('Nothing is ever sent to another person by Naya.'));
  assert.ok(NAYA_BACKEND_PROCEDURE.endsWith('call research again only when nothing it returned fits.'));
  assert.ok(NAYA_TOOLS.includes('answer at the depth of the question, not the size of the result'));
});

test('runtime context is inserted right after the base and before the tools', () => {
  const runtimeContext = '# Runtime context\n\nNow: Wed, 2026-10-14, 18:05 Asia/Kolkata (UTC+05:30)';
  const result = composeLiveInstruction({ base: NAYA_LIVE_BASE, runtimeContext, language: 'en', tools: ['search_knowledge'] });
  assert.deepEqual(result.sections.map(section => section.id), ['voice-head', 'base', 'tools', 'runtime', 'voice']);
  assert.ok(result.text.indexOf(NAYA_LIVE_BASE) < result.text.indexOf(NAYA_TOOLS));
  assert.ok(result.text.indexOf(NAYA_TOOLS) < result.text.indexOf(runtimeContext));
});

// Contract P1 (issue 1014): persona first, dense facts in the middle, one language line, capped memory.
function syntheticOwner(styleText: string, loreText: string): OwnerProfileSnapshot {
  return { schemaVersion: 1, kind: 'profile', ownerId: 'p1-synthetic', profileVersion: 'p1', displayName: 'Synthetic Owner',
    style: { text: styleText, dataClass: 'private' }, lore: { text: loreText, dataClass: 'sensitive' } };
}

test('P1: persona leads, facts sit in the middle and the anchor closes the instruction', () => {
  const overlay: PersonaOverlay = { schemaVersion: 1, text: 'OVERLAY PERSONA BLOCK', accent: 'strong Indian accent' };
  const result = composeLiveInstruction({ base: NAYA_LIVE_BASE, ownerProfile: syntheticOwner('OWNER STYLE BLOCK', 'OWNER LORE BLOCK'),
    overlay, language: 'en', tools: ['search_knowledge'], runtimeContext: 'RUNTIME CONTEXT BLOCK', memory: 'MEMORY BLOCK' });
  assert.deepEqual(result.sections.map(section => section.id),
    ['voice-head', 'owner-style', 'overlay', 'base', 'tools', 'runtime', 'owner-lore', 'memory', 'voice']);
  const order = ['VOICE AND ACCENT', 'OWNER STYLE BLOCK', 'OVERLAY PERSONA BLOCK', NAYA_LIVE_BASE, NAYA_TOOLS,
    'RUNTIME CONTEXT BLOCK', 'OWNER LORE BLOCK', 'MEMORY BLOCK', 'FINAL VOICE ANCHOR'];
  for (let i = 1; i < order.length; i++) {
    assert.ok(result.text.indexOf(order[i - 1]!) < result.text.indexOf(order[i]!), `${order[i - 1]} must precede ${order[i]}`);
  }
});

test('P1: the memory section is capped at 1500 characters', () => {
  assert.equal(MEMORY_SECTION_CHAR_LIMIT, 1_500);
  const result = composeLiveInstruction({ base: NAYA_LIVE_BASE, memory: 'm'.repeat(50_000) });
  const memory = result.sections.find(section => section.id === 'memory');
  assert.ok(memory, 'an over-long memory input is retained, clipped');
  assert.equal(memory.chars, MEMORY_SECTION_CHAR_LIMIT);
});

test('P1: owner lore survives while memory yields under the budget', () => {
  const lore = `OWNER LORE ${'L'.repeat(4_000)}`;
  // PV1: the 30,000 target needs a larger overlay before memory is the section that yields.
  const result = composeLiveInstruction({ base: NAYA_LIVE_BASE, ownerProfile: syntheticOwner('S'.repeat(5_500), lore),
    overlay: { schemaVersion: 1, text: 'O'.repeat(30_000) }, language: 'en', memory: `MEMORY ${'m'.repeat(20_000)}` });
  assert.equal(result.sections.find(section => section.id === 'memory')?.chars, 0, 'memory yields first');
  const loreSection = result.sections.find(section => section.id === 'owner-lore');
  assert.ok(loreSection && loreSection.chars > 0, 'owner lore is never dropped before memory');
  assert.equal(result.text.split(lore).length - 1, 1, 'the dense lore is present exactly once');
  assert.ok(result.text.length <= LIVE_INSTRUCTION_HARD_LIMIT);
});

test('P1: the tool conduct forbids narrating during a tool run', () => {
  assert.doesNotMatch(NAYA_TOOLS, /while a tool runs/i);
  assert.doesNotMatch(NAYA_TOOLS, /narrat/i);
  // PV1-R3: the old cue rule left the tools section, so the base sentence is the only cue rule left.
  assert.doesNotMatch(NAYA_TOOLS, /three to five word/i);
  assert.doesNotMatch(NAYA_TOOLS, /never announce progress/i);
});

test('P1: exactly one LANGUAGE line, the accent leads the head block and is restated at the terminal anchor', () => {
  const accent = 'strong Indian accent with a warm lilt';
  const overlay: PersonaOverlay = { schemaVersion: 1, text: 'Overlay persona block', accent };
  const result = composeLiveInstruction({ base: NAYA_LIVE_BASE, overlay, language: 'en' });
  assert.equal(result.text.split('LANGUAGE:').length - 1, 1, 'one language line');
  const head = result.sections.find(section => section.id === 'voice-head');
  assert.ok(head, 'the head voice block is its own section');
  const accentAt = result.text.indexOf(accent);
  assert.ok(accentAt !== -1 && accentAt < result.text.indexOf(NAYA_LIVE_BASE), 'the accent is stated in the head block before the base');
  const anchorAt = result.text.lastIndexOf('FINAL VOICE ANCHOR:');
  assert.ok(anchorAt > accentAt && result.text.slice(anchorAt).includes('accent defined at the top'), 'the anchor references the head accent');
  assert.ok(result.text.slice(anchorAt).includes(`VOICE AND ACCENT (repeat): ${accent}`), 'the terminal anchor restates the accent in full');
  assert.equal(result.text.split(accent).length - 1, 2, 'the accent leads the head block and is restated once at the anchor');
  assert.doesNotMatch(result.text, /ACCENT: /);
});

test('P1: the target and hard limits are the declared 44000 and 52000 characters (PV2)', () => {
  assert.equal(LIVE_INSTRUCTION_TARGET_CHARS, 44_000);
  assert.equal(LIVE_INSTRUCTION_HARD_LIMIT, 52_000);
  assert.equal(OWNER_LORE_CHAR_LIMIT, 14_000);
});

test('PV2: a 14,000 character owner lore survives intact, inside its own section budget', () => {
  const lore = 'L'.repeat(14_000);
  const result = composeLiveInstruction({ base: NAYA_LIVE_BASE, ownerProfile: syntheticOwner('OWNER STYLE BLOCK', lore), language: 'en' });
  assert.equal(result.text.split(lore).length - 1, 1, 'the whole 14k lore is present exactly once');
  const loreSection = result.sections.find(section => section.id === 'owner-lore');
  assert.ok(loreSection && loreSection.chars > lore.length, 'the whole lore plus its leader and closing marker');
  assert.ok(result.text.includes('End authored background.'), 'and the closing marker is never cut');
  assert.ok(result.text.length <= LIVE_INSTRUCTION_TARGET_CHARS);
  // Past that budget the lore section is clipped at its own limit, which is not a target-budget yield.
  const clipped = composeLiveInstruction({ base: NAYA_LIVE_BASE, ownerProfile: syntheticOwner('OWNER STYLE BLOCK', 'L'.repeat(14_001)), language: 'en' });
  assert.equal(clipped.text.includes('L'.repeat(14_001)), false);
  assert.ok(clipped.text.includes(lore));
});

test('PV2: a composition over the target drops whole lower-priority sections, never cutting one mid-text', () => {
  const base = { base: NAYA_LIVE_BASE, ownerProfile: syntheticOwner('OWNER STYLE BLOCK', 'L'.repeat(14_000)), accent: 'strong Indian accent', language: 'en' };
  // A composition well past the target yields all three, whole each time, in priority order.
  const full = composeLiveInstruction({ ...base, tools: ['search_knowledge'], memory: 'M'.repeat(1_500), runtimeContext: 'R'.repeat(30_000) });
  assert.ok(full.text.length <= LIVE_INSTRUCTION_TARGET_CHARS);
  assert.deepEqual(full.sections.filter(section => section.chars === 0).map(section => section.id), ['memory', 'tools', 'runtime']);
  assert.equal(full.text.split(NAYA_TOOLS).length - 1, 0, 'not even a prefix of the tools conduct survives');
  assert.equal(full.text.includes('RRRR'), false);
  // Never dropped: the base, the owner style, the whole owner lore and both accent blocks.
  assert.ok(full.text.includes(NAYA_LIVE_BASE), 'the base never yields');
  assert.ok(full.text.includes('OWNER STYLE BLOCK'), 'the owner style never yields');
  assert.ok(full.text.includes('L'.repeat(14_000)), 'the owner lore never yields');
  assert.ok(full.text.includes('FINAL VOICE ANCHOR') && full.text.includes('Begin speaking now as Naya.'), 'the accent tail never yields');
  assert.ok(full.text.includes('strong Indian accent'), 'the accent blocks never yield');
});

test('P9-R2 F1: the session composition carries one accent tail, gives the description once, and logs it', () => {
  const description = 'Warm Indian English, unhurried.';
  const stays = (text: string): number => text.split('Stay in this accent').length - 1;
  const plain = composeLiveInstruction({ base: NAYA_LIVE_BASE, accentSelection: 'indian-strong', language: 'en' });
  const described = composeLiveInstruction({ base: NAYA_LIVE_BASE, accentSelection: 'indian-strong', language: 'en', voiceDescription: description });
  const session = (text: string) => composeLiveSessionInstruction({ text, tools: ['search_knowledge'], records: [],
    trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT, accentSelection: 'indian-strong' });
  const withoutDescription = session(plain.text);
  const composed = session(described.text);
  // The head block and the tail block, never a third: the description adds no accent tail.
  assert.equal(stays(withoutDescription.text), 2, 'the head and the tail, in the text that has no description');
  assert.equal(stays(composed.text), stays(withoutDescription.text), 'the description adds no accent tail');
  assert.equal(composed.text.split('Voice description:').length - 1, 1, 'the description appears once');
  assert.ok(composed.text.trimEnd().endsWith(description), 'and it is the last thing the model reads');
  // The sizes line the session start emits carries the description as its own section.
  const sections = Object.fromEntries(composed.sections.map(section => [section.id, section.chars]));
  const line = `Voice description: ${description}`;
  assert.equal(sections['voice-description'], line.length);
  const logged = safeEvent({ event: 'live_instruction_sizes', total: composed.text.length, sections,
    languageCode: 'en', voice: 'marin' });
  assert.ok(logged, 'the session size line stays inside the closed shape');
  assert.equal((logged.sections as Record<string, number>)['voice-description'], line.length);
  // A second pass over an already composed session text keeps one tail and one description.
  const again = session(composed.text);
  assert.equal(stays(again.text), 2);
  assert.equal(again.text.split('Voice description:').length - 1, 1);
  assert.equal(again.sections.filter(section => section.id === 'voice-description').length, 1);
  // A description that holds a blank line is legal (two paragraphs, or a file with a trailing empty line),
  // so the split must never depend on the description being one paragraph.
  for (const varied of ['Warm Indian English.\n\nDeep and calm.', 'Warm Indian English.\n']) {
    const describedMore = composeLiveInstruction({ base: NAYA_LIVE_BASE, accentSelection: 'indian-strong', language: 'en', voiceDescription: varied });
    const shaped = session(describedMore.text);
    assert.equal(stays(shaped.text), 2, 'still one accent tail');
    assert.equal(shaped.text.split('Voice description:').length - 1, 1, 'still one description');
    assert.ok(shaped.text.endsWith(varied), 'still the last thing the model reads');
    const sized = Object.fromEntries(shaped.sections.map(section => [section.id, section.chars]));
    assert.equal(sized['voice-description'], `Voice description: ${varied}`.length, 'and still its own section');
  }
});

test('PV2: the voice description is appended once inside the accent tail and logs as its own section', () => {
  const description = 'Warm Indian English, unhurried, clear consonants, a light lilt.';
  const result = composeLiveInstruction({ base: NAYA_LIVE_BASE, accent: 'strong Indian accent', language: 'en', voiceDescription: description });
  const line = `Voice description: ${description}`;
  assert.equal(result.text.split('Voice description:').length - 1, 1, 'the description appears exactly once');
  assert.ok(result.text.indexOf('Begin speaking now as Naya.') < result.text.indexOf(line), 'it follows the accent anchor');
  assert.ok(result.text.trimEnd().endsWith(description), 'and it closes the accent tail');
  const section = result.sections[result.sections.length - 1]!;
  assert.equal(section.id, 'voice-description');
  assert.equal(section.chars, line.length);
  // It is on the closed section allowlist, so the size line carries its own count.
  assert.ok((LIVE_INSTRUCTION_SECTION_IDS as readonly string[]).includes('voice-description'));
  const logged = safeEvent({ event: 'live_instruction_sizes', total: result.text.length,
    sections: Object.fromEntries(result.sections.map(entry => [entry.id, entry.chars])), languageCode: 'en', voice: 'marin' });
  assert.ok(logged, 'the size line stays inside the closed shape');
  assert.equal((logged.sections as Record<string, number>)['voice-description'], line.length);
  // No description, no section: the composition is exactly what it was.
  const plain = composeLiveInstruction({ base: NAYA_LIVE_BASE, accent: 'strong Indian accent', language: 'en' });
  assert.equal(plain.sections.some(entry => entry.id === 'voice-description'), false);
  assert.equal(plain.text.includes('Voice description:'), false);
});

test('P3-R2: a full owner layer, session memory and earlier conversations all survive under the raised limits', () => {
  const overlay: PersonaOverlay = { schemaVersion: 1, text: 'O'.repeat(3_000) };
  const ownerProfile = syntheticOwner('S'.repeat(3_000), 'L'.repeat(3_000));
  const baseline = composeLiveInstruction({ base: NAYA_LIVE_BASE, ownerProfile, overlay, language: 'en' });
  const now = Date.UTC(2026, 9, 20, 12, 0);
  const section = buildEarlierConversationsSection(Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, endedAt: now - i * 3_600_000, summary: 'x'.repeat(400) })), { now, timeZone: 'UTC' }).section;
  const composed = composeLiveSessionInstruction({ text: baseline.text, tools: ['search_knowledge'],
    records: [{ id: 'a', text: 'M'.repeat(1_000) }], trustedChars: LIVE_INSTRUCTION_HARD_LIMIT, earlierConversations: section });
  assert.ok(composed.text.length <= LIVE_INSTRUCTION_HARD_LIMIT, `session instruction ${composed.text.length} must fit the hard limit`);
  assert.deepEqual(composed.selectedIds, ['a'], 'the memory record is kept');
  assert.equal(composed.earlierConversationsIncluded, true, 'the earlier-conversations section is kept');
  assert.deepEqual(composed.omitted, [], 'nothing is omitted');
  assert.ok(composed.sections.some(s => s.id === 'memory' && s.chars > 0), 'the memory section survives');
  assert.ok(composed.sections.some(s => s.id === 'tools' && s.chars === NAYA_TOOLS.length), 'TOOLS is intact');
  assert.ok(composed.text.includes(NAYA_TOOLS));
});

test('P1: session composition reports the composed size per section', () => {
  const baseline = composeLiveInstruction({ base: NAYA_LIVE_BASE, language: 'en' });
  const composed = composeLiveSessionInstruction({ text: baseline.text, tools: ['search_knowledge'],
    records: [{ id: 'a', text: 'Synthetic retained note' }], trustedChars: LIVE_INSTRUCTION_HARD_LIMIT });
  assert.ok(Array.isArray(composed.sections), 'section sizes are reported');
  assert.ok(composed.sections.every(section => typeof section.id === 'string' && typeof section.chars === 'number' && section.chars >= 0));
  assert.ok(composed.sections.some(section => section.id === 'memory' && section.chars > 0), 'the memory section is measured');
});

// --- session memory v1: earlier-conversations injection section -------------------------------

const DAY = 24 * 60 * 60 * 1000;

test('the earlier-conversations header is the authored verbatim constant', () => {
  assert.equal(EARLIER_CONVERSATIONS_HEADER,
    "Short summaries of earlier conversations, written automatically. Use them as background when they are relevant; do not bring them up unprompted, do not say that you remember, and do not ask the owner to confirm them. They can be wrong; the owner's words now win.");
});

test('earlier-conversations fills the space left under the budget, newest first, whole summaries only', () => {
  const now = Date.UTC(2026, 9, 20, 12, 0);
  const candidates = Array.from({ length: 20 }, (_, i) => ({ id: `s${String(i).padStart(2, '0')}`, endedAt: now - i * 3_600_000, summary: `summary number ${i}` }));
  // Full budget: every whole summary fits, nothing is capped at six or at 3000 chars.
  const full = buildEarlierConversationsSection(candidates, { now, timeZone: 'UTC' });
  assert.equal(full.selectedIds.length, 20);
  assert.deepEqual(full.omitted, []);
  // Tight budget: as many whole summaries as fit, newest first, never over the budget.
  const tight = buildEarlierConversationsSection(candidates, { now, timeZone: 'UTC', maxChars: 400 });
  assert.ok(tight.selectedIds.length > 0 && tight.selectedIds.length < 20, 'a tight budget keeps a prefix');
  assert.deepEqual(tight.selectedIds, candidates.map(candidate => candidate.id).filter(id => tight.selectedIds.includes(id)), 'newest first');
  assert.ok(tight.section.length <= 400, `section stayed at the budget (${tight.section.length})`);
  assert.deepEqual(tight.omitted.map(o => o.id), candidates.map(candidate => candidate.id).filter(id => !tight.selectedIds.includes(id)));
  assert.ok(tight.omitted.every(o => o.reason === 'budget'));
  for (const line of tight.section.split('\n').slice(2)) assert.match(line, /^[A-Z][a-z]{2} \d+ [A-Z][a-z]{2}, \w+: summary number \d+$/, 'no summary is cut mid-sentence');
});

test('a summary that does not fit is skipped and a smaller older one still fills the budget', () => {
  const now = Date.UTC(2026, 9, 20, 12, 0);
  const big = buildEarlierConversationsSection([
    { id: 'a', endedAt: now, summary: 'x'.repeat(2_500) },
    { id: 'b', endedAt: now - 1, summary: 'y'.repeat(600) },
    { id: 'c', endedAt: now - 2, summary: 'small' },
  ], { now, timeZone: 'UTC', maxChars: 3_000 });
  assert.deepEqual(big.selectedIds, ['a', 'c'], 'b no longer fits the budget; c still does');
  assert.ok(big.omitted.some(o => o.id === 'b' && o.reason === 'budget'));
  assert.ok(big.section.length <= 3_000);
});

test('earlier-conversations excludes summaries older than 14 days as stale', () => {
  const now = Date.UTC(2026, 9, 20, 12, 0);
  const result = buildEarlierConversationsSection([
    { id: 'fresh', endedAt: now - 13 * DAY, summary: 'fresh' },
    { id: 'stale', endedAt: now - 15 * DAY, summary: 'stale' },
  ], { now, timeZone: 'UTC' });
  assert.deepEqual(result.selectedIds, ['fresh']);
  assert.deepEqual(result.omitted, [{ id: 'stale', reason: 'stale' }]);
});

test('earlier-conversations prefixes an absolute local date and part of day in the owner timezone', () => {
  const endedAt = Date.UTC(2026, 9, 13, 12, 30);
  const kolkata = buildEarlierConversationsSection([{ id: 'a', endedAt, summary: 'Shipped the thing.' }], { now: endedAt + 1, timeZone: 'Asia/Kolkata' });
  const losAngeles = buildEarlierConversationsSection([{ id: 'a', endedAt, summary: 'Shipped the thing.' }], { now: endedAt + 1, timeZone: 'America/Los_Angeles' });
  assert.ok(kolkata.section.includes('Tue 13 Oct, evening: Shipped the thing.'), kolkata.section);
  assert.ok(losAngeles.section.includes('Tue 13 Oct, morning: Shipped the thing.'), losAngeles.section);
});

test('the earlier-conversations section sits right after # Memory and yields before it under the cap', () => {
  const baseline = composeLiveInstruction({ base: NAYA_LIVE_BASE, language: 'en' });
  const now = Date.UTC(2026, 9, 20, 12, 0);
  const section = buildEarlierConversationsSection([{ id: 'a', endedAt: now, summary: 'SYNTHETIC prior conversation' }], { now, timeZone: 'UTC' }).section;
  const composed = composeLiveSessionInstruction({ text: baseline.text, tools: ['search_knowledge'],
    records: [{ id: 'fits', text: 'SYNTHETIC retained memory' }], trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT, earlierConversations: section });
  assert.ok(composed.earlierConversationsIncluded);
  const memoryAt = composed.text.indexOf('# Memory');
  const earlierAt = composed.text.indexOf('# Earlier conversations');
  assert.ok(earlierAt > memoryAt, 'the section sits after # Memory');
  assert.ok(composed.sections.some(s => s.id === 'earlier-conversations' && s.chars > 0), 'the section is measured');

  // With no room left after the records, the earlier section yields while memory stays.
  const huge = composeLiveSessionInstruction({ text: baseline.text, tools: [],
    records: [{ id: 'fits', text: 'SYNTHETIC retained memory' }], trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT,
    earlierConversations: 'E'.repeat(TRUSTED_SYSTEM_CODE_UNIT_LIMIT) });
  assert.equal(huge.earlierConversationsIncluded, false);
  assert.equal(huge.sections.some(section => section.id === 'earlier-conversations'), false, 'a yielded section is not reported, so its logged size is zero');
  assert.ok(!huge.text.includes('EEEE'));
  assert.ok(huge.text.includes('SYNTHETIC retained memory'));
});

test('the recovery pickup line is the exact fixed text of release 3g-c', () => {
  assert.equal(LIVE_RECOVERY_PICKUP, "The connection dropped for a moment and is back. Continue the conversation exactly where it was. Do not greet and do not re-introduce yourself. If you were in the middle of an answer, say in a few words that you are back and finish the thought; otherwise answer the owner's last words.");
});
test('P6-R3: the tool conduct looks in the vault before advising and voices an empty search honestly', () => {
  const wrapper = `${NAYA_LIVE_BASE}\n\n${NAYA_TOOLS}`;
  for (const sentence of [
    'When advice, an opinion or an idea depends on his values, earlier thinking, projects or commitments, look in memory or his knowledge vault first unless that evidence is already in the conversation; general explanation needs no lookup.',
    'Use his vault for his philosophy and decisions, company knowledge for the company, chat and mail for what people actually said; batch independent lookups and follow a new lead when it matters.',
    'Give a position, the mechanism and the trade-off that matters, and challenge the weakest assumption; length is not depth.',
  ]) assert.equal(wrapper.split(sentence).length - 1, 1, `stated exactly once: ${sentence}`);
  for (const retired of ["Your own knowledge and judgement need no lookup; tools supply his facts, not his opinions.", "Call research only for a factual question about the owner's mail, calendar, chat, knowledge or the web. Never call it for an opinion, a statement, a feeling or small talk.", 'For ideas, history, science and argument, answer from your own reasoning without a lookup; call research for his facts.']) {
    assert.equal(wrapper.includes(retired), false, `retired prohibition: ${retired}`);
  }
  assert.ok(NAYA_TOOLS.includes('When a search finds nothing, say what you searched and that nothing matched. Never call a source unreachable unless the tool result says it is down.'), 'the empty-search line is stated verbatim');
});

test('the voice surface asks for varied phrasing, never the same framing phrase twice', () => {
  assert.ok(NAYA_VOICE_SURFACE.includes('Vary your phrasing. Do not reuse the same framing phrase twice in one conversation.'), 'the phrasing rule is stated verbatim');
});

// 3p: the owner's morning call heard two over-long pre-tool cues, a spoken "[sigh]", a self-answered question,
// one opener word three times, a calendar list before the real read and three padded answers near 69 words.
// Six unconditional rules replace the six-word cue (P6-R1 keeps rule 6 uncapped: point first, then depth), the
// wrapper growth stays bounded (P6-R3 set 1200; S4b raises the bound for the mandated delegation, backchannel,
// interruption and honesty rules), and the accent block (pinned verbatim by PV1-R1)
// keeps its wording.
const WRAPPER_3O_CHARS = 6603;
test('3p: six wrapper rules are stated once each, the six-word cue is retired, and the wrapper growth stays bounded', () => {
  const rules = [
    'Before an actual lookup, say at most five words about what you are checking, then call the tool.',
    'Never speak stage directions or bracketed sound cues such as [sigh] or (laughs); express tone through the words.',
    'Never ask yourself a question and answer it; say the answer.',
    'Vary how you start replies; never open two replies in a row with the same word.',
    'Query exactly the time window the question names, so today means today, and skip listing calendars unless he asks which calendars exist.',
    'Lead with the point, then give the depth the question deserves; never pad, never summarise what you just said.',
  ];
  const wrapper = `${NAYA_LIVE_BASE}\n\n${NAYA_TOOLS}`;
  for (const rule of rules) assert.equal(wrapper.split(rule).length - 1, 1, `stated exactly once: ${rule}`);
  assert.equal(wrapper.includes('at most six words'), false, 'the six-word cue is retired, its rule is rule 1');
  assert.equal(wrapper.includes('Before any tool call'), false, 'the retired cue sentence is gone');
  const growth = wrapper.length - WRAPPER_3O_CHARS;
  const cap = 2000;
  assert.ok(growth > 0 && growth < cap, `the wrapper grows under the S4b cap of ${cap} chars (${growth})`);
  // The accent block keeps its own wording: no rule restates it and no preset text carries a rule.
  assert.ok(wrapper.includes('in the voice and accent defined above'), 'the wrapper still points at the accent block');
  for (const preset of Object.values(LIVE_ACCENT_PRESETS)) {
    assert.ok(preset.head.includes('Stay in this accent for the whole session, in every single sentence'), 'the accent hold is byte-identical');
    for (const rule of rules) assert.ok(!preset.head.includes(rule) && !preset.tail.includes(rule), 'the accent block carries no delivery rule');
  }
  // The existing live_instruction_sizes receipt already logs base and tools, so the new wrapper size is its size.
  const composed = composeLiveInstruction({ base: NAYA_LIVE_BASE, language: 'en', tools: ['research'] });
  const chars = (id: string) => composed.sections.find(section => section.id === id)?.chars;
  assert.equal(chars('base'), NAYA_LIVE_BASE.length, 'the receipt reports the new base size');
  assert.equal(chars('tools'), NAYA_TOOLS.length, 'the receipt reports the new tools size');
});

const occurrence = (text: string, block: string) => text.split(block).length - 1;

const FIXTURE_OWNER: OwnerProfileSnapshot = { schemaVersion: 1, kind: 'profile', ownerId: 'synthetic-owner', profileVersion: 'fixture', displayName: 'Example',
  style: { text: 'Fixture owner style block', dataClass: 'ordinary' }, lore: { text: 'Fixture owner lore block', dataClass: 'ordinary' } };

test('session composition emits the owner style and lore once in every path', () => {
  const [style, lore] = ownerProfileSections(FIXTURE_OWNER).map(section => section.text);
  const session = (text: string) => composeLiveSessionInstruction({ text, tools: ['search_knowledge'], ownerProfile: FIXTURE_OWNER, records: [],
    overlay: { schemaVersion: 1, text: 'Fixture overlay' }, trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT });
  const native = session(composeLiveInstruction({ base: NAYA_LIVE_BASE, language: 'en', accent: 'warm', ownerProfile: FIXTURE_OWNER }).text);
  assert.equal(occurrence(native.text, style!), 1, 'owner style appears once on the native accent path');
  assert.equal(occurrence(native.text, lore!), 1, 'owner lore appears once on the native accent path');
  const plain = session(composeLiveInstruction({ base: NAYA_LIVE_BASE, language: 'en', ownerProfile: FIXTURE_OWNER }).text);
  assert.equal(occurrence(plain.text, style!), 1, 'owner style appears once without an accent');
  assert.equal(occurrence(plain.text, lore!), 1, 'owner lore appears once without an accent');
  const bare = session(NAYA_LIVE_BASE);
  assert.equal(occurrence(bare.text, style!), 1, 'a bare base still gains the profile once');
  assert.equal(occurrence(bare.text, lore!), 1, 'a bare base still gains the lore once');
});

test('every composed section id is on the LIVE_INSTRUCTION_SECTION_IDS allowlist', () => {
  const allowed = new Set<string>(LIVE_INSTRUCTION_SECTION_IDS);
  const instruction = composeLiveInstruction({ base: NAYA_LIVE_BASE, language: 'en', accent: 'warm', ownerProfile: FIXTURE_OWNER,
    tools: ['search_knowledge'], memory: 'Fixture note', runtimeContext: 'Fixture runtime' });
  for (const section of instruction.sections) assert.ok(allowed.has(section.id), `${section.id} is listed`);
  const session = composeLiveSessionInstruction({ text: instruction.text, tools: ['search_knowledge'], ownerProfile: FIXTURE_OWNER,
    records: [{ id: 'a', text: 'Fixture note' }], pickupNote: 'Fixture pickup', earlierConversations: '# Earlier conversations\nFixture header\nline',
    trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT });
  for (const section of session.sections) assert.ok(allowed.has(section.id), `${section.id} is listed`);
  assert.ok(allowed.has('earlier-conversations'), 'the summary section is a known id');
});

test('the earlier-conversations budget is what the rest of the instruction leaves under the target', () => {
  const now = Date.UTC(2026, 9, 20, 12, 0);
  const candidates = Array.from({ length: 20 }, (_, i) => ({ id: `s${String(i).padStart(2, '0')}`, endedAt: now - i * 3_600_000,
    summary: 'Synthetic past conversation about the Mongoose mint and the Friday delivery window.' }));
  const build = (earlierSection?: string) => composeLiveSessionInstruction({ text: NAYA_LIVE_BASE, tools: ['search_knowledge'], records: [],
    trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT, ...(earlierSection ? { earlierConversations: earlierSection } : {}) });
  const basis = build();
  const budget = earlierConversationsBudget(basis.text.length);
  assert.ok(budget > 0 && budget < LIVE_INSTRUCTION_TARGET_CHARS);
  const section = buildEarlierConversationsSection(candidates, { now, timeZone: 'UTC', maxChars: budget });
  assert.ok(section.selectedIds.length > 6, `the budget keeps more than the old six (${section.selectedIds.length})`);
  const composed = build(section.section);
  assert.ok(composed.text.length <= LIVE_INSTRUCTION_TARGET_CHARS, `stays under the target (${composed.text.length})`);
  assert.ok(composed.text.length <= LIVE_INSTRUCTION_HARD_LIMIT);
  assert.ok(composed.text.includes(NAYA_TOOLS), 'tools are never dropped for summaries');
  assert.equal(composed.earlierConversationsIncluded, true);
});

const standingRecord = (id: string, text: string, status: 'current' | 'dated' | 'open' = 'current') =>
  ({ id, text, standing: { id, text, status, capturedAt: '2026-09-01' } });

test('standing memory sits after owner lore and before # Memory, and never rides the uuid-ordered list', () => {
  const composed = composeLiveSessionInstruction({ text: NAYA_LIVE_BASE, tools: [], trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT, ownerProfile: FIXTURE_OWNER,
    records: [{ id: 'plain', text: 'Fixture plain note' }, standingRecord('standing-1', 'Fixture standing note')] });
  const ids = composed.sections.map(section => section.id);
  assert.ok(ids.indexOf('owner-lore') < ids.indexOf('standing-memory'), 'after owner lore');
  assert.ok(ids.indexOf('standing-memory') < ids.indexOf('memory'), 'before # Memory');
  assert.ok(composed.text.includes(STANDING_MEMORY_PREFACE));
  const memorySection = composed.sections.find(section => section.id === 'memory')!;
  const memoryText = composed.text.slice(composed.text.indexOf('# Memory'), composed.text.indexOf('# Memory') + memorySection.chars);
  assert.ok(!memoryText.includes('Fixture standing note'), 'a standing note is not repeated in # Memory');
  assert.ok(memoryText.includes('Fixture plain note'));
  assert.equal(composed.sections.filter(section => section.id === 'standing-memory').length, 1);
});

test('the standing section keeps its own budget and reports each omission as budget', () => {
  const note = (index: number) => standingRecord(`standing-${String(index).padStart(2, '0')}`, `Fixture standing note ${index} `.repeat(6), 'open');
  const records = Array.from({ length: 12 }, (_, index) => note(index));
  const composed = composeLiveSessionInstruction({ text: NAYA_LIVE_BASE, tools: [], trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT, records });
  const section = composed.sections.find(entry => entry.id === 'standing-memory')!;
  assert.ok(section.chars <= STANDING_MEMORY_CHAR_LIMIT, `section ${section.chars} within ${STANDING_MEMORY_CHAR_LIMIT}`);
  assert.ok(composed.selectedIds.length > 0 && composed.selectedIds.length < records.length, 'whole notes only, and some omitted');
  assert.deepEqual(composed.selectedIds, records.slice(0, composed.selectedIds.length).map(record => record.id), 'kept in rank order');
  assert.ok(composed.omitted.length > 0);
  for (const omission of composed.omitted) assert.equal(omission.reason, 'budget');
  assert.equal(composed.text, composeLiveSessionInstruction({ text: NAYA_LIVE_BASE, tools: [], trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT, records }).text, 'deterministic');
});

test('# Memory keeps its own budget when a standing set is present', () => {
  const records = [
    standingRecord('standing-1', 'S'.repeat(MEMORY_SECTION_CHAR_LIMIT)),
    { id: 'plain-1', text: 'Fixture ad hoc voice note' },
  ];
  const composed = composeLiveSessionInstruction({ text: NAYA_LIVE_BASE, tools: [], trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT, records });
  const memory = composed.sections.find(section => section.id === 'memory')!;
  assert.ok(memory.chars <= MEMORY_SECTION_CHAR_LIMIT);
  assert.ok(composed.text.includes('Fixture ad hoc voice note'));
  assert.ok(composed.sections.some(section => section.id === 'standing-memory'));
});

test('PV2: the budget numbers are the wire-tested ones and a 43,000-char composition fits while 53,000 throws', () => {
  assert.equal(LIVE_INSTRUCTION_TARGET_CHARS, 44_000);
  assert.equal(LIVE_INSTRUCTION_HARD_LIMIT, 52_000);
  // A gpt-live-1 probe accepted 28,000 and 60,000-character instructions and echoed them in full, and the
  // model's 16,384 instruction tokens hold about 60,000 characters; the host targets 44,000 of them.
  const fits = composeLiveInstruction({ base: 'B'.repeat(42_000), language: 'en' });
  assert.ok(fits.text.length >= 43_000, `the composition is at least 43,000 chars (${fits.text.length})`);
  assert.ok(fits.text.length <= LIVE_INSTRUCTION_TARGET_CHARS, `and stays under the target (${fits.text.length})`);
  assert.throws(() => composeLiveInstruction({ base: 'B'.repeat(53_000), language: 'en' }),
    (error: unknown) => error instanceof PersonaOverlayError && error.code === 'instruction_too_large');
});

test('PV1-R1: the accent head and tail blocks are pinned verbatim, and the voice default emits none', () => {
  assert.deepEqual([...LIVE_ACCENTS], ['indian-strong', 'indian-light', 'voice-default']);
  assert.equal(LIVE_DEFAULT_ACCENT, 'indian-strong');
  const WHO = 'You are a young woman from Pune who grew up speaking Indian English at home and at school, and you have never spoken any other accent.';
  const HOLD = 'Stay in this accent for the whole session, in every single sentence, never drifting to an American or British accent. Examples of your phrasing: "Actually, the bicycle is balancing itself only, because of the steering." "See, the wheels are spinning, na, so it wants to go straight." "This is the thing, no? You just have to keep moving."';
  const STRONG = 'Accent: speak English with a strong, clearly audible Indian English accent, as an educated native Indian English speaker does. Use syllable-timed rhythm with even stress instead of English stress-timing and vowel reduction. Pronounce t and d as retroflex, with the tongue curled back. Merge v and w into one soft sound. Use unaspirated p, t and k. Use clear full vowels, a rolled or tapped r, and the Indian English sing-song intonation with rising and falling pitch on phrases. Use natural Indian English phrasing such as "actually", "itself", "only", "na" and "no?". Do not caricature or exaggerate; keep it natural and fluent.';
  const LIGHT = 'Accent: speak English with a gentle, natural Indian English accent, as an educated native Indian English speaker does. Use syllable-timed rhythm with even stress instead of English stress-timing and vowel reduction. Use clear full vowels, a rolled or tapped r, and the Indian English sing-song intonation with rising and falling pitch on phrases. Use natural Indian English phrasing such as "actually", "itself", "only", "na" and "no?". Do not caricature or exaggerate; keep it natural and fluent.';
  assert.equal(LIVE_ACCENT_PRESETS['indian-strong'].head, [WHO, STRONG, HOLD].join('\n\n'));
  assert.equal(LIVE_ACCENT_PRESETS['indian-strong'].tail, HOLD);
  assert.equal(LIVE_ACCENT_PRESETS['indian-light'].head, [WHO, LIGHT, HOLD].join('\n\n'));
  assert.equal(LIVE_ACCENT_PRESETS['indian-light'].tail, HOLD);
  assert.ok(!LIVE_ACCENT_PRESETS['indian-light'].head.includes('retroflex'), 'the retroflex sentence is the strong one');
  assert.equal(accentPreset(undefined)?.tail, HOLD, 'an absent value means indian-strong');
  assert.equal(accentPreset('voice-default'), undefined, 'the voice default has no block');
  const strong = composeLiveInstruction({ base: NAYA_LIVE_BASE, language: 'en', accentSelection: 'indian-strong' });
  assert.ok(strong.text.startsWith(LIVE_ACCENT_PRESETS['indian-strong'].head), 'the head block is the very first text');
  assert.ok(strong.text.endsWith(HOLD), 'the tail block is the very last text');
  assert.ok(strong.text.indexOf(LIVE_ACCENT_PRESETS['indian-strong'].head) === 0, 'before the persona');
  const light = composeLiveInstruction({ base: NAYA_LIVE_BASE, language: 'en', accentSelection: 'indian-light' });
  assert.ok(light.text.startsWith(LIVE_ACCENT_PRESETS['indian-light'].head) && light.text.endsWith(HOLD));
  assert.ok(!light.text.includes(STRONG), 'one selection only');
  const own = composeLiveInstruction({ base: NAYA_LIVE_BASE, language: 'en', accentSelection: 'voice-default' });
  assert.ok(!own.text.includes(WHO) && !own.text.includes(HOLD), 'no accent block at all');
  assert.equal(own.sections.some(section => section.id === 'voice-head'), false, 'and no head block either');
});

test('PV1: the overlay accent detail follows the block, and the receipt lists style and lore apart', () => {
  const overlay: PersonaOverlay = { schemaVersion: 1, text: 'OVERLAY PERSONA BLOCK', accent: 'SYNTHETIC-ACCENT-DESCRIPTION' };
  const frozen = composeLiveInstruction({ base: NAYA_LIVE_BASE, ownerProfile: syntheticOwner('OWNER STYLE BLOCK', 'OWNER LORE BLOCK'), overlay, language: 'en', accentSelection: 'indian-strong' });
  const block = LIVE_ACCENT_PRESETS['indian-strong'].head;
  assert.ok(frozen.text.startsWith(block), 'the block leads');
  assert.ok(frozen.text.indexOf('SYNTHETIC-ACCENT-DESCRIPTION') > block.length, 'the private accent text still follows it');
  const session = composeLiveSessionInstruction({ text: frozen.text, tools: [], records: [], overlay, trustedChars: BUDGET, accentSelection: 'indian-strong' });
  assert.deepEqual(session.sections.map(section => section.id), ['voice-head', 'owner-style', 'overlay', 'base', 'owner-lore', 'voice']);
  assert.ok(session.sections.find(section => section.id === 'owner-style')!.chars > 0, 'the style has its own chars');
  assert.ok(session.sections.find(section => section.id === 'owner-lore')!.chars > 0, 'and so does the lore');
  assert.equal(session.text, frozen.text, 'the split labels the same bytes, never a re-arrangement');
});

test('PV1: a saved accent takes the next session start, replacing the frozen block without an app restart', () => {
  const frozen = composeLiveInstruction({ base: NAYA_LIVE_BASE, language: 'en', accentSelection: 'indian-strong' });
  const session = composeLiveSessionInstruction({ text: frozen.text, tools: [], records: [], trustedChars: BUDGET, accentSelection: 'indian-light' });
  const light = LIVE_ACCENT_PRESETS['indian-light'].head;
  assert.ok(session.text.startsWith(light), 'the head anchor carries the new selection');
  assert.ok(session.text.endsWith(LIVE_ACCENT_PRESETS['indian-light'].tail), 'and so does the tail anchor');
  assert.ok(!session.text.includes(LIVE_ACCENT_PRESETS['indian-strong'].head), 'the frozen block is replaced, never doubled');
  const same = composeLiveSessionInstruction({ text: frozen.text, tools: [], records: [], trustedChars: BUDGET, accentSelection: 'indian-strong' });
  assert.equal(same.text, frozen.text, 'the same selection composes byte-identically');
  const own = composeLiveSessionInstruction({ text: session.text, tools: [], records: [], trustedChars: BUDGET, accentSelection: 'voice-default' });
  assert.ok(!own.text.includes(light), 'and the voice default removes a saved block at the next start');
});

// Q5: both openers of one day were the same eleven-second line, a "go deep" question was answered from
// cut snippets, and a timed-out research call was handed back to the owner and then re-fired. Three
// unconditional rules, each stated once, replacing the sentences they supersede.
const Q5_RULES = [
  "Open a fresh call from work, the calendar or an open work loop; never open on health, fitness, sleep, family or personal habits, even when earlier conversations mention them; if one matters, raise it later in the conversation, at most once, never as the first sentence.",
  'When a lookup is cut short, say so in a few words and keep going with what you have or ask one precise follow-up; never hand the research back to him.',
  'Never make a second research call for the same question until the first has answered.',
];
const Q5_SUPERSEDED = [
  'Open a fresh call with one specific line drawn from what is current, never a generic "ready when you are".',
  'Paging and omission notes in a result are for you; never read them aloud.',
  'A read cut short is said as cut short, so offer a narrower ask.',
  'never make several research calls in a row for one question.',
];
test('Q5: three wrapper rules are stated once each, their superseded sentences are gone, and the growth stays under 700 chars', () => {
  const wrapper = `${NAYA_LIVE_BASE}\n\n${NAYA_TOOLS}`;
  for (const rule of Q5_RULES) assert.equal(wrapper.split(rule).length - 1, 1, `stated exactly once: ${rule}`);
  for (const retired of Q5_SUPERSEDED) assert.equal(wrapper.includes(retired), false, `superseded sentence is gone: ${retired}`);
  const added = Q5_RULES.reduce((chars, rule) => chars + rule.length, 0);
  const removed = Q5_SUPERSEDED.reduce((chars, rule) => chars + rule.length, 0) - 'never make several research calls in a row for one question.'.length;
  assert.ok(added - removed > 0 && added - removed < 700, `the wrapper grows under 700 chars (${added - removed})`);
});

test('Q5-R4: the start instruction carries the previous-openers context once, and nothing when there is none', () => {
  const instruction = composeLiveInstruction({ base: NAYA_LIVE_BASE, ownerProfile: FIXTURE_OWNER, language: 'en' });
  const note = 'Open on a different subject and different words than these earlier openers: "Morning."';
  const withNote = composeLiveSessionInstruction({ text: instruction.text, tools: ['research'], ownerProfile: FIXTURE_OWNER, records: [], trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT, openersNote: note });
  assert.equal(withNote.text.split(note).length - 1, 1, 'the opener context appears exactly once');
  assert.ok(withNote.sections.some(section => section.id === 'previous-openers' && section.chars === note.length), 'it is its own measured section');
  const without = composeLiveSessionInstruction({ text: instruction.text, tools: ['research'], ownerProfile: FIXTURE_OWNER, records: [], trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT });
  assert.equal(without.text.includes('earlier openers'), false, 'a call with no earlier opener carries no context');
  assert.equal(without.sections.some(section => section.id === 'previous-openers'), false, 'and no empty section is reported');
});

// --- S4b: the voice prompt decides and speaks, the delegated backend looks things up ------------------

/** The procedure sentences that moved out of the voice prompt, one entry per sentence. */
const MOVED_PROCEDURE_SENTENCES = [
  'Pick the layer where the answer most likely lives and name it in lookups:',
  '- memory: your own memory of your conversations with him: what he told you, what he asked you to remember, his commitments and dates. First stop for anything you two discussed before.',
  '- knowledge: his knowledge base: decisions, project status, technical notes, meeting transcripts, his ideas and personal projects, the record of his work sessions. First stop for how a project stands or what was decided.',
  '- company: the company knowledge base: Plantix as an organisation: who reports to whom, teams, roles, customers, partners, products, company numbers. First stop for questions about people and structure at work.',
  '- calendar for time and meetings, mail for what someone sent, chat for what someone wrote, replies for what is waiting on him.',
  'When a question spans layers, put all of them in one call: they run in parallel, and one call with the right two or three sources beats several calls in a row.',
  'Write each query for its source.',
  'If the likely layers come back empty, widen once to the next most likely layer, then answer with what you have and say what you checked.',
  'Query exactly the time window the question names, so today means today, and skip listing calendars unless he asks which calendars exist.',
  'Use his vault for his philosophy and decisions, company knowledge for the company, chat and mail for what people actually said; batch independent lookups and follow a new lead when it matters.',
  'Put every lookup one question needs into one research call with several lookups.',
  'Never make a second research call for the same question until the first has answered.',
  'research returns the findings, what it did not check, and whether more is available.',
  'When a reply is partial and canContinue, offer to keep looking in one short sentence; when the owner says "keep looking", call research with action continue and the researchId, and when he says "stop", call it with action stop.',
  'Remember something only when the owner explicitly asks: call remember_note and confirm only after it returns remembered:true.',
  'Name the exact item from what research already returned; call research again only when nothing it returned fits.',
];

test('S4b: the OpenAI voice composition keeps the delegation policy and none of the moved lookup procedure', () => {
  const openai = composeLiveSessionInstruction({ text: 'Synthetic system', tools: ['research'], records: [], trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT, delegatedBackend: true });
  for (const heading of ['Delegation policy', 'Delegate when', 'Do not delegate when']) {
    assert.ok(openai.text.includes(heading), `the voice prompt carries the delegation policy heading: ${heading}`);
  }
  for (const sentence of MOVED_PROCEDURE_SENTENCES) {
    assert.equal(openai.text.includes(sentence), false, `the procedure stays out of the voice prompt: ${sentence.slice(0, 40)}...`);
    assert.equal(NAYA_BACKEND_PROCEDURE.includes(sentence), true, `the backend procedure carries it verbatim: ${sentence.slice(0, 40)}...`);
  }
  assert.ok(openai.text.includes(NAYA_VOICE_TOOLS), 'the voice-side conduct is carried whole');
});

test('S4b: the Gemini composition still carries every NAYA_TOOLS sentence', () => {
  const gemini = composeLiveSessionInstruction({ text: 'Synthetic system', tools: ['research'], records: [], trustedChars: TRUSTED_SYSTEM_CODE_UNIT_LIMIT });
  const sentences = NAYA_TOOLS.split(/(?<=[.?!])\s+|\n+/u).map(sentence => sentence.trim()).filter(sentence => sentence.length > 2);
  for (const sentence of sentences) assert.ok(gemini.text.includes(sentence), `the direct-tool conduct keeps the sentence: ${sentence.slice(0, 40)}...`);
  for (const sentence of MOVED_PROCEDURE_SENTENCES) assert.ok(gemini.text.includes(sentence), `Gemini keeps the procedure sentence: ${sentence.slice(0, 40)}...`);
  assert.ok(gemini.text.includes(NAYA_TOOLS), 'the full conduct is carried byte for byte');
});

test('S4b: each D7/D8 rule is stated once, and the old opener sentence is replaced rather than duplicated', () => {
  const wrapper = `${NAYA_LIVE_BASE}\n\n${NAYA_TOOLS}`;
  for (const rule of [
    'When the answer is already in these instructions, answer from it without a lookup.',
    'Never claim or imply a check that did not run.',
    'Never explain a pause as thinking: say what is actually happening, or simply answer.',
    'When you get a fact wrong and he corrects it, fix it in one clause and continue.',
    'never open on health, fitness, sleep, family or personal habits, even when earlier conversations mention them',
  ]) assert.equal(wrapper.split(rule).length - 1, 1, `stated exactly once: ${rule}`);
  assert.equal(wrapper.split('Open a fresh call').length - 1, 1, 'one opener rule only');
  for (const retired of [
    "Open a fresh call with at most two short sentences drawn from today's work, calendar or an open loop; never reuse the opener of an earlier call.",
    "Open a fresh call with at most two short sentences drawn from today's work, the calendar or an open loop; never reuse the opener of an earlier call, and reach for family, health or fitness only when he raised them in the previous conversation.",
    'Open a fresh call with one specific line drawn from what is current',
  ]) assert.equal(wrapper.includes(retired), false, `the replaced opener sentence is gone: ${retired}`);
});

test('S4b: the voice surface carries backchannel and interruption policy sections', () => {
  assert.match(NAYA_VOICE_SURFACE, /# Backchannel policy\nA short acknowledgement while he is mid-thought is enough\. Never fill the silence while a lookup runs\./);
  assert.match(NAYA_VOICE_SURFACE, /# Interruption policy\nStop when he speaks and answer the new words first\. Return to the earlier thread only if it still matters; otherwise let it go\./);
});

test('S4b: the accent preset head and tail are byte-identical to the shipped voice anchors', () => {
  assert.equal(sha(LIVE_ACCENT_PRESETS['indian-strong'].head), 'f3d65e108053df0c32afe9c9003470359bc1d8b427b35f72994c82f7fd072a5d');
  assert.equal(sha(LIVE_ACCENT_PRESETS['indian-light'].head), '14fc697b526d6d289e65999c36da0a1f4e4efffdcbc39227ddae4057635bdaf2');
  assert.equal(sha(LIVE_ACCENT_PRESETS['indian-strong'].tail), 'f8592a00e9f57bf1fcccd8acceabf1c2488255cda92dcbd1f5397e53100e638e');
  assert.equal(LIVE_ACCENT_PRESETS['indian-strong'].tail, LIVE_ACCENT_PRESETS['indian-light'].tail, 'both presets share the one tail');
});
