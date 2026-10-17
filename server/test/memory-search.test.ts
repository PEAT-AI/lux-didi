import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The real service store, its migrations and the real domain port, not a stand-in: the memory
// source reads what the host actually wrote, including the routing labels it must respect.
import { Store } from '../dist/runtime/store.js';
import { Outbox } from '../dist/runtime/outbox.js';
import { createDomainPort } from '../dist/domain/facade.js';
import type { DomainContext } from '../dist/contracts/domain.js';
import { insertSummary } from '../dist/domain/summaries.js';
import { correct } from '../dist/domain/labels.js';
import { MEMORY, memoryLookup, rankMemory, type MemoryRecord } from '../dist/tools/memory-search.js';
import type { Transaction } from '../dist/contracts/storage.js';

interface Harness { dir: string; store: Store; port: ReturnType<typeof createDomainPort> }

function open(): Harness {
  const port = createDomainPort({ outbox: Outbox, resolveTarget: () => null });
  const dir = mkdtempSync(join(tmpdir(), 'didi-memory-'));
  return { dir, store: new Store(dir, port.migrations), port };
}

function cleanup(h: Harness): void {
  h.store.close();
  rmSync(h.dir, { recursive: true, force: true });
}

function context(now: string): DomainContext {
  return { assistantId: 'assistant-1', clientId: 'client-1', authorityEpoch: 'epoch-1', now };
}

let tick = 0;
function nextNow(): string {
  tick += 1;
  return new Date(Date.UTC(2026, 9, 1, 0, 0, tick)).toISOString();
}

/** One session with one entry, labelled with the class the test wants it read under. */
function remember(h: Harness, text: string, dataClass: 'ordinary' | 'private', at: number): string {
  const session = h.store.transaction(tx => h.port.execute(tx, 'createSession', { title: 'Synthetic', timeZone: 'UTC' }, context(nextNow()))) as { id: string };
  const entry = h.store.transaction(tx => h.port.execute(tx, 'appendEntry', { sessionId: session.id, text, role: 'user', timeZone: 'UTC' }, context(nextNow()))) as { id: string };
  h.store.transaction(tx => correct(tx as unknown as Transaction, { subject: { kind: 'entry', id: entry.id }, expectedRevision: 0, dataClass }, at));
  return entry.id;
}

test('ranking leads with the better match, then the newer record', () => {
  const records: MemoryRecord[] = [
    { kind: 'entry', text: 'a note about the release', at: 3_000 },
    { kind: 'entry', text: 'a note about the release and the dentist', at: 1_000 },
    { kind: 'summary', text: 'a summary about the dentist appointment', at: 2_000 },
  ];
  const ranked = rankMemory(records, 'dentist release');
  assert.deepEqual(ranked.map(record => record.at), [1_000, 2_000, 3_000], 'two matches lead, then one match by recency');
  assert.deepEqual(rankMemory(records, 'release', 1).map(record => record.at), [3_000], 'one match, newest first');
});

test('a query that matches nothing falls back to the newest memory', () => {
  const records: MemoryRecord[] = [
    { kind: 'entry', text: 'older note', at: 1_000 },
    { kind: 'entry', text: 'newer note', at: 9_000 },
  ];
  assert.deepEqual(rankMemory(records, 'nothing here matches', 1).map(record => record.at), [9_000]);
});

test('a lookup reads ordinary conversation entries and never a private one', () => {
  const h = open();
  try {
    remember(h, 'he asked me to remember the dentist on Friday', 'ordinary', 1_760_000_000_000);
    remember(h, 'the dentist keeps a private note about his family', 'private', 1_760_000_100_000);
    const read = h.store.transaction(tx => memoryLookup(tx as unknown as Transaction, 'dentist'));
    assert.equal(read.lines.length, 1, 'only the ordinary entry leaves the port');
    assert.match(read.lines[0]!, /dentist on Friday/);
    assert.match(read.lines[0]!, /^2025-10-09 entry: /, 'a line carries the day and what it came from');
    assert.equal(read.total, 1);
  } finally { cleanup(h); }
});

test('a lookup reads conversation summaries of any age', () => {
  const h = open();
  try {
    h.store.transaction(tx => insertSummary(tx as unknown as Transaction, {
      liveSessionId: 'live-1', status: 'complete', summary: 'they planned the Kyoto trip and the release cut', endedAt: 1_700_000_000_000, now: 1_700_000_000_000,
    }));
    const read = h.store.transaction(tx => memoryLookup(tx as unknown as Transaction, 'Kyoto trip'));
    assert.equal(read.lines.length, 1);
    assert.match(read.lines[0]!, /2023-11-14 summary: they planned the Kyoto trip/);
  } finally { cleanup(h); }
});

test('imported standing memory joins the lookup when a reader is supplied', () => {
  const h = open();
  try {
    remember(h, 'a conversation note about the release', 'ordinary', 1_760_000_000_000);
    const imported = (): readonly MemoryRecord[] => [{ kind: 'imported', text: 'imported standing memory about the release plan', at: 1_500_000_000_000 }];
    const withImport = h.store.transaction(tx => memoryLookup(tx as unknown as Transaction, 'release', { imported }));
    assert.equal(withImport.total, 2);
    assert.ok(withImport.lines.some(line => line.includes('imported standing memory about the release plan')));
    const withoutImport = h.store.transaction(tx => memoryLookup(tx as unknown as Transaction, 'release'));
    assert.equal(withoutImport.total, 1, 'no reader means no imported rows, never a guess');
  } finally { cleanup(h); }
});

test('a lookup is bounded in lines and in the length of each line', () => {
  const h = open();
  try {
    for (let i = 0; i < MEMORY.lines + 3; i += 1) remember(h, `dentist note number ${i} ${'x'.repeat(400)}`, 'ordinary', 1_760_000_000_000 + i);
    const read = h.store.transaction(tx => memoryLookup(tx as unknown as Transaction, 'dentist note'));
    assert.equal(read.lines.length, MEMORY.lines, 'the line bound holds');
    assert.ok(read.lines.every(line => line.length <= MEMORY.lineChars + 20), 'every line is clipped');
    assert.ok(read.total > read.lines.length, 'the total reports what was not shown');
  } finally { cleanup(h); }
});

test('a query matching nothing is honest about it', () => {
  const h = open();
  try {
    remember(h, 'he asked me to remember the dentist on Friday', 'ordinary', 1_760_000_000_000);
    const read = h.store.transaction(tx => memoryLookup(tx as unknown as Transaction, 'quantum chromodynamics'));
    assert.deepEqual(read.lines, []);
    assert.equal(read.text, '');
  } finally { cleanup(h); }
});
