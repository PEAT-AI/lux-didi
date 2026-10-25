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

// The three Mongoose endpoints, each its own OAuth resource, with the plain name its button carries.
const endpointRows = [
  ['mongoose-knowledge', 'Mongoose knowledge'],
  ['mongoose-data', 'Mongoose data'],
  ['mongoose-crm', 'Mongoose CRM'],
] as const;

test('each Mongoose endpoint row offers its own sign-in, named for that endpoint', () => {
  for (const [id, label] of endpointRows) {
    const step = nextStep(id, 'error', 'needs_sign_in');
    assert.equal(step.signIn, true, `${id} carries the button`);
    assert.equal(step.command, undefined, 'the Settings button runs the login, not a copyable command');
    assert.match(step.text, new RegExp(`Sign in to ${label} in Settings`), `${id} names itself`);
    assert.match(step.text, /reconnects by itself/);
    assert.doesNotMatch(step.text, /restart|token|bearer/i);
    assert.match(step.guideUrl!, /docs\/user-guide\.md#connector-setup/);
  }
});

test('one endpoint sign-in never speaks for another endpoint', () => {
  const knowledge = nextStep('mongoose-knowledge', 'error', 'needs_sign_in');
  const crm = nextStep('mongoose-crm', 'error', 'needs_sign_in');
  assert.notEqual(knowledge.text, crm.text);
  assert.doesNotMatch(knowledge.text, /CRM/);
  assert.doesNotMatch(crm.text, /knowledge/);
});

test('the sign-in row belongs to Mongoose alone, so no other connector borrows it', () => {
  for (const id of ['lux-knowledge', 'gmail', 'calendar', 'mattermost']) {
    const step = nextStep(id, 'error', 'needs_sign_in');
    assert.doesNotMatch(step.text, /Mongoose|Settings/, `${id} keeps its own behaviour`);
  }
});

test('an unreachable Mongoose endpoint offers its own sign-in only once the retries are spent', () => {
  for (const [id, label] of endpointRows) {
    assert.equal(nextStep(id, 'error', 'unreachable', true).signIn, undefined, 'a scheduled retry needs no button');
    assert.match(nextStep(id, 'error', 'unreachable', true).text, /retries in the background/);
    const spent = nextStep(id, 'error', 'unreachable', false);
    assert.equal(spent.signIn, true, 'a spent round leaves the owner the button');
    assert.match(spent.text, /stopped retrying/);
    assert.match(spent.text, new RegExp(label), `${id} names itself`);
  }
  assert.equal(nextStep('gmail', 'error', 'unreachable', false).signIn, undefined, 'only Mongoose has an owner sign-in');
});

test('an id outside the three endpoints is never a sign-in row', () => {
  for (const id of ['mongoose', 'mongoose-admin', 'mongoose-knowledge-team']) {
    const step = nextStep(id, 'error', 'needs_sign_in');
    assert.equal(step.signIn, undefined, `${id} has no button`);
    assert.doesNotMatch(step.text, /Sign in to Mongoose/);
  }
});

test('a missing Mongoose credential points at the one sign-in command', () => {
  for (const [id] of endpointRows) {
    const step = nextStep(id, 'error', 'credential_missing');
    assert.equal(step.command, 'mongoose-login');
    assert.match(step.guideUrl!, /docs\/user-guide\.md#connector-setup/);
    assert.doesNotMatch(step.text, /token|bearer/i);
  }
});
