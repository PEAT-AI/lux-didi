import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectorExecutor, type BoundConnector } from '../tasks/connectors.js';
import { createRegistry } from '../tasks/tools.js';
import { Authority, FakeAuthority } from '../tasks/authority.js';
import { runWorker } from '../tasks/worker.js';
import { TaskRuntime } from '../tasks/runtime.js';
import { FakeDelivery } from '../tasks/controller.js';
import { Store } from '../runtime/store.js';
import type { ConnectorEvidence } from '../connectors/index.js';
import type { ConnectionPolicy } from '../tools/types.js';

function binding(connector: string, toolNames: string[], decodedResult: unknown): BoundConnector {
  const policy: ConnectionPolicy = {
    schemaVersion: 1, ownerId: 'fixture', connectionId: connector, generation: 1, enabled: true,
    connector, toolNames, schemaDigest: 'fixture',
    endpoint: { id: 'fixture', url: 'https://fixture.invalid/mcp', account: 'fixture', resource: connector === 'mongoose' ? 'mongoose:knowledge' : 'fixture', credentialRef: null },
    sourcePolicy: { id: 'fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
    route: { identity: 'fixture', allowedClasses: ['ordinary'] },
    bounds: { maxSearchLimit: 25, maxGetIds: 10, maxQueryChars: 4000, maxEntityBytes: 100000, maxResultBytes: 100000 },
  };
  return { connector, policy, reader: { async call() { return { state: 'completed', decodedResult } as ConnectorEvidence; } } };
}

const vault = `# Knowledge Search: 'shade house routine'

**#101** [PATTERN] Orchid care
  valid from 2026-02-01 · current
  Water the synthetic orchids weekly.
  Score: 0.8

**#102** [PATTERN] Previous care plan
  ⚠ superseded by a confirmed current replacement (see #101)
  Historical synthetic watering schedule.
  Score: 0.7`;

test('10.12: real tool results reach the helper without losing mail, vault evidence, company outcomes or owner lore', async () => {
  const execute = connectorExecutor([
    binding('google', ['gmail_read_message'], { id: 'synthetic-mail', headers: { From: 'Dana Example <dana@example.invalid>', Subject: 'Synthetic plan' }, body: 'The synthetic mooring plan is ready.', bodyCoverage: { complete: true } }),
    binding('lux-knowledge', ['search_insights'], vault),
    binding('mongoose', ['search'], { outcome: 'no_match', items: [], coverage: { complete: true } }),
  ]);
  const calls = [
    { id: 'mail', name: 'read_mail', args: { id: 'synthetic-mail', cursor: null } },
    { id: 'vault', name: 'search_insights', args: { query: 'shade house routine' , mode: null } },
    { id: 'company', name: 'search_company', args: { query: 'synthetic absent record', mode: 'answer', cursor: null } },
  ];
  let hop = 0;
  let assertionError: unknown;
  const result = await runWorker({ registry: createRegistry({ execute, authority: new FakeAuthority() }),
    identity: { task_id: 'synthetic-seams', task_revision: 1, connection_generation: 1 },
    input: 'Read my synthetic mail, find shade house advice and check the synthetic company record.',
    profile: { schemaVersion: 1, kind: 'profile', ownerId: 'synthetic-owner', profileVersion: '1', displayName: 'Synthetic Owner',
      style: { text: 'SYNTHETIC STYLE', dataClass: 'ordinary' }, lore: { text: 'SYNTHETIC SEAM LORE', dataClass: 'ordinary' } },
    signal: new AbortController().signal,
    infer: async request => {
      try {
      assert.match(request.instructions, /SYNTHETIC SEAM LORE/);
      if (hop < calls.length) return { text: '', calls: [calls[hop++]!] };
      const [mail, knowledge, company] = request.outputs.map(output => output.result);
      assert.equal(mail?.status, 'ok');
      assert.match(mail!.text, /The synthetic mooring plan is ready/);
      assert.equal(knowledge?.status, 'ok');
      assert.deepEqual(knowledge!.references.map(ref => ref.id), ['101', '102']);
      assert.match(knowledge!.text, /Water the synthetic orchids weekly/);
      assert.match(knowledge!.text, /superseded/);
      assert.notEqual(company?.status, 'failed', JSON.stringify(company));
      assert.match(company!.text, /no_match/);
      return { text: 'The synthetic results are verified.', calls: [] };
      } catch (error) { assertionError = error; throw error; }
    },
  });
  if (assertionError) throw assertionError;
  assert.equal(result.status, 'complete');
  assert.equal(hop, 3);
});

test('10.12: an empty read reason survives the real executor into the next task status, alongside already-said text', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'tasks-seams-1012-')), store = new Store(directory);
  const delivery = new FakeDelivery();
  delivery.spoken.push({ text: 'I already gave the synthetic first answer.', accepted: 8, total: 8 });
  const captured: Record<string, unknown>[] = [];
  let hop = 0;
  const runtime = new TaskRuntime({ store, delivery,
    authority: new Authority({ checkEffect: async () => true, log: () => {}, journal: store.taskEffectJournal() }),
    execute: connectorExecutor([binding('google', ['gmail_read_message'], { id: 'synthetic-empty', headers: { From: 'Dana Example <dana@example.invalid>' } })]),
    infer: async request => {
      captured.push(JSON.parse(request.input) as Record<string, unknown>);
      if (hop++ === 0) return { text: '', calls: [{ id: 'read', name: 'read_mail', args: { id: 'synthetic-empty', cursor: null } }] };
      if (hop === 2) {
        assert.equal(request.outputs[0]?.result.status, 'failed');
        assert.equal(request.outputs[0]?.result.reason_code, 'empty_content');
      }
      return { text: 'The source returned no readable text.', calls: [] };
    },
  });
  t.after(() => { runtime.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  await runtime.finalize('Read the synthetic empty mail', 1).result;
  await runtime.finalize('Why did that synthetic read fail?', 1).result;
  const next = captured.at(-1)!;
  assert.match(JSON.stringify(next.already_said), /I already gave the synthetic first answer/);
  assert.match(String(next.verified_status), /empty_content/);
  assert.doesNotMatch(String(next.verified_status), /"status":"running"/);
});
