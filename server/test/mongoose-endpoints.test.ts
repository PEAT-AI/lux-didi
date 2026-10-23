import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MONGOOSE_ENDPOINTS, mongooseEndpoint, mongooseEndpointOfUrl, mongooseMetadataUrl, mongooseRefusal } from '../connectors/mongoose.js';
import { mongooseEnvelopeOf } from '../connectors/index.js';
import { runMongooseLogins, mongooseLoginTargets } from '../host/mongoose-login.js';
import { approvalKey, approvalQualifies } from '../adapters/mcp/registry.js';
import { modelToolName, sharedGrantedNames } from '../tools/index.js';

const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

test('the connector carries three endpoints, one place per endpoint', () => {
  assert.deepEqual(MONGOOSE_ENDPOINTS.map(endpoint => endpoint.id), ['mongoose-knowledge', 'mongoose-data', 'mongoose-crm']);
  assert.deepEqual(MONGOOSE_ENDPOINTS.map(endpoint => endpoint.url), [
    'https://mongoose.dev.peat-cloud.com/mcp/knowledge',
    'https://mongoose.dev.peat-cloud.com/mcp/data',
    'https://mongoose.dev.peat-cloud.com/mcp/crm',
  ]);
  assert.deepEqual(MONGOOSE_ENDPOINTS.map(endpoint => endpoint.audience), ['mongoose:knowledge', 'mongoose:data', 'mongoose:crm']);
  for (const endpoint of MONGOOSE_ENDPOINTS) {
    assert.ok(!endpoint.url.endsWith('/'), `${endpoint.id} url has no trailing slash`);
    assert.ok(endpoint.tools.includes('describe_tools') && endpoint.tools.includes('call_tool'), `${endpoint.id} carries the gateway pair`);
    for (const admin of ['provision_user', 'set_user_access', 'list_users', 'list_user_handles', 'get_schema']) {
      assert.ok(!endpoint.tools.includes(admin), `${endpoint.id} carries no admin tool ${admin}`);
    }
    for (const write of ['create_ticket', 'update_knowledge_item', 'create_content', 'set_project']) {
      assert.ok(!endpoint.reads.includes(write), `${endpoint.id} read allowlist excludes ${write}`);
    }
  }
  {
    const knowledge = mongooseEndpoint('mongoose-knowledge');
    assert.ok(knowledge !== undefined);
    assert.ok(!knowledge.reads.includes('run_sql'));
    assert.ok(!knowledge.reads.includes('get_company_crm'));
  }
  assert.equal(mongooseEndpoint('mongoose-knowledge')?.tools.length, 37);
  assert.equal(mongooseEndpoint('mongoose-data')?.tools.length, 23);
  assert.equal(mongooseEndpoint('mongoose-crm')?.tools.length, 5);
  assert.deepEqual(mongooseEndpoint('mongoose-crm')?.reads, ['get_company_crm', 'list_inbound_leads', 'inbound_lead_events']);
  assert.equal(mongooseEndpoint('mongoose-admin'), undefined);
  assert.equal(mongooseEndpointOfUrl('https://mongoose.dev.peat-cloud.com/mcp/data/')?.id, 'mongoose-data');
  assert.equal(mongooseEndpointOfUrl('https://mongoose.dev.peat-cloud.com/mcp'), undefined);
});

test('each endpoint asks for its own path-inserted metadata document', () => {
  assert.equal(mongooseMetadataUrl('https://mongoose.dev.peat-cloud.com/mcp/knowledge'), 'https://mongoose.dev.peat-cloud.com/.well-known/oauth-protected-resource/mcp/knowledge');
  assert.equal(mongooseMetadataUrl('https://mongoose.dev.peat-cloud.com/mcp/crm/'), 'https://mongoose.dev.peat-cloud.com/.well-known/oauth-protected-resource/mcp/crm');
});

test('a denial decodes to a named spoken reason and its teams', () => {
  const notAllowed = mongooseRefusal({ error: { code: 'endpoint_not_allowed', message: 'no', retryable: false, required_teams: ['sales', 'execs'] } });
  assert.equal(notAllowed.code, 'endpoint_not_allowed');
  assert.deepEqual(notAllowed.requiredTeams, ['sales', 'execs']);
  assert.match(notAllowed.message, /sales, execs/);
  assert.equal(notAllowed.retryable, false);
  const lightdash = mongooseRefusal({ error: { code: 'lightdash_not_connected', connect_url: 'https://mongoose.example.test/settings', retryable: false } });
  assert.equal(lightdash.code, 'lightdash_not_connected');
  assert.match(lightdash.message, /Lightdash is not connected/);
  assert.equal(lightdash.connectUrl, 'https://mongoose.example.test/settings');
  assert.deepEqual(lightdash.requiredTeams, []);
  assert.equal(mongooseRefusal({ error: { code: 'tool_not_on_endpoint' } }).code, 'tool_not_on_endpoint');
  assert.equal(mongooseRefusal({ error: { code: 'who_knows' } }).code, 'endpoint_unavailable');
  assert.equal(mongooseRefusal('not json').code, 'endpoint_unavailable');
});

test('a name three endpoints share is model-facing under its endpoint id', () => {
  const connections = MONGOOSE_ENDPOINTS.map(endpoint => ({ toolNames: endpoint.tools }));
  const shared = sharedGrantedNames(connections);
  assert.deepEqual([...shared].sort(), ['call_tool', 'describe_tools']);
  const names = MONGOOSE_ENDPOINTS.flatMap(endpoint => endpoint.tools.map(tool => modelToolName(endpoint.id, tool, shared)));
  assert.equal(new Set(names).size, names.length, 'no model-facing name repeats');
  assert.ok(names.includes('mongoose-data__describe_tools'));
  const unique = sharedGrantedNames([{ toolNames: ['get_company_profile'] }]);
  assert.equal(modelToolName('mongoose-knowledge', 'get_company_profile', unique), 'get_company_profile');
});

test('#530: an approval row qualifies on endpoint id plus the current manifest', () => {
  const endpoint = { id: 'mongoose-data', account: 'owner', resource: 'https://mongoose.example.test/mcp/data' };
  const current = { connector: 'mongoose', endpoint };
  assert.notEqual(approvalKey('mongoose-data', 'a'), approvalKey('mongoose-knowledge', 'a'));
  assert.notEqual(approvalKey('mongoose-data', 'a'), approvalKey('mongoose-data', 'b'));
  assert.equal(approvalQualifies({ enabled: true, connector: 'mongoose', endpoint }, current, true), true);
  // A release split one endpoint into three: the new id qualifies once under trusted reads, never revoked.
  assert.equal(approvalQualifies({ enabled: true, connector: 'mongoose', endpoint: { ...endpoint, id: 'mongoose' } }, current, true), true);
  assert.equal(approvalQualifies({ enabled: true, connector: 'mongoose', endpoint: { ...endpoint, id: 'mongoose' } }, current, false), false);
  assert.equal(approvalQualifies({ enabled: false, connector: 'mongoose', endpoint: { ...endpoint, id: 'mongoose' } }, current, true), false);
  assert.equal(approvalQualifies({ enabled: true, connector: 'google', endpoint: { ...endpoint, id: 'google-mail' } }, current, true), false);
  assert.equal(approvalQualifies(null, current, true), false);
});

test('an endpoint forwards only its own read allowlist', () => {
  assert.ok(mongooseEnvelopeOf('mongoose-data').includes('run_sql'));
  assert.ok(!mongooseEnvelopeOf('mongoose-data').includes('search_mongoose'));
  assert.ok(mongooseEnvelopeOf('mongoose-crm').includes('list_inbound_leads'));
  assert.ok(!mongooseEnvelopeOf('mongoose-crm').includes('run_sql'));
  assert.ok(!mongooseEnvelopeOf('mongoose-knowledge').includes('get_company_crm'));
  assert.ok(mongooseEnvelopeOf('mongoose-knowledge').includes('get_started'));
});

test('three consents, one registration, one record per endpoint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-endpoints-'));
  const registrations: string[] = [];
  const authorizes: URL[] = [];
  const exchanges: URLSearchParams[] = [];
  const targets = mongooseLoginTargets();
  try {
    assert.deepEqual(targets.map(target => target.credentialRef), ['knowledge-mcp', 'data-mcp', 'crm-mcp']);
    const fake: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource/')) return json({ authorization_servers: ['https://mongoose.example.test'] });
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return json({ authorization_endpoint: 'https://mongoose.example.test/oauth/authorize', token_endpoint: 'https://mongoose.example.test/oauth/token', registration_endpoint: 'https://mongoose.example.test/oauth/register' });
      }
      if (url.pathname === '/oauth/register') { registrations.push(String(init?.method)); return json({ client_id: 'client-one' }); }
      if (url.pathname === '/oauth/token') { exchanges.push(new URLSearchParams(String(init?.body ?? ''))); return json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }); }
      throw new Error(`unexpected ${url.href}`);
    };
    const outcomes = await runMongooseLogins({
      configDir: dir, account: 'owner', targets, timeoutMs: 4000,
      fetch: fake,
      showAuthorizationUrl: (value: string) => {
        const url = new URL(value);
        authorizes.push(url);
        const redirect = url.searchParams.get('redirect_uri');
        const state = url.searchParams.get('state');
        setImmediate(() => { void fetch(`${redirect}?code=code-one&state=${state}`).catch(() => undefined); });
      },
    });
    assert.deepEqual(outcomes.map(outcome => outcome.state), ['signed-in', 'signed-in', 'signed-in']);
    assert.equal(registrations.length, 1, 'one dynamic client registration serves all three consents');
    assert.equal(authorizes.length, 3);
    for (const [index, url] of authorizes.entries()) {
      assert.equal(url.searchParams.getAll('resource').length, 1, 'exactly one resource per authorization');
      assert.equal(url.searchParams.get('resource'), targets[index]?.url);
      assert.equal(url.searchParams.get('scope'), 'mcp');
      assert.equal(url.searchParams.get('client_id'), 'client-one');
    }
    assert.deepEqual(readdirSync(dir).filter(name => name.endsWith('.json')).sort(), ['crm-mcp.json', 'data-mcp.json', 'knowledge-mcp.json']);
    assert.equal(exchanges.length, 3);
    for (const exchange of exchanges) assert.equal(exchange.get('resource'), targets[exchanges.indexOf(exchange)]?.url);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
