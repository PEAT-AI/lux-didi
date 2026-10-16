import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const stage = source.slice(source.indexOf('function orbStateLineMarkup()'), source.indexOf('function chatLane()'));
const head = source.slice(source.indexOf('function voiceHeadMarkup()'), source.indexOf('function chatHeadMarkup()'));
const installedProof = readFileSync(new URL('../../Sources/LuxDidi/InstalledProofRun.swift', import.meta.url), 'utf8');

test('the Voice lane is the orb stage above its transcript, and the old header row is gone', () => {
  assert.doesNotMatch(source, /voice-heading|NAYA VOICE|Here with you/);
  assert.doesNotMatch(source, /voiceEmptyMarkup\(\)|didi-orb-large/, 'the second orb and the empty-state card are gone');
  assert.doesNotMatch(source, /class="voice-orb"/, 'no small header orb remains');
  assert.match(stage, /class="orb-stage"/);
  assert.match(stage, /class="orb-holder"/);
  assert.match(stage, /liveStateCopy\(liveMachine\.view\.state\)/, 'the state line lives under the orb');
  assert.match(stage, /id="voice-start"/);
  assert.match(stage, /liveMarkup\(live, livePoll\)/, 'the U1 transcript renderer is the lane body');
  assert.match(stage, /id="transcript-jump"/);
  assert.match(stage, /class="transcript"/, 'the transcript is the lane body below the stage');
  assert.doesNotMatch(stage, /connectionsMarkup\(/);
});

test('the Voice lane controls are small icon buttons in the stage top right, not a header row', () => {
  assert.match(head, /id="new-conversation"/);
  assert.doesNotMatch(head, /voice-orb|voice-time|voice-status|voice-state/);
  assert.match(source, /panel-toggle/, 'the always-visible panel control is rendered in the header');
  assert.match(source, /id="transcript-jump"/);
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

test('FE1 the feed is one surface, patched in place and never rebuilt on a poll', () => {
  assert.equal((source.match(/liveMarkup\(live, livePoll\)/g) ?? []).length, 1, 'exactly one feed surface in the voice lane');
  assert.match(source, /liveMachine\.on\(\(\) => \{[\s\S]*?paintLive\(\);/, 'a Live state change repaints, not a full render');
  assert.match(source, /feed-notices/, 'the wrapper notices are patched in place');
  assert.match(source, /feed-jobs/, 'the background job results are patched in place');
  assert.match(source, /earlierSession\(prior\.live\)/, 'a session boundary is captured page-side, not by the host');
});
