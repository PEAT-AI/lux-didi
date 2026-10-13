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
    assert.equal(step.command, undefined);
    if (reason === 'credential_missing') assert.match(step.guideUrl!, /https:\/\/github.com\/PEAT-AI\/lux-didi\/blob\/main\/docs\/user-guide.md/);
  }
  assert.equal(nextStep('secret-token', 'error', 'secret-token').command, undefined);
});
