import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { connectorIDs, reasonCodes, nextStep, signInTarget } from '../src/next-steps.ts';

test('Swift and web tables have identical connector and reason keys', () => {
  const swift = readFileSync(new URL('../../Sources/LuxDidi/NativeNextSteps.swift', import.meta.url), 'utf8');
  for (const [name, keys] of [['connectorIDs', connectorIDs], ['reasonCodes', reasonCodes]] as const) {
    const line = swift.split('\n').find(line => line.includes(`static let ${name} =`))!;
    assert.deepEqual([...line.matchAll(/"([^"]+)"/g)].map(match => match[1]), keys);
  }
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

test('a Mongoose endpoint with no session points at the same sign-in step', () => {
  for (const [id, label] of endpointRows) {
    const step = nextStep(id, 'error', 'not_signed_in');
    assert.equal(step.signIn, true, `${id} keeps its button`);
    assert.match(step.text, new RegExp(`Sign in to ${label} in Settings`));
  }
});

test('the sign-in row belongs to Mongoose alone, so no other connector borrows it', () => {
  for (const id of ['lux-knowledge', 'gmail', 'calendar', 'mattermost']) {
    for (const reason of ['needs_sign_in', 'not_signed_in'] as const) {
      const step = nextStep(id, 'error', reason);
      assert.doesNotMatch(step.text, /Mongoose|Settings/, `${id} keeps its own behaviour for ${reason}`);
      assert.equal(step.signIn, undefined);
    }
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

test('an id outside the production catalogue is never a sign-in row', () => {
  for (const id of ['mongoose', 'mongoose-admin', 'mongoose-knowledge-team', 'secret-token']) {
    const step = nextStep(id, 'error', 'needs_sign_in');
    assert.equal(step.signIn, undefined, `${id} has no button`);
    assert.doesNotMatch(step.text, /Sign in to Mongoose/);
  }
});

test('every production row has a real next step for every reason the host can send', () => {
  for (const id of connectorIDs) {
    for (const reason of reasonCodes) {
      const step = nextStep(id, 'error', reason);
      assert.ok(step.text, `${id} with ${reason} says something`);
      if (reason === 'unknown') continue; // the unknown reason is the diagnostics sentence by design.
      assert.doesNotMatch(step.text, /Check the connector service, then use Copy diagnostics/, `${id} with ${reason} says what to do`);
    }
  }
});

test('a changed tool list is approved by name, and a mismatch names the account', () => {
  const approval = nextStep('gmail', 'error', 'configuration_error');
  assert.match(approval.text, /approve command/);
  assert.match(approval.guideUrl!, /docs\/mcp-configuration\.md/);
  const mismatch = nextStep('gmail', 'error', 'identity_mismatch');
  assert.match(mismatch.text, /different account/);
});

test('a missing Mongoose credential points at the Sign in button, never a command that does not exist', () => {
  for (const [id, label] of endpointRows) {
    const step = nextStep(id, 'error', 'credential_missing');
    assert.equal(step.command, undefined);
    assert.doesNotMatch(step.text, /mongoose-login|Run /);
    assert.match(step.text, new RegExp(`${label} has no stored session\\. Use the Sign in button`));
    assert.match(step.guideUrl!, /docs\/user-guide\.md#connector-setup/);
    assert.doesNotMatch(step.text, /token|bearer/i);
  }
});

test('W1-R3: a Mongoose row never says restart Lux Didi; each reason gets its true next step', () => {
  for (const [id, label] of endpointRows) {
    for (const reason of ['configuration_error', 'discovery_failed', 'handshake_failed', 'identity_mismatch'] as const) {
      const step = nextStep(id, 'error', reason);
      assert.doesNotMatch(step.text, /restart Lux Didi/i, `${id} with ${reason}`);
      assert.match(step.text, new RegExp(label), `${id} with ${reason} names its endpoint`);
    }
    assert.match(nextStep(id, 'error', 'configuration_error').text, /MCP configuration guide/);
    assert.match(nextStep(id, 'error', 'configuration_error').text, /reads that file when it starts/);
    assert.match(nextStep(id, 'error', 'handshake_failed').text, /VPN/);
    assert.match(nextStep(id, 'error', 'discovery_failed').text, /Copy diagnostics/);
    const mismatch = nextStep(id, 'error', 'identity_mismatch');
    assert.match(mismatch.text, /different account/);
    assert.equal(mismatch.signIn, true, 'a wrong account is fixed with the Sign in button');
  }
  // The other connectors keep their own wording.
  assert.match(nextStep('gmail', 'error', 'handshake_failed').text, /restart Lux Didi/);
});

// D2: the Trello board is connected by an imported API key, so neither row offers a sign-in.
test('D2: the Trello board row names the import command and offers no Sign in button', () => {
  assert.ok((connectorIDs as readonly string[]).includes('trello'), 'the row is in the catalogue the app renders');
  for (const reason of ['not_configured', 'not_signed_in', 'credential_revoked', 'identity_mismatch'] as const) {
    const web = nextStep('trello', 'error', reason);
    assert.equal(web.signIn, undefined, `${reason}: no sign-in button on the Trello row`);
    assert.match(web.text, /scripts\/import-trello-key\.sh/, `${reason}: the command that imports the key is named`);
    assert.match(web.text, /trello-board\.json/, `${reason}: the private file is named`);
  }
  assert.equal(signInTarget('trello'), undefined, 'the board has no sign-in endpoint to call');
  const mismatch = nextStep('trello', 'error', 'identity_mismatch');
  assert.doesNotMatch(mismatch.text, /Sign in button/, 'a mismatch never points at a button that is gone');
  assert.match(mismatch.text, /another Trello member/);
});
