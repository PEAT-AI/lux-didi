import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  calendarIdentityValues, classifyIdentity, gmailIdentityValues, identityAction, identityMatch,
  mattermostIdentityValues, normalizeIdentity, projectIdentity, proveIdentity,
  type IdentityProof, type IdentitySource,
} from '../connectors/identity.js';
import { safeEvent } from '../host/log.js';
import { startHost } from '../host/runtime.js';
import type { ConnectorResult } from '../connectors/index.js';

// Every identity below is synthetic; no real account, address or token appears in this file.
const OWNER = 'owner@example.test';
const OTHER = 'other@example.test';

function evidence(decodedResult: unknown): ConnectorResult {
  return { decodedResult, state: 'completed' } as unknown as ConnectorResult;
}

test('identityMatch is exact and case-insensitive, never a substring', () => {
  assert.equal(normalizeIdentity(' Owner@Example.Test '), 'owner@example.test');
  assert.equal(identityMatch([OWNER], ['OWNER@example.TEST']), true);
  assert.equal(identityMatch([OWNER], ['not-owner@example.test']), false);
  assert.equal(identityMatch([OWNER], ['owner@example.test.evil']), false);
  assert.equal(identityMatch([OWNER], []), false);
  assert.equal(identityMatch([], [OWNER]), false);
});

test('each connector maps its own identity field, and only its own', () => {
  assert.deepEqual(gmailIdentityValues({ emailAddress: OWNER, messagesTotal: 3 }), [OWNER]);
  assert.deepEqual(gmailIdentityValues({ emailAddress: 42 }), []);
  assert.deepEqual(calendarIdentityValues({ calendars: [{ id: 'work' }, { id: OWNER, primary: true }] }), [OWNER]);
  assert.deepEqual(calendarIdentityValues({ calendars: [{ id: 'primary' }, { id: 'work' }] }), []);
  assert.deepEqual(mattermostIdentityValues({ username: 'owner', email: OWNER }), ['owner', OWNER]);
  assert.deepEqual(mattermostIdentityValues({}), []);
});

test('classifyIdentity proves a value, matches the owner, and leaves an unset owner at match null', () => {
  const gmail: IdentitySource = { tool: 'gmail_get_profile', args: {}, values: gmailIdentityValues };
  const matched = classifyIdentity(evidence({ emailAddress: OWNER }), gmail, [OWNER]);
  assert.deepEqual(matched, { proven: true, match: true, value: OWNER });
  const mismatched = classifyIdentity(evidence({ emailAddress: OTHER }), gmail, [OWNER]);
  assert.deepEqual(mismatched, { proven: true, match: false, value: OTHER });
  const unset = classifyIdentity(evidence({ emailAddress: OWNER }), gmail, []);
  assert.deepEqual(unset, { proven: true, match: null, value: OWNER });
  const empty = classifyIdentity(evidence({}), gmail, [OWNER]);
  assert.deepEqual(empty, { proven: false, match: null, value: null });
  const refused = classifyIdentity({ state: 'refused', reason: 'source-unavailable' }, gmail, [OWNER]);
  assert.deepEqual(refused, { proven: false, match: null, value: null });
});

test('identityAction offers a proof, refuses a mismatch and keeps an unproven connector usable', () => {
  assert.equal(identityAction({ proven: true, match: true, value: OWNER }), 'offer');
  assert.equal(identityAction({ proven: true, match: null, value: OWNER }), 'offer');
  assert.equal(identityAction({ proven: true, match: false, value: OTHER }), 'refuse');
  assert.equal(identityAction({ proven: false, match: null, value: null }), 'unproven');
});

test('a proof failure (throw or timeout) is unproven, never a refusal', async () => {
  const gmail: IdentitySource = { tool: 'gmail_get_profile', args: {}, values: gmailIdentityValues };
  const thrown = await proveIdentity({ source: gmail, expected: [OWNER], call: async () => { throw new Error('boom'); } });
  assert.deepEqual(thrown, { proven: false, match: null, value: null });
  const timedOut = await proveIdentity({ source: gmail, expected: [OWNER], call: () => new Promise<ConnectorResult>(() => {}), timeoutMs: 5 });
  assert.deepEqual(timedOut, { proven: false, match: null, value: null });
  const proven = await proveIdentity({ source: gmail, expected: [OWNER], call: async () => evidence({ emailAddress: OWNER }) });
  assert.deepEqual(proven, { proven: true, match: true, value: OWNER });
});

test('connector_identity logs booleans and the connector name, never the identity', () => {
  const event = safeEvent({ event: 'connector_identity', connector: 'gmail', proven: true, match: false });
  assert.deepEqual(event, { event: 'connector_identity', connector: 'gmail', proven: true, match: false });
  assert.deepEqual(safeEvent({ event: 'connector_identity', connector: 'mattermost', proven: true, match: null }), { event: 'connector_identity', connector: 'mattermost', proven: true, match: null });
  // A free-text or extra field never crosses the boundary.
  assert.equal(safeEvent({ event: 'connector_identity', connector: 'gmail', proven: true, match: false, identity: OWNER }), undefined);
  assert.equal(safeEvent({ event: 'connector_identity', connector: 'gmail@example.test', proven: true, match: false }), undefined);
  assert.equal(safeEvent({ event: 'connector_identity', connector: 'gmail', proven: 'yes', match: false }), undefined);
  assert.equal(safeEvent({ event: 'connector_identity', connector: 'gmail', proven: true, match: 'no' }), undefined);
});

test('projectIdentity returns a closed shape, dropping anything unvalidated', () => {
  assert.deepEqual(projectIdentity({ proven: true, match: true, value: OWNER }), { proven: true, match: true, value: OWNER });
  assert.deepEqual(projectIdentity({ proven: false, match: null, value: null }), { proven: false, match: null, value: null });
  assert.deepEqual(projectIdentity({ proven: true, match: null, value: 42 }), { proven: true, match: null, value: null });
  assert.equal(projectIdentity({ proven: 'yes', match: true, value: OWNER }), undefined);
  assert.equal(projectIdentity({ proven: true, match: 'yes', value: OWNER }), undefined);
  assert.equal(projectIdentity(OWNER), undefined);
  const long = 'a'.repeat(300);
  assert.deepEqual((projectIdentity({ proven: true, match: true, value: long }) as IdentityProof).value, null);
});

// Real refusal wiring: one fake Gmail endpoint, the real host compose path, synthetic identities only.
const webRoot = resolve(import.meta.dirname, '../../../web/dist');

async function gmailHost(email: string) {
  const dir = await mkdtemp(join(tmpdir(), 'didi-identity-'));
  const config = join(dir, 'provider-config');
  await mkdir(config, { mode: 0o700 });
  const tools = ['gmail_get_profile', 'gmail_list', 'gmail_read'].map(name => ({ name, inputSchema: { type: 'object', properties: {}, additionalProperties: true } }));
  const reply = (message: { id?: unknown; method: string }) => message.id === undefined ? undefined : {
    jsonrpc: '2.0', id: message.id, result: message.method === 'initialize'
      ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } }
      : message.method === 'tools/list' ? { tools }
      : message.method === 'tools/call' ? { content: [{ type: 'text', text: JSON.stringify({ emailAddress: email }) }] } : {},
  };
  const endpoint = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const response = reply(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(response ? 200 : 202, { 'content-type': 'application/json' });
    res.end(response ? JSON.stringify(response) : undefined);
  });
  endpoint.listen(0, '127.0.0.1'); await once(endpoint, 'listening');
  const address = endpoint.address(); if (!address || typeof address === 'string') throw new Error('no port');
  const url = `http://127.0.0.1:${address.port}/gmail`;
  await writeFile(join(config, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', ownerIdentity: OWNER, endpoints: [
    { id: 'gmail', connector: 'google', transport: 'streamable-http', url, account: 'synthetic', resource: 'gmail', credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'ordinary' },
  ] }));
  const host = await startHost({ dataDir: join(dir, 'state'), configDir: config, webRoot, port: 0 });
  const headers = { Authorization: `Bearer ${host.store.adminCredential}`, 'Content-Type': 'application/json', 'X-Didi-Authority-Epoch': host.descriptor.authorityEpoch, 'Idempotency-Key': randomUUID() };
  const status = await fetch(host.descriptor.origin + '/api/v1/tools/status', { headers });
  const reports = (await status.json()).data.endpoints as Array<{ id: string; state: string; reasonCode?: string; identity?: IdentityProof }>;
  const log = await readFile(join(dir, 'state', 'logs', 'host.log'), 'utf8');
  const identityLog = log.trim().split('\n').map(line => JSON.parse(line)).filter(record => record.event === 'connector_identity');
  await host.close();
  endpoint.closeAllConnections(); await new Promise<void>(done => endpoint.close(() => done()));
  await rm(dir, { recursive: true, force: true });
  return { reports, identityLog };
}

test('a proven mismatch refuses the connector and logs the closed identity event', async () => {
  const { reports, identityLog } = await gmailHost(OTHER);
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.state, 'error');
  assert.equal(reports[0]!.reasonCode, 'identity_mismatch');
  assert.deepEqual(reports[0]!.identity, { proven: true, match: false, value: OTHER });
  assert.deepEqual(identityLog, [{ event: 'connector_identity', connector: 'google', proven: true, match: false }]);
});

test('a proven match keeps the connector and logs only the booleans', async () => {
  const { reports, identityLog } = await gmailHost(OWNER.toUpperCase());
  assert.equal(reports[0]!.state, 'connected');
  assert.equal(reports[0]!.reasonCode, undefined);
  assert.deepEqual(reports[0]!.identity, { proven: true, match: true, value: OWNER.toUpperCase() });
  assert.deepEqual(identityLog, [{ event: 'connector_identity', connector: 'google', proven: true, match: true }]);
});
