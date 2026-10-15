import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const voice = source.slice(source.indexOf('function voiceLane()'), source.indexOf('function chatLane()'));
const chat = source.slice(source.indexOf('function chatLane()'), source.indexOf('function diagnosticsMarkup()'));
const installedProof = readFileSync(new URL('../../Sources/LuxDidi/InstalledProofRun.swift', import.meta.url), 'utf8');

test('the Voice lane is a voice-centered landing with the orb before the live panel and no debug look', () => {
  assert.doesNotMatch(voice, /SPACE TO THINK|A little clarity/);
  assert.ok(voice.indexOf('orbMarkup()') >= 0 && voice.indexOf('orbMarkup()') < voice.indexOf('liveMarkup('));
  assert.doesNotMatch(voice, /connectionsMarkup\(/);
  assert.doesNotMatch(voice, /stay in this same conversation/);
  assert.doesNotMatch(voice, /Type when it is easier|voice-text|live-text-form/);
});

test('the Chat lane owns the connected panel and the saved conversation history', () => {
  assert.ok(chat.indexOf('id="conversation-history"') >= 0);
  assert.ok(chat.indexOf('id="connected-panel"') > chat.indexOf('id="conversation-history"'), 'the composer-bearing panel comes after the history disclosure so it docks to the bottom');
  assert.match(chat, /<details id="conversation-history"[^>]*>/);
});

test('Conversation disclosure state survives full renders and session navigation opens history', () => {
  assert.match(source, /let historyOpen = false/);
  assert.match(source, /#conversation-history[\s\S]*historyOpen/);
  assert.match(source, /historyOpen=true[\s\S]*tab='Conversation'/);
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
