// W-LSUM: the browser-safe Live summary for the page. The operator-only status route refuses a
// cookie principal (403); this sibling route answers the cookie principal (and the operator) with a
// closed whitelist and nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { currentLivePlaybackRate } from '../config/live.js';
import { listenService } from '../http/server.js';
import type { LiveService, LiveStatusPayload } from '../http/live-upgrade.js';

const CONFIGURED: LiveStatusPayload = {
  service: 'live', status: 'configured', provider: 'gemini',
  model: 'gemini-synthetic-live', voice: 'Aoede',
  dataClasses: ['ordinary'], profileIdentity: 'synthetic-profile-identity',
  limits: { sessionMs: 900000, idleMs: 300000 },
};
const DISABLED: LiveStatusPayload = { service: 'live', status: 'disabled' };

function liveStub(payload: LiveStatusPayload): LiveService {
  return {
    enabled: payload.status === 'configured',
    profileIdentity: 'synthetic-profile-identity',
    maxIncomingBytes: 1,
    maxBufferedBytes: 1,
    status: () => payload,
  } as unknown as LiveService;
}

async function fixture(payload: LiveStatusPayload | undefined, ownerProfileStatus: { status: 'default' | 'configured'; displayName: string } = { status: 'configured', displayName: 'Naya' }) {
  const dir = mkdtempSync(join(tmpdir(), 'didi-live-summary-'));
  const store = new Store(dir);
  const service = await listenService({ store, port: 0, ownerProfileStatus, ...(payload ? { live: liveStub(payload) } : {}) });
  const auth = { Authorization: `Bearer ${readFileSync(join(dir, 'admin-credential'), 'utf8').trim()}` };
  return { dir, store, service, auth, async cleanup() { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function pair(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  const bootstrap = await fetch(`${f.service.origin}/api/v1/auth/pairing`, { method: 'POST', headers: { ...f.auth, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(bootstrap.status, 200);
  const { data: { pairingCode } } = await bootstrap.json() as { data: { pairingCode: string } };
  const paired = await fetch(`${f.service.origin}/api/v1/auth/pair`, { method: 'POST', headers: { Origin: f.service.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairingCode }) });
  assert.equal(paired.status, 200);
  return paired.headers.get('set-cookie')!.split(';')[0]!;
}

test('cookie principal gets exactly the whitelisted Live summary', async () => {
  const f = await fixture(CONFIGURED);
  try {
    const cookie = await pair(f);
    const response = await fetch(`${f.service.origin}/api/v1/live/summary`, { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = (await response.json()).data as Record<string, unknown>;
    // PV1: the closed shape also carries the provider the 3l release exposed and the accent selection;
    // P3 adds the pitch-preserving pace the page shows read-only.
    assert.deepEqual(Object.keys(body).sort(), ['accent', 'limits', 'modelId', 'personaName', 'playbackRate', 'profileEnabled', 'provider', 'voice']);
    assert.equal(body.modelId, 'gemini-synthetic-live');
    assert.equal(body.voice, 'Aoede');
    assert.equal(body.playbackRate, currentLivePlaybackRate(), 'the pace the next start plays at, as the process holds it');
    assert.equal(body.personaName, 'Naya');
    assert.deepEqual(body.limits, { sessionMs: 900000, idleMs: 300000 });
    assert.equal(body.profileEnabled, true);
    const wire = JSON.stringify(body);
    for (const forbidden of ['keyReference', 'endpoint', 'apiKey', 'prompt', 'system', 'personaText']) assert.doesNotMatch(wire, new RegExp(forbidden, 'i'));
    assert.equal(Object.keys(body.limits as object).sort().join(','), 'idleMs,sessionMs');
  } finally { await f.cleanup(); }
});

test('the operator bearer also reaches the summary', async () => {
  const f = await fixture(CONFIGURED);
  try {
    const response = await fetch(`${f.service.origin}/api/v1/live/summary`, { headers: f.auth });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()).data as Record<string, unknown>).personaName, 'Naya');
  } finally { await f.cleanup(); }
});

test('unauthenticated summary is 401 and the operator-only status route still refuses the cookie', async () => {
  const f = await fixture(CONFIGURED);
  try {
    assert.equal((await fetch(`${f.service.origin}/api/v1/live/summary`)).status, 401);
    const cookie = await pair(f);
    assert.equal((await fetch(`${f.service.origin}/api/v1/live/status`, { headers: { Cookie: cookie } })).status, 403);
  } finally { await f.cleanup(); }
});

test('a disabled or missing Live profile answers 200 with profileEnabled false and the rest null', async () => {
  for (const payload of [DISABLED, undefined]) {
    const f = await fixture(payload);
    try {
      const cookie = await pair(f);
      const response = await fetch(`${f.service.origin}/api/v1/live/summary`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      const body = (await response.json()).data as Record<string, unknown>;
      // PV1: the summary also names the accent selection, null while no Live profile is running; P3 adds the
      // pace on the same rule, so both fields are null here rather than absent.
      assert.deepEqual(Object.keys(body).sort(), ['accent', 'limits', 'modelId', 'personaName', 'playbackRate', 'profileEnabled', 'provider', 'voice']);
      assert.deepEqual(body, { accent: null, provider: null, modelId: null, voice: null, playbackRate: null, personaName: null, limits: null, profileEnabled: false });
    } finally { await f.cleanup(); }
  }
});

test('the distiller is given the persona name this route reports, from one owner snapshot', () => {
  // The summary prompt takes the assistant name as a parameter (conversation-summary-v2), so both surfaces
  // must read it from the owner profile rather than from a literal.
  const runtime = readFileSync(new URL('../../host/runtime.ts', import.meta.url), 'utf8');
  assert.match(runtime, /assistantName: owner\.snapshot\.displayName/);
  assert.match(runtime, /ownerProfileStatus: \{ status: owner\.status, displayName: owner\.snapshot\.displayName \}/);
});
