import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LOOKUP_SOURCES, ResearchLedger, fallbackSelection, normalizeLookups, plainReason, researchSourcesForEndpoint, routedSelection, runResearch,
  type ResearchDeps, type ResearchSourceLog, type SourceKind,
} from '../tools/research.js';
import { safeEvent } from '../host/log.js';
import { beginHandleSession, endHandleSession, exposeHandles, resolveHandle } from '../tools/open-handles.js';
import { DRIVE_CHOOSE_GUIDANCE, shapeDriveFile, shapeDriveSearch } from '../tools/live-shape.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';

const owners = [{ displayName: 'Synthetic Owner', emailAddress: 'owner@example.test' }];
const DECK = { id: 'SyntheticDeckNew01', name: 'Harbour review deck', mimeType: 'application/vnd.google-apps.presentation', modifiedTime: '2026-10-24T08:00:00.000Z', owners, webViewLink: 'https://docs.google.com/presentation/d/SyntheticDeckNew01/edit?usp=drivesdk' };
const OLD = { ...DECK, id: 'SyntheticDeckOld01', name: 'Harbour review deck (old)', modifiedTime: '2026-09-02T08:00:00.000Z', webViewLink: 'https://docs.google.com/presentation/d/SyntheticDeckOld01/edit?usp=drivesdk' };

function result(call: IntentSubCall, text: string): IntentSubResult {
  return { key: call.key, name: call.name, ok: true, text, originalCharacters: text.length, omittedCharacters: 0 };
}

function harness(configured: readonly SourceKind[], answer: (call: IntentSubCall) => string): { deps: ResearchDeps; calls: IntentSubCall[]; sources: ResearchSourceLog[] } {
  const calls: IntentSubCall[] = [];
  const sources: ResearchSourceLog[] = [];
  const deps: ResearchDeps = {
    now: () => 0, configured,
    execute: async subs => { calls.push(...subs); return subs.map(call => result(call, answer(call))); },
    emit: () => {}, log: () => {}, logRouted: () => {}, logSource: event => sources.push(event), logSubcall: () => {},
    ledger: new ResearchLedger(),
  };
  return { deps, calls, sources };
}

test('C-OPEN 2: drive is a lookup source the model may name', () => {
  assert.ok((LOOKUP_SOURCES as readonly string[]).includes('drive'));
  assert.deepEqual(normalizeLookups([{ source: 'drive', query: 'harbour deck' }]), [{ source: 'drive', query: 'harbour deck' }]);
  assert.deepEqual(researchSourcesForEndpoint({ id: 'drive', connector: 'google', state: 'connected' }), ['drive']);
  assert.deepEqual(researchSourcesForEndpoint({ id: 'gmail', connector: 'google', state: 'connected' }), ['mail'], 'gmail stays mail');
});

test('C-OPEN 2: a drive lookup searches file names with the kind he named as a type filter', async () => {
  beginHandleSession('drive-search');
  const h = harness(['knowledge', 'drive'], () => shapeDriveSearch({ files: [DECK] }).text);
  const reply = await runResearch(h.deps, { action: 'start', question: 'open the harbour deck', topic: 'harbour deck', lookups: [{ source: 'drive', query: 'the harbour deck' }] }, new AbortController().signal);
  assert.deepEqual(h.calls.map(call => call.name), ['drive_search_files']);
  assert.equal(h.calls[0]!.args['query'], 'harbour', 'the kind noun and fillers leave the name query');
  assert.deepEqual(h.calls[0]!.args['mime_types'], ['application/vnd.google-apps.presentation', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.ms-powerpoint']);
  assert.equal(h.calls[0]!.args['limit'], 5);
  assert.deepEqual(reply['sources'], { drive: 'ok' });
  const text = JSON.stringify(reply);
  const handle = /open: (L\d+) = Drive: Harbour review deck/.exec(text)?.[1];
  assert.ok(handle, text);
  exposeHandles(text);
  assert.equal(resolveHandle(handle!)?.url, DECK.webViewLink, 'the handle line reached the reply intact');
  assert.equal(h.sources[0]!.source, 'drive');
  assert.deepEqual(safeEvent(h.sources[0]), h.sources[0], 'the host log admits a drive source receipt');
  endHandleSession('drive-search');
});

test('C-OPEN 3: several matches reach the reply as a question with no handle', async () => {
  beginHandleSession('drive-many');
  const h = harness(['drive'], () => shapeDriveSearch({ files: [DECK, OLD] }).text);
  const reply = await runResearch(h.deps, { action: 'start', question: 'open the harbour deck', topic: 'harbour deck', lookups: [{ source: 'drive', query: 'harbour deck' }] }, new AbortController().signal);
  const text = JSON.stringify(reply);
  assert.ok(text.includes(DRIVE_CHOOSE_GUIDANCE), text);
  assert.equal(/open: L\d+/.test(text), false, 'nothing is openable before he picks');
  assert.match(text, /\[id SyntheticDeckOld01\]/);
  endHandleSession('drive-many');
});

test('C-OPEN 3: his pick is read again with drive_get_file by its id, and only that result mints', async () => {
  beginHandleSession('drive-pick');
  const h = harness(['drive'], () => shapeDriveFile({ ...OLD, trashed: false }).text);
  const reply = await runResearch(h.deps, { action: 'start', question: 'the old one', topic: 'harbour deck', lookups: [{ source: 'drive', query: 'id:SyntheticDeckOld01' }] }, new AbortController().signal);
  assert.deepEqual(h.calls.map(call => [call.name, call.args]), [['drive_get_file', { file_id: 'SyntheticDeckOld01' }]]);
  const text = JSON.stringify(reply);
  const handle = /open: (L\d+) = Drive: Harbour review deck \(old\)/.exec(text)?.[1];
  exposeHandles(text);
  assert.equal(resolveHandle(handle!)?.url, OLD.webViewLink);
  endHandleSession('drive-pick');
});

test('C-OPEN 2: with no Drive endpoint the lookup is a typed Drive not available, never a fake result', async () => {
  const h = harness(['knowledge', 'mail'], () => 'must not be read');
  const reply = await runResearch(h.deps, { action: 'start', question: 'open the harbour deck', topic: 'harbour deck', lookups: [{ source: 'drive', query: 'harbour deck' }] }, new AbortController().signal);
  assert.deepEqual(h.calls, [], 'nothing is dispatched');
  assert.deepEqual(reply['sources'], { drive: 'unavailable' });
  assert.deepEqual(reply['findings'], []);
  assert.match(JSON.stringify(reply), /Drive is not set up for me yet/);
  assert.equal(plainReason('drive_not_available'), 'Drive is not set up for me yet');
});

test('C-OPEN 2: an open ask for a deck, doc or sheet routes to Drive only when Drive is configured', () => {
  const routed = routedSelection('open the harbour deck', ['knowledge', 'mail', 'drive']);
  assert.ok(routed?.actions.some(action => action.kind === 'drive_search'), JSON.stringify(routed));
  const without = fallbackSelection('open the harbour deck', ['knowledge', 'mail']);
  assert.equal(without.actions.some(action => action.kind === 'drive_search'), false);
  const notOpen = routedSelection('what did we decide about the harbour deck', ['knowledge', 'drive']);
  assert.equal(notOpen?.actions.some(action => action.kind === 'drive_search') ?? false, false, 'a question about a deck is not a Drive read');
});

test('C-OPEN 4 and 6: the host log admits the two wiring lines with ids only', () => {
  assert.deepEqual(safeEvent({ event: 'google_mcp_path_unsafe', endpointId: 'gmail' }), { event: 'google_mcp_path_unsafe', endpointId: 'gmail' });
  assert.equal(safeEvent({ event: 'google_mcp_path_unsafe', endpointId: 'gmail', command: '/somewhere/google-mcp' }), undefined, 'never the path');
  assert.deepEqual(safeEvent({ event: 'gmail_account_unknown' }), { event: 'gmail_account_unknown' });
  assert.equal(safeEvent({ event: 'gmail_account_unknown', account: 'owner@example.test' }), undefined, 'never an address');
});
