import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ToolDefinition } from '../adapters/mcp/port.js';
import { mongoosePublishCatalogue, mongoosePublishedTool } from '../connectors/mongoose.js';
import { recordPublishedCatalogue } from '../host/mcp.js';
import { Store, readPublishedCatalogues } from '../runtime/store.js';

// W9: the declarations published at the last live discovery are kept in the store, so the paid helper
// smoke proves the set the app really sends instead of a committed capture. The record is one bounded
// row per configured endpoint, replaced in place; a schema the connector refuses is never recorded.
const testRoot = process.env.DIDI_TEST_SOURCE_ROOT ?? fileURLToPath(new URL('.', import.meta.url));
const fixturePath = join(testRoot, 'fixtures/mongoose-tools-list-literal.json');
type CapturedTool = { name: string; inputSchema: Record<string, unknown> };
const capture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<'knowledge' | 'data' | 'crm', CapturedTool[]>;
const CAPTURE_DATE = '2026-10-27';

type CatalogueEntry = { name: string; description?: string; parameters?: Record<string, unknown>; inputSchema?: Record<string, unknown> };
type RecordRow = { endpointId: string; resource: string; discoveredAt: number; schemaDigest: string; declarations: string };
type Smoke = {
  captureStamp(capturePath: string): { path: string; captured: string };
  storeCatalogue(rows: RecordRow[]): { catalogues: Record<string, CatalogueEntry[]>; discoveredAt: number };
  declarationSource(input: {
    record: { catalogues: Record<string, CatalogueEntry[]>; discoveredAt: number };
    capture: Record<string, CapturedTool[]>;
    stamp: { path: string; captured: string };
  }): { kind: 'store' | 'capture'; line: string; catalogues: Record<string, CatalogueEntry[]> };
  companyPlan(input: {
    endpoints: string[]; catalogues: Record<string, CapturedTool[]>; credentials: { resolve(reference: string): Promise<string | undefined> };
    ports: Record<string, unknown>; mcp: Record<string, unknown>;
  }): { missing: string[]; definitions: CatalogueEntry[]; publishedEndpoints: number };
};
const smoke = (await import(resolve(testRoot, '../../scripts/lib/helper-provider-smoke.mjs'))) as Smoke;

function tool(name: string, description = `Mongoose tool ${name}`): ToolDefinition {
  return {
    name, description,
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  } as unknown as ToolDefinition;
}

test('the published catalogue round trips through the store, one row per endpoint', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discovery-record-'));
  const store = new Store(directory);
  try {
    const now = 1793900000000;
    const tools = [tool('search'), tool('get')];
    mongoosePublishCatalogue('cached-knowledge', tools);
    assert.equal(recordPublishedCatalogue(store, { endpointId: 'cached-knowledge', resource: 'mongoose:knowledge' }, tools, now), true);
    mongoosePublishCatalogue('cached-data', [tool('query')]);
    assert.equal(recordPublishedCatalogue(store, { endpointId: 'cached-data', resource: 'mongoose:data' }, [tool('query')], now + 1000), true);

    const rows = readPublishedCatalogues(join(directory, 'state.sqlite'));
    assert.deepEqual(rows.map(row => row.endpointId), ['cached-data', 'cached-knowledge']);
    const knowledge = rows[1]!;
    assert.equal(knowledge.resource, 'mongoose:knowledge');
    assert.equal(knowledge.discoveredAt, now);
    assert.match(knowledge.schemaDigest, /^[0-9a-f]{64}$/);
    const declarations = JSON.parse(knowledge.declarations) as CatalogueEntry[];
    assert.deepEqual(declarations.map(declaration => declaration.name), ['search', 'get']);
    assert.equal(declarations[0]!.description, 'Mongoose tool search');
    assert.deepEqual(Object.keys(declarations[0]!.parameters ?? {}).sort(), ['additionalProperties', 'properties', 'required', 'type']);

    // Replace, never append: a second discovery of the same endpoint leaves one row and a new digest.
    const next = [tool('search')];
    mongoosePublishCatalogue('cached-knowledge', next);
    assert.equal(recordPublishedCatalogue(store, { endpointId: 'cached-knowledge', resource: 'mongoose:knowledge' }, next, now + 2000), true);
    const replaced = readPublishedCatalogues(join(directory, 'state.sqlite'));
    assert.equal(replaced.length, 2);
    const again = replaced.find(row => row.endpointId === 'cached-knowledge')!;
    assert.notEqual(again.schemaDigest, knowledge.schemaDigest);
    assert.deepEqual((JSON.parse(again.declarations) as CatalogueEntry[]).map(declaration => declaration.name), ['search']);
    assert.equal(again.discoveredAt, now + 2000);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a refused schema is never recorded, and an oversized catalogue leaves no stale row', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discovery-record-'));
  const store = new Store(directory);
  try {
    const refused: string[] = [];
    const broken = { name: 'broken', description: 'Broken', inputSchema: { type: 'object', properties: { at: { type: 'nonsense' } } } } as unknown as ToolDefinition;
    const tools = [tool('search'), broken];
    mongoosePublishCatalogue('cached-knowledge', tools, name => refused.push(name));
    assert.deepEqual(refused, ['broken']);
    assert.equal(recordPublishedCatalogue(store, { endpointId: 'cached-knowledge', resource: 'mongoose:knowledge' }, tools, 1793900000000), true);
    let rows = readPublishedCatalogues(join(directory, 'state.sqlite'));
    assert.deepEqual((JSON.parse(rows[0]!.declarations) as CatalogueEntry[]).map(declaration => declaration.name), ['search']);

    // A declaration set past the bound is not persisted at all: the previous row must not stand in for it.
    const huge = [tool('search', 'x'.repeat(600 * 1024))];
    mongoosePublishCatalogue('cached-knowledge', huge);
    assert.equal(recordPublishedCatalogue(store, { endpointId: 'cached-knowledge', resource: 'mongoose:knowledge' }, huge, 1793900001000), false);
    rows = readPublishedCatalogues(join(directory, 'state.sqlite'));
    assert.deepEqual(rows, []);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a store with no discovery table, or no store at all, reads as no record', () => {
  const directory = mkdtempSync(join(tmpdir(), 'discovery-record-'));
  try {
    assert.deepEqual(readPublishedCatalogues(join(directory, 'absent.sqlite')), []);
    const db = new DatabaseSync(join(directory, 'state.sqlite'));
    db.exec('CREATE TABLE unrelated(id TEXT PRIMARY KEY)');
    db.close();
    assert.deepEqual(readPublishedCatalogues(join(directory, 'state.sqlite')), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the smoke reads the persisted record first and warns only on the capture fallback', () => {
  const rows: RecordRow[] = [{
    endpointId: 'cached-knowledge', resource: 'mongoose:knowledge', discoveredAt: 1793900000000, schemaDigest: 'a'.repeat(64),
    declarations: JSON.stringify([{ name: 'search', description: 'Search the knowledge base.', parameters: { type: 'object', properties: { query: { type: 'string' } } } }]),
  }];
  const record = smoke.storeCatalogue(rows);
  assert.deepEqual(Object.keys(record.catalogues), ['knowledge']);
  assert.equal(record.catalogues['knowledge']![0]!.name, 'search');
  assert.equal(record.catalogues['knowledge']![0]!.description, 'Search the knowledge base.');
  assert.equal(record.discoveredAt, 1793900000000);
  const stamp = smoke.captureStamp(fixturePath);
  assert.equal(stamp.captured, CAPTURE_DATE);

  const fromStore = smoke.declarationSource({ record, capture, stamp });
  assert.equal(fromStore.kind, 'store');
  assert.equal(fromStore.line, `HELPER-PROVIDER source=store discovered_at=${new Date(1793900000000).toISOString()} endpoints=1`);
  assert.doesNotMatch(fromStore.line, /WARN/);
  assert.deepEqual(Object.keys(fromStore.catalogues), ['knowledge']);

  const fromCapture = smoke.declarationSource({ record: smoke.storeCatalogue([]), capture, stamp });
  assert.equal(fromCapture.kind, 'capture');
  assert.equal(fromCapture.line, `HELPER-PROVIDER WARN source=capture file=${fixturePath} captured=${CAPTURE_DATE} live-parity=not-claimed`);
  for (const name of ['knowledge', 'data', 'crm']) assert.ok(Array.isArray(fromCapture.catalogues[name]), `${name} is a captured endpoint`);
});

test('the committed capture still publishes every one of its tool schemas', () => {
  const stamp = smoke.captureStamp(fixturePath);
  const source = smoke.declarationSource({ record: smoke.storeCatalogue([]), capture, stamp });
  let declared = 0;
  for (const endpoint of ['knowledge', 'data', 'crm']) {
    const tools = source.catalogues[endpoint]!;
    const definitions = tools.map(entry => ({ name: entry.name, description: entry.description, inputSchema: entry.inputSchema }) as unknown as ToolDefinition);
    const refused: string[] = [];
    mongoosePublishCatalogue(`fixture-${endpoint}`, definitions, name => refused.push(name));
    assert.deepEqual(refused, [], `${endpoint} keeps every captured schema`);
    for (const definition of definitions) assert.ok(mongoosePublishedTool(`fixture-${endpoint}`, definition.name), `${definition.name} publishes`);
    declared += tools.length;
  }
  const expected = capture.knowledge.length + capture.data.length + capture.crm.length;
  assert.equal(declared, expected);
  assert.ok(declared > 0);
});
