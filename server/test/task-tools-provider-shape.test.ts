import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mongoosePublishCatalogue } from '../connectors/mongoose.js';
import { CONNECTOR_DESCRIPTORS } from '../connectors/index.js';
import type { ConnectionPolicy } from '../tools/types.js';
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

test('every native connector declaration uses only schema keywords the provider accepts', () => {
  // #1013: a native connector declaration goes to the provider without passing through createRegistry,
  // so the registry walk above never sees it and every one of them is checked here.
  const policy = {
    schemaVersion: 1, ownerId: 'fixture', connectionId: 'fixture', generation: 1, enabled: true, connector: 'lux-knowledge',
    endpoint: { id: 'fixture', url: 'https://fixture.example.test/mcp', account: 'fixture', resource: 'lux-knowledge:vault', credentialRef: null },
    toolNames: [], schemaDigest: 'fixture',
    sourcePolicy: { id: 'fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
    route: { identity: 'fixture', allowedClasses: ['ordinary'] },
    bounds: { maxQueryChars: 4000, maxSearchLimit: 25, maxGetIds: 10, maxEntityBytes: 100000, maxResultBytes: 100000 },
  } as unknown as ConnectionPolicy;
  const declarations = Object.values(CONNECTOR_DESCRIPTORS).flatMap(descriptor => descriptor.declarations(policy).map(declaration => ({ descriptor: descriptor.id, declaration })));
  assert.ok(declarations.length > 0, 'no native connector declaration was found');
  const offenders = declarations.flatMap(({ descriptor, declaration }) => {
    const found: string[] = [];
    keywords(declaration.parameters, `${descriptor}:${declaration.name}`, found);
    return found;
  });
  assert.deepEqual(offenders, [], 'a native declaration with a rejected keyword makes every helper request fail with HTTP 400');
  const getInsight = declarations.find(item => item.descriptor === 'lux-knowledge' && item.declaration.name === 'get_insight');
  assert.ok(getInsight, 'the native knowledge reader is missing');
  const ids = (getInsight.declaration.parameters['properties'] as Record<string, Record<string, unknown>>)['ids']!;
  assert.equal('uniqueItems' in ids, false, 'a repeated id stays a rule of normalizeGetInsightArgs');
  assert.deepEqual(getInsight.declaration.normalize?.({ ids: [4, 4] })?.args.ids, [4], 'the duplicate is dropped before dispatch');
});

test('read_knowledge refuses duplicate ids without a schema keyword the provider rejects', () => {
  const tool = registryTools().find(item => item.name === 'read_knowledge');
  assert.ok(tool);
  assert.equal(validateArguments(tool, { ids: [4, 4], include_links: false, cursor: null }).ok, false);
  assert.equal(validateArguments(tool, { ids: [4, 5], include_links: false, cursor: null }).ok, true);
});

// The paid smoke must be fail-closed: a configuration that declares company endpoints and a run that
// publishes none of them is a refusal, never a PASS on the static set alone (review finding P1).
const mcp = { mongoosePublishCatalogue, configuredCompanyTools };
const smoke = (await import(resolve(testRoot, '../../scripts/lib/helper-provider-smoke.mjs'))) as {
  providerShapeRefusal(input: { expectedEndpoints: number; published: number; company: number; tools: number; static: number }): string;
  captureStamp(capturePath: string): { path: string; captured: string };
  companyPlan(input: {
    endpoints: string[]; catalogues: Record<string, unknown[]>; ports: Record<string, unknown>;
    credentials: { resolve(reference: string): Promise<string | undefined> };
    mcp: { mongoosePublishCatalogue: typeof mongoosePublishCatalogue; configuredCompanyTools: typeof configuredCompanyTools };
  }): { missing: string[]; definitions: { name: string }[] };
};

test('the provider smoke refuses a registry smaller than the configured one', () => {
  // One configured binding missing is a refusal, never a PASS on a partial registry.
  assert.equal(smoke.providerShapeRefusal({ expectedEndpoints: 3, published: 2, company: 2, tools: 41, static: 39 }), 'company_bindings_unavailable');
  assert.equal(smoke.providerShapeRefusal({ expectedEndpoints: 3, published: 0, company: 0, tools: 39, static: 39 }), 'company_bindings_unavailable');
  assert.equal(smoke.providerShapeRefusal({ expectedEndpoints: 3, published: 3, company: 0, tools: 39, static: 39 }), 'company_bindings_unavailable');
  assert.equal(smoke.providerShapeRefusal({ expectedEndpoints: 3, published: 3, company: 3, tools: 42, static: 39 }), '');
  assert.equal(smoke.providerShapeRefusal({ expectedEndpoints: 0, published: 0, company: 0, tools: 39, static: 39 }), '');
});

// Ruling W1-R5: the smoke reads the app's cached discovery and never touches a sign-in material, so a
// credential port that would throw on refresh is never even consulted while the company set is built.
test('building the company set consults no credential, so no refresh can happen', async () => {
  const capture = JSON.parse(readFileSync(join(testRoot, 'fixtures/mongoose-tools-list-literal.json'), 'utf8')) as Record<string, unknown[]>;
  let touched = 0;
  const credentials = { resolve: async () => { touched += 1; throw new Error('a sign-in material must never be resolved here'); } };
  const plan = smoke.companyPlan({ endpoints: ['knowledge', 'data', 'crm'], catalogues: capture, ports: { authority: {}, execute: async () => ({}) }, credentials, mcp });
  assert.deepEqual(plan.missing, []);
  assert.ok(plan.definitions.some(item => item.name === 'get_company'), 'the cached crm discovery is missing from the company set');
  assert.equal(touched, 0);
});

// Ruling W1-R5: a configured endpoint with no cached discovery fails closed, and it is never skipped.
test('a configured endpoint without cached discovery is named, not skipped', async () => {
  const capture = JSON.parse(readFileSync(join(testRoot, 'fixtures/mongoose-tools-list-literal.json'), 'utf8')) as Record<string, unknown[]>;
  const plan = smoke.companyPlan({ endpoints: ['knowledge', 'frontier'], catalogues: capture, ports: { authority: {}, execute: async () => ({}) }, credentials: { resolve: async () => undefined }, mcp });
  assert.deepEqual(plan.missing, ['frontier']);
  assert.deepEqual(plan.definitions, []);
});

// W1-R7: every run names the capture and its own date, so nobody mistakes it for live discovery.
test('the provider smoke names the committed capture and its capture date', () => {
  const stamp = smoke.captureStamp(join(testRoot, 'fixtures/mongoose-tools-list-literal.json'));
  assert.match(stamp.captured, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(stamp.path, join(testRoot, 'fixtures/mongoose-tools-list-literal.json'));
});
