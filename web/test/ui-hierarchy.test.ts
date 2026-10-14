import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const conversation = source.slice(source.indexOf('function conversation()'), source.indexOf('function commitmentMarkup'));
const installedProof = readFileSync(new URL('../../Sources/LuxDidi/InstalledProofRun.swift', import.meta.url), 'utf8');

test('Conversation is a voice-centered landing with optional text and secondary history', () => {
  assert.doesNotMatch(conversation, /SPACE TO THINK|A little clarity/);
  assert.ok(conversation.indexOf('orbMarkup()') < conversation.indexOf('id="connected-panel"'));
  assert.ok(conversation.indexOf('id="connected-panel"') < conversation.indexOf('id="conversation-history"'));
  assert.match(conversation, /<details id="conversation-history"[^>]*>/);
  assert.doesNotMatch(conversation, /connectionsMarkup\(/);
  assert.doesNotMatch(conversation, /stay in this same conversation/);
});

test('Conversation disclosure state survives full renders and session navigation opens history', () => {
  assert.match(source, /let historyOpen = false/);
  assert.match(source, /#conversation-history[\s\S]*historyOpen/);
  assert.match(source, /historyOpen=true[\s\S]*tab='Conversation'/);
});

test('installed proof opens collapsed saved history through its summary before selecting a session', () => {
  const disclosureClick = installedProof.indexOf("#conversation-history");
  const sessionClick = installedProof.indexOf('row.click()');
  assert.ok(disclosureClick > 0);
  assert.ok(installedProof.slice(disclosureClick, sessionClick).includes('summary'));
  assert.ok(installedProof.slice(disclosureClick, sessionClick).includes('.click()'));
  assert.ok(disclosureClick < sessionClick);
  assert.match(installedProof, /summary\.click\(\); return !history\.open/);
});
