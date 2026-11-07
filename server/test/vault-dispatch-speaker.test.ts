// F8: a durable ("pending") save leaves through VaultWriter.dispatch, not the helper builder, and lux
// refuses every voice write whose provenance omits the speaker. The envelope the transport sees is the
// only place that fact can be checked before it reaches the wire.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { chatMigrations } from '../chat/index.js';
import { LUX_PARAMS as P } from '../connectors/lux-names.js';
import { domainMigrations } from '../domain/schema.js';
import { liveMigrations } from '../live/index.js';
import { Store } from '../runtime/store.js';
import { VaultWriter, authorizeComposedWrite, type VaultSaveArgs } from '../tools/vault-write.js';

const NOW = 1_700_000_000_000;
const SESSION = 'live-dispatch-speaker';
const NOTE = 'the boat survey is on Tuesday';

function harness(t: TestContext): Store {
  const dir = mkdtempSync(join(tmpdir(), 'vault-dispatch-speaker-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir, [...domainMigrations, ...chatMigrations, ...liveMigrations]);
  t.after(() => store.close());
  return store;
}

test('F8: the dispatched save envelope carries the owner speaker in source_ref', async t => {
  const store = harness(t);
  const minted = store.transaction(tx => authorizeComposedWrite(tx, { liveSessionId: SESSION, stageId: 'speaker-dispatch', content: NOTE, title: NOTE, now: NOW }));
  assert.equal(minted.state, 'dispatch', 'the row is minted and ready to dispatch');
  const opId = minted.state === 'dispatch' ? minted.opId : '';
  const envelopes: VaultSaveArgs[] = [];
  const writer = new VaultWriter({ store, now: () => NOW, log: () => {}, backoff: async () => {},
    transport: { save: async args => { envelopes.push(args); return { outcome: 'inserted' as const, insightId: '9' }; } } });
  await writer.dispatch({ opId, content: NOTE, title: NOTE });
  assert.equal(envelopes.length, 1, 'one dispatch, one save');
  const ref = envelopes[0]?.source?.[P.sourceRef] as Record<string, unknown> | undefined;
  assert.ok(ref, 'a durable write carries its provenance envelope');
  assert.equal(ref.speaker, 'owner', 'lux refuses a voice write whose source_ref has no speaker');
  assert.equal(envelopes[0]?.source?.[P.sourceKind], 'voice_call');
});
