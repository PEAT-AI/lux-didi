import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const voice = source.slice(source.indexOf('function voiceEmptyMarkup()'), source.indexOf('function chatLane()'));
const head = source.slice(source.indexOf('function voiceHeadMarkup()'), source.indexOf('function chatHeadMarkup()'));
const installedProof = readFileSync(new URL('../../Sources/LuxDidi/InstalledProofRun.swift', import.meta.url), 'utf8');

test('the Voice lane is the compact header plus one calm empty state, with the U1 transcript call site kept', () => {
  assert.doesNotMatch(source, /voice-heading|NAYA VOICE|Here with you/);
  assert.match(voice, /voiceEmptyMarkup\(\)/);
  assert.match(voice, /liveMarkup\(live, livePoll, true\)/, 'X3 merges onto this call site');
  assert.match(voice, /Press Start or/);
  assert.doesNotMatch(source, /connectionsMarkup\(/);
});

test('the voice header reads the LiveMachine and offers Start, Mute, New conversation and the lane toggle', () => {
  assert.match(head, /liveStateCopy\(view\.state\)/);
  assert.match(head, /id="voice-start"/);
  assert.match(head, /id="new-conversation"/);
  assert.doesNotMatch(head, /id="voice-orb-mini"/);
});

test('the old serif hero and its history disclosure are gone from the standard UI', () => {
  assert.doesNotMatch(source, /conversation-history/);
  assert.doesNotMatch(source, /voice-heading/);
});

test('installed proof opens collapsed saved history through its summary before selecting a session', () => {
  const disclosureClick = installedProof.indexOf('#conversation-history');
  const sessionClick = installedProof.indexOf('row.click()');
  assert.ok(disclosureClick > 0);
  assert.ok(installedProof.slice(disclosureClick, sessionClick).includes('summary'));
  assert.ok(installedProof.slice(disclosureClick, sessionClick).includes('.click()'));
  assert.ok(disclosureClick < sessionClick);
  assert.match(installedProof, /summary\.click\(\); return !history\.open/);
});
