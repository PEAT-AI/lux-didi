import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { connectorIDs, reasonCodes, nextStep } from '../src/next-steps.ts';
test('Swift and web tables have identical connector and reason keys', () => {
  const swift = readFileSync(new URL('../../Sources/LuxDidi/NativeNextSteps.swift', import.meta.url), 'utf8');
  for (const [name, keys] of [['connectorIDs', connectorIDs], ['reasonCodes', reasonCodes]] as const) {
    const line = swift.split('\n').find(line => line.includes(`static let ${name} =`))!;
    assert.deepEqual([...line.matchAll(/"([^"]+)"/g)].map(match => match[1]), keys);
  }
});
test('setup instructions link the public guide without unusable copy commands', () => {
  for (const id of connectorIDs) for (const reason of reasonCodes) {
    const step = nextStep(id, 'error', reason);
    assert.ok(step.text);
    // One actionable row only: the Mongoose sign-in. Every other row stays a static instruction.
    assert.equal(step.command, id === 'mongoose' && reason === 'credential_missing' ? 'mongoose-login' : undefined);
    if (reason === 'credential_missing') assert.match(step.guideUrl!, /https:\/\/github.com\/PEAT-AI\/lux-didi\/blob\/main\/docs\/user-guide.md/);
  }
  assert.equal(nextStep('secret-token', 'error', 'secret-token').command, undefined);
});
test('the mongoose row is the one sign-in action, and it names no pasted token', () => {
  const step = nextStep('mongoose', 'error', 'credential_missing');
  assert.equal(step.command, 'mongoose-login');
  assert.match(step.text, /reconnect Mongoose/);
  assert.doesNotMatch(step.text, /token|bearer|credential file/i);
  for (const reason of reasonCodes) assert.equal(nextStep('mongoose', 'error', reason).command, reason === 'credential_missing' ? 'mongoose-login' : undefined);
});

test('a Mongoose sign-in need points at the Settings button and never at a restart', () => {
  const step = nextStep('mongoose', 'error', 'needs_sign_in');
  assert.match(step.text, /Sign in to Mongoose in Settings/);
  assert.match(step.text, /reconnects by itself/);
  assert.doesNotMatch(step.text, /restart|token|bearer/i);
  assert.equal(step.command, undefined, 'the Settings button runs the login, not a copyable command');
});

test('the sign-in row belongs to Mongoose alone, so no other connector borrows it', () => {
  for (const id of ['lux-knowledge', 'gmail', 'calendar', 'mattermost']) {
    const step = nextStep(id, 'error', 'needs_sign_in');
    assert.doesNotMatch(step.text, /Mongoose|Settings/, `${id} keeps its own behaviour`);
  }
});

test('an unreachable Mongoose offers the sign-in button only once the retries are spent', () => {
  assert.equal(nextStep('mongoose', 'error', 'unreachable', true).signIn, undefined, 'a scheduled retry needs no button');
  assert.match(nextStep('mongoose', 'error', 'unreachable', true).text, /retries in the background/);
  assert.equal(nextStep('mongoose', 'error', 'unreachable', false).signIn, true, 'a spent round leaves the owner the button');
  assert.match(nextStep('mongoose', 'error', 'unreachable', false).text, /stopped retrying/);
  assert.equal(nextStep('gmail', 'error', 'unreachable', false).signIn, undefined, 'only Mongoose has an owner sign-in');
  assert.equal(nextStep('mongoose', 'error', 'needs_sign_in').signIn, true);
});
