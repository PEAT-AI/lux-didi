import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  calendarIdentityValues, classifyIdentity, gmailIdentityValues, helperErrorCode, identityAction, identityMatch,
  identityProofMemo, mattermostIdentityValues, normalizeIdentity, projectIdentity, proveIdentity, refusalCode,
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
  // A closed helper code survives into the proof; free text never becomes a code.
  assert.deepEqual(classifyIdentity({ state: 'refused', reason: 'account_mismatch' }, gmail, [OWNER]), { proven: false, match: null, value: null, code: 'account_mismatch' });
  const coded = classifyIdentity(evidence({ content: [{ type: 'text', text: 'identity_unverified: the refresh returned no id_token' }], isError: true }), gmail, [OWNER]);
  assert.deepEqual(coded, { proven: false, match: null, value: null, code: 'identity_unverified' });
});

test('helperErrorCode reads only a closed code out of an error envelope, never an address or a path', () => {
  assert.equal(helperErrorCode({ content: [{ type: 'text', text: 'account_mismatch: the credential belongs to another account' }], isError: true }), 'account_mismatch');
  assert.equal(helperErrorCode({ content: [{ type: 'text', text: 'credential-missing: LUX_GOOGLE_MCP_TOKEN is not set' }], isError: true }), 'credential_missing');
  assert.equal(helperErrorCode({ content: [{ type: 'text', text: JSON.stringify({ error: 'identity_unverified' }) }], isError: true }), 'identity_unverified');
  assert.equal(helperErrorCode({ content: [{ type: 'text', text: 'provider-failure: http 500' }], isError: true }), undefined);
  assert.equal(helperErrorCode({ content: [{ type: 'text', text: 'refused for owner@example.test with /owner/token.json' }], isError: true }), undefined);
  assert.equal(helperErrorCode({ data: { emailAddress: OWNER } }), undefined);
});

test('identityAction offers a proof, refuses a mismatch and keeps an unproven connector usable', () => {
  assert.equal(identityAction({ proven: true, match: true, value: OWNER }), 'offer');
  assert.equal(identityAction({ proven: true, match: null, value: OWNER }), 'offer');
  assert.equal(identityAction({ proven: true, match: false, value: OTHER }), 'refuse');
  assert.equal(identityAction({ proven: false, match: null, value: null }), 'unproven');
  // A strict source (Google) refuses an unproven identity instead of publishing an unverified read.
  assert.equal(identityAction({ proven: false, match: null, value: null }, true), 'refuse');
  assert.equal(identityAction({ proven: true, match: true, value: OWNER }, true), 'offer');
  assert.equal(identityAction({ proven: true, match: false, value: OTHER }, true), 'refuse');
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

test('the identity memo proves one account once and retries an unproven connector', async () => {
  const once = identityProofMemo();
  let probes = 0;
  const probe = async (): Promise<IdentityProof> => { probes += 1; return { proven: true, match: true, value: OWNER }; };
  assert.deepEqual(await once('google\u0000acc', probe), { proven: true, match: true, value: OWNER });
  assert.deepEqual(await once('google\u0000acc', probe), { proven: true, match: true, value: OWNER });
  assert.equal(probes, 1, 'the second endpoint of one account reuses the first proof');
  await once('google\u0000other', probe);
  assert.equal(probes, 2, 'a different account is proved for itself');
  // Endpoints connect concurrently, so two simultaneous endpoints of one account must share the
  // in-flight probe, not merely its result.
  const [first, second] = await Promise.all([once('google\u0000acc', probe), once('google\u0000acc', probe)]);
  assert.deepEqual([first, second], [{ proven: true, match: true, value: OWNER }, { proven: true, match: true, value: OWNER }]);
  assert.equal(probes, 2, 'a concurrent pair still probes once');
  const unproven = async (): Promise<IdentityProof> => { probes += 1; return { proven: false, match: null, value: null }; };
  await once('mattermost\u0000acc', unproven);
  await once('mattermost\u0000acc', unproven);
  assert.equal(probes, 4, 'an unproven connector proves again on the next connect');
});

// Real refusal wiring: one fake Gmail endpoint, the real host compose path, synthetic identities only.
/**
 * A private web build for this file. The identity fixtures must not share web/dist with host.test.ts,
 * which plants a symlink in assets/ for its own escape test; a parallel startHost then refuses that
 * build and the identity tests fail for a reason that has nothing to do with identity (W9 review round).
 */
function scratchWebRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'didi-identity-web-'));
  writeFileSync(join(root, 'index.html'),
    '<!doctype html><html><head><link rel="stylesheet" href="/assets/app.css"></head><body><script src="/assets/app.js"></script></body></html>');
  for (const name of ['sw.js', 'manifest.webmanifest', 'icon.svg']) writeFileSync(join(root, name), name === 'sw.js' ? '' : '{}');
  mkdirSync(join(root, 'assets'), { recursive: true });
  for (const name of ['app.js', 'app.css']) writeFileSync(join(root, 'assets', name), '');
  return root;
}
const webRoot = scratchWebRoot();

async function gmailHost(email: string) {
  const dir = await mkdtemp(join(tmpdir(), 'didi-identity-'));
  const config = join(dir, 'provider-config');
  await mkdir(config, { mode: 0o700 });
  const tools = ['gmail_get_profile', 'gmail_search_messages', 'gmail_read_message'].map(name => ({ name, inputSchema: { type: 'object', properties: {}, additionalProperties: true } }));
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
  ] }), { mode: 0o600 });
  const host = await startHost({ dataDir: join(dir, 'state'), configDir: config, webRoot, port: 0 });
  const headers = { Authorization: `Bearer ${host.store.adminCredential}`, 'Content-Type': 'application/json', 'X-Didi-Authority-Epoch': host.descriptor.authorityEpoch, 'Idempotency-Key': randomUUID() };
  const status = await fetch(host.descriptor.origin + '/api/v1/tools/status', { headers });
  const reports = (await status.json()).data.endpoints as Array<{ id: string; state: string; reasonCode?: string; identity?: IdentityProof }>;
  const log = await readFile(join(dir, 'state', 'logs', 'host.log'), 'utf8');
  const identityLog = log.trim().split('\n').map(line => JSON.parse(line)).filter(record => record.event === 'connector_identity').map(record => ({ event: record.event, connector: record.connector, proven: record.proven, match: record.match }));
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

test('one proof per connector endpoint per boot, and no diagnostic capture at start', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-identity-once-'));
  const config = join(dir, 'provider-config');
  await mkdir(config, { mode: 0o700 });
  const families = {
    mail: ['gmail_get_profile', 'gmail_search_messages', 'gmail_read_message'],
    calendar: ['calendar_list_calendars', 'calendar_list_events'],
  } as const;
  const calls: string[] = [];
  const reply = (family: keyof typeof families, message: { id?: unknown; method: string; params?: { name?: string } }) => message.id === undefined ? undefined : {
    jsonrpc: '2.0', id: message.id, result: message.method === 'initialize'
      ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } }
      : message.method === 'tools/list' ? { tools: families[family].map(name => ({ name, inputSchema: { type: 'object', properties: {}, additionalProperties: true } })) }
      : message.method === 'tools/call' ? { content: [{ type: 'text', text: JSON.stringify(
        message.params?.name === 'calendar_list_calendars' ? { calendars: [{ id: OWNER, primary: true }] } : { emailAddress: OWNER }) }] }
      : {},
  };
  const endpoint = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const parsed = JSON.parse(Buffer.concat(chunks).toString()) as { id?: unknown; method: string; params?: { name?: string } };
    if (parsed.method === 'tools/call' && parsed.params?.name) calls.push(parsed.params.name);
    const family = (req.url ?? '').includes('calendar') ? 'calendar' : 'mail';
    const response = reply(family, parsed);
    res.writeHead(response ? 200 : 202, { 'content-type': 'application/json' });
    res.end(response ? JSON.stringify(response) : undefined);
  });
  endpoint.listen(0, '127.0.0.1'); await once(endpoint, 'listening');
  const address = endpoint.address(); if (!address || typeof address === 'string') throw new Error('no port');
  // Two endpoints of one Google account: a mailbox and a calendar. H19 proves each endpoint once per
  // boot, because a strict source proves its own tool and seat, and both wire calls also armed a
  // context_absent capture (#479).
  await writeFile(join(config, 'mcp.json'), JSON.stringify({ schemaVersion: 1, grantMode: 'owner-trusted-reads', ownerIdentity: OWNER, endpoints: [
    { id: 'mail', connector: 'google', transport: 'streamable-http', url: `http://127.0.0.1:${address.port}/mail`, account: 'synthetic', resource: 'mail', credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'ordinary' },
    { id: 'calendar', connector: 'google', transport: 'streamable-http', url: `http://127.0.0.1:${address.port}/calendar`, account: 'synthetic', resource: 'calendar', credentialRef: null, enabled: true, allowEgress: true, unknownClass: 'ordinary' },
  ] }), { mode: 0o600 });
  try {
    const host = await startHost({ dataDir: join(dir, 'state'), configDir: config, webRoot, port: 0 });
    try {
      const headers = { Authorization: `Bearer ${host.store.adminCredential}`, 'Content-Type': 'application/json', 'X-Didi-Authority-Epoch': host.descriptor.authorityEpoch, 'Idempotency-Key': randomUUID() };
      const status = await fetch(host.descriptor.origin + '/api/v1/tools/status', { headers });
      const reports = (await status.json()).data.endpoints as Array<{ id: string; state: string; identity?: IdentityProof; reasonCode?: string; error?: string }>;
      assert.deepEqual(reports.map(report => [report.id, report.state, report.identity?.proven, report.identity?.match]), [
        ['mail', 'connected', true, true], ['calendar', 'connected', true, true],
      ], `both endpoints of the account are proven and published: ${JSON.stringify(reports)}`);
      const lines = (await readFile(join(dir, 'state', 'logs', 'host.log'), 'utf8')).split('\n').filter(line => line.length > 0)
        .map(line => JSON.parse(line) as Record<string, unknown>);
      assert.equal(lines.filter(line => line.event === 'connector_identity' && line.connector === 'google').length, 2, 'each endpoint of the account writes its own identity receipt');
      assert.deepEqual(lines.filter(line => line.event === 'tool_diagnostic_capture'), [], 'a start arms no diagnostic capture at all');
      assert.equal(calls.filter(name => name === 'gmail_get_profile').length, 1, 'the mailbox proved its own identity once');
      assert.equal(calls.filter(name => name === 'calendar_list_calendars').length, 1, 'the calendar proved its own identity once');
    } finally { await host.close(); }
  } finally {
    endpoint.closeAllConnections(); await new Promise<void>(done => endpoint.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('a helper identity refusal refuses a strict source with its closed code, never an unverified read', () => {
  // lux-didi #495: an unproven identity is never a published connector, so the helper's refusal
  // cannot become an empty mailbox that reads as "no mail". Neither the address nor a path is spoken.
  const gmail: IdentitySource = { tool: 'gmail_get_profile', args: {}, values: gmailIdentityValues, strict: true };
  const refusal = classifyIdentity(evidence({ content: [{ type: 'text', text: 'account_mismatch: the credential belongs to another account' }], isError: true }), gmail, [OWNER]);
  assert.deepEqual(refusal, { proven: false, match: null, value: null, code: 'account_mismatch' });
  assert.equal(identityAction(refusal, true), 'refuse');
  assert.equal(identityAction(refusal), 'unproven', 'a non-strict source keeps its no-comparison policy');
  assert.equal(refusalCode(refusal), 'account_mismatch');
  assert.equal(JSON.stringify(refusal).includes(OWNER), false, 'no address in the report');
});

test('an unproven strict proof refuses as identity_unverified, and a mismatch keeps its own code', () => {
  const gmail: IdentitySource = { tool: 'gmail_get_profile', args: {}, values: gmailIdentityValues, strict: true };
  const unproven = classifyIdentity(evidence({ messagesTotal: 0 }), gmail, [OWNER]);
  assert.deepEqual(unproven, { proven: false, match: null, value: null });
  assert.equal(identityAction(unproven, true), 'refuse');
  assert.equal(refusalCode(unproven), 'identity_unverified');
  assert.equal(refusalCode({ proven: true, match: false, value: OTHER }), 'identity_mismatch');
});
