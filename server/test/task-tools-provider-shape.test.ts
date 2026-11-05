import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mongoosePublishCatalogue } from '../connectors/mongoose.js';
import { FakeAuthority } from '../tasks/authority.js';
import { configuredCompanyTools, type BoundConnector } from '../tasks/connectors.js';
import { createRegistry, validateArguments, type TaskTool } from '../tasks/tools.js';

// The keywords OpenAI strict mode accepted for this release's own tool set. The 2026-11-05 probe
// (reports/didi-1013-1105/PROBE.md) sent all 39 static declarations, which carry every keyword below
// except default and anyOf, and got 200 completed, and 400 for the request carrying uniqueItems.
// default and anyOf appear only in the configured company definitions, which the probe sent empty, so
// scripts/check-helper-provider.sh proves the whole set (company tools included) through the real
// provider: its PASS line is the evidence a keyword added here needs.
const PROVIDER_KEYWORDS = new Set([
  'type', 'description', 'enum', 'properties', 'required', 'items', 'additionalProperties',
  'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'default',
  'anyOf',
]);

const testRoot = process.env.DIDI_TEST_SOURCE_ROOT ?? fileURLToPath(new URL('.', import.meta.url));
const catalogue = JSON.parse(readFileSync(join(testRoot, 'fixtures/mongoose-tools-list-literal.json'), 'utf8')) as
  Record<'knowledge' | 'data' | 'crm', { name: string; description: string; inputSchema: Record<string, unknown> }[]>;

/** The shipped company declarations, published the way the installed connectors publish them. */
function companyBindings(): BoundConnector[] {
  const policy: BoundConnector['policy'] = {
    schemaVersion: 1, ownerId: 'fixture', connectionId: 'fixture', generation: 1, enabled: true, connector: 'mongoose',
    endpoint: { id: 'fixture', url: 'https://fixture.example.test/mcp', account: 'fixture', resource: 'mongoose:knowledge', credentialRef: null },
    toolNames: ['search', 'read', 'get_company'], schemaDigest: 'fixture',
    sourcePolicy: { id: 'fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
    route: { identity: 'fixture', allowedClasses: ['ordinary'] },
    bounds: { maxQueryChars: 4000, maxSearchLimit: 25, maxGetIds: 10, maxEntityBytes: 100000, maxResultBytes: 100000 },
  };
  return (['knowledge', 'data', 'crm'] as const).map(endpoint => {
    const id = `synthetic-${endpoint}`;
    mongoosePublishCatalogue(id, catalogue[endpoint]);
    return {
      connector: 'mongoose', policy: { ...policy, connectionId: id, endpoint: { ...policy.endpoint, id, resource: `mongoose:${endpoint}` } },
      reader: { call: async () => ({ state: 'completed', decodedResult: {} }) },
    } as unknown as BoundConnector;
  });
}

function keywords(value: unknown, path: string, found: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (!PROVIDER_KEYWORDS.has(key)) found.push(`${path}.${key}`);
    if (key === 'properties' && child && typeof child === 'object') {
      for (const [field, schema] of Object.entries(child as Record<string, unknown>)) keywords(schema, `${path}.properties.${field}`, found);
    } else if (key === 'items') keywords(child, `${path}.items`, found);
  }
}

function registryTools(): TaskTool[] {
  const registry = createRegistry({ authority: new FakeAuthority(), execute: async () => ({ status: 'ok', text: '', references: [], next_cursor: null, coverage: '', repair: null } as never) }, configuredCompanyTools(companyBindings()));
  return [...registry.values()];
}

test('every declared task tool uses only schema keywords the provider accepts', () => {
  const tools = registryTools();
  // The company tools ride the same request as the static ones, so the count covers both.
  assert.ok(tools.length > 39, `expected the static and company tools together, got ${tools.length}`);
  assert.ok(tools.some(tool => tool.name === 'get_company'), 'the shipped company declaration is missing');
  const offenders = tools.flatMap(tool => {
    const found: string[] = [];
    keywords(tool.parameters, `${tool.name}`, found);
    return found;
  });
  assert.deepEqual(offenders, [], 'a rejected schema keyword would make every helper request fail with HTTP 400');
});

test('read_knowledge refuses duplicate ids without a schema keyword the provider rejects', () => {
  const tool = registryTools().find(item => item.name === 'read_knowledge');
  assert.ok(tool);
  assert.equal(validateArguments(tool, { ids: [4, 4], include_links: false, cursor: null }).ok, false);
  assert.equal(validateArguments(tool, { ids: [4, 5], include_links: false, cursor: null }).ok, true);
});

// The paid smoke must be fail-closed: a configuration that declares company endpoints and a run that
// publishes none of them is a refusal, never a PASS on the static set alone (review finding P1).
const smoke = (await import(resolve(testRoot, '../../scripts/lib/helper-provider-smoke.mjs'))) as {
  providerShapeRefusal(input: { expected: number; published: number; company: number; tools: number; static: number }): string;
};

test('the provider smoke refuses a configured company set that did not publish', () => {
  assert.equal(smoke.providerShapeRefusal({ expected: 3, published: 0, company: 0, tools: 39, static: 39 }), 'company-unpublished');
  assert.equal(smoke.providerShapeRefusal({ expected: 3, published: 3, company: 0, tools: 39, static: 39 }), 'company-unpublished');
  assert.equal(smoke.providerShapeRefusal({ expected: 3, published: 3, company: 3, tools: 39, static: 39 }), 'company-unpublished');
  assert.equal(smoke.providerShapeRefusal({ expected: 3, published: 3, company: 3, tools: 42, static: 39 }), '');
  assert.equal(smoke.providerShapeRefusal({ expected: 0, published: 0, company: 0, tools: 39, static: 39 }), '');
});
