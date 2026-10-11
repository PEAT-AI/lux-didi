import assert from 'node:assert/strict';
import { chmod, link, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { startHost } from '../host/runtime.js';
import { validateOwnerProfile, PUBLIC_PERSONA, type OwnerProfileSnapshot } from '../prompt/index.js';

type EditorDocument = {
  publicBase: string;
  active: { profile: OwnerProfileSnapshot; revision: string };
  saved: { profile: OwnerProfileSnapshot; revision: string; present: boolean };
  previous: OwnerProfileSnapshot | null;
  pendingActivation: boolean;
};
const editable = (displayName = 'Naya') => ({ displayName,
  style: { text: 'SYNTHETIC character', dataClass: 'private' },
  lore: { text: 'SYNTHETIC about me', dataClass: 'sensitive' } });
const webRoot = resolve(import.meta.dirname, '../../../web/dist');
async function fixture(run: (f: Awaited<ReturnType<typeof openFixture>>) => Promise<void>) {
  const f = await openFixture();
  try { await run(f); } finally { await f.host.close(); await rm(f.dir, { recursive: true, force: true }); }
}
async function openFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'persona-editor-synthetic-'));
  const dataDir = join(dir, 'state'), path = join(dataDir, 'owner-profile.json');
  let fault: string | undefined;
  const config = { dataDir, webRoot, port: 0, ownerProfileTesting: { fault(phase: string) {
    if (phase === fault) throw new Error('synthetic injected failure');
  } } };
  const host = await startHost(config);
  const token = (await readFile(join(dataDir, 'admin-credential'), 'utf8')).trim();
  const request = (method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(host.service.origin + '/api/v1/owner-profile', {
    method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  async function get() {
    const response = await request(); assert.equal(response.status, 200, 'native bearer GET must expose the actual editor document');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return (await response.json() as { data: EditorDocument }).data;
  }
  return { dir, dataDir, path, config, host, token, request, get, failAt: (phase?: string) => { fault = phase; } };
}

test('native owner editor reads public active state and saves protected next-start content without changing active', async () => fixture(async f => {
  const initial = await f.get();
  assert.equal(initial.publicBase, PUBLIC_PERSONA);
  assert.equal(initial.active.profile.displayName, 'Lux Didi');
  assert.equal(initial.saved.present, false); assert.equal(initial.pendingActivation, false); assert.equal(initial.previous, null);
  const response = await f.request('PUT', { expectedRevision: initial.saved.revision, ...editable() });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const saved = await f.get();
  assert.deepEqual(saved.active, initial.active); assert.equal(saved.pendingActivation, true);
  assert.equal(saved.saved.profile.kind, 'profile'); assert.equal(saved.saved.profile.displayName, 'Naya');
  const raw = JSON.parse(await readFile(f.path, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(validateOwnerProfile(raw, f.host.store.assistantId), saved.saved.profile);
  assert.deepEqual(raw['style'], editable().style); assert.deepEqual(raw['lore'], editable().lore);
  assert.equal((await stat(f.dataDir)).mode & 0o777, 0o700); assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.notEqual(saved.saved.revision, initial.saved.revision); assert.equal(saved.previous, null, 'first save has no fictional undo');
  // Reopen is another GET, not activation. Only a new host captures saved content.
  assert.deepEqual((await f.get()).saved, saved.saved);
  await f.host.close();
  const restarted = await startHost(f.config);
  try {
    const token = (await readFile(join(f.dataDir, 'admin-credential'), 'utf8')).trim();
    const next = await fetch(restarted.service.origin + '/api/v1/owner-profile', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(next.status, 200);
    const document = (await next.json() as { data: EditorDocument }).data;
    assert.deepEqual(document.active.profile, saved.saved.profile); assert.equal(document.pendingActivation, false);
    assert.equal(restarted.store.assistantId, f.host.descriptor.assistantId);
  } finally { await restarted.close(); }
}));

test('owner editor requires actual operator bearer even alongside Cookie or Origin', async () => fixture(async f => {
  const before = await f.get();
  const cases: Record<string, string>[] = [
    { Authorization: 'Bearer synthetic-wrong' }, { Authorization: '', Cookie: 'didi_session=synthetic' },
    { Cookie: 'didi_session=synthetic' }, { Origin: f.host.service.origin },
  ];
  for (const headers of cases) {
    for (const method of ['GET', 'PUT']) {
      const response = await f.request(method, method === 'PUT' ? { expectedRevision: before.saved.revision, ...editable() } : undefined, headers);
      assert.ok([401, 403].includes(response.status)); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.ok(!(await response.text()).includes('SYNTHETIC'));
    }
  }
  assert.deepEqual(await f.get(), before);
}));

test('closed editable DTO rejects duplicates, unknown authority, invalid classes, names, limits and JSON before writing', async () => fixture(async f => {
  const before = await f.get(), good = { expectedRevision: before.saved.revision, ...editable() };
  for (const invalid of [
    { ...good, ownerId: 'other' }, { ...good, schemaVersion: 1 }, { ...good, profileVersion: 'caller-version' },
    { ...good, path: '/synthetic/forbidden' }, { ...good, grants: [] }, { ...good, provider: 'forbidden' },
    { ...good, displayName: ' Naya ' }, { ...good, displayName: 'x'.repeat(81) }, { ...good, displayName: '\u0000' },
    { ...good, style: { text: 'x'.repeat(4097), dataClass: 'private' } },
    { ...good, lore: { text: 'synthetic', dataClass: 'unknown' } },
    { ...good, style: { ...good.style, arbitrary: true } },
    JSON.stringify(good).replace('"displayName":"Naya"', '"displayName":"Naya","displayName":"Other"'), '{',
  ]) {
    const response = await f.request('PUT', invalid); assert.equal(response.status, 400);
    assert.ok(!(await response.text()).includes('SYNTHETIC')); assert.deepEqual(await f.get(), before);
  }
  await assert.rejects(stat(f.path), { code: 'ENOENT' });
}));

test('serialized revision saves conflict on stale or external state, and previous good restores through the same PUT', async () => fixture(async f => {
  const a = await f.get(), b = await f.get();
  assert.equal((await f.request('PUT', { expectedRevision: a.saved.revision, ...editable('First') })).status, 200);
  assert.equal((await f.request('PUT', { expectedRevision: b.saved.revision, ...editable('Stale') })).status, 409);
  const first = await f.get();
  assert.equal((await f.request('PUT', { expectedRevision: first.saved.revision, ...editable('Second') })).status, 200);
  const second = await f.get(); assert.deepEqual(second.previous, first.saved.profile);
  const previous = second.previous; assert.ok(previous?.kind === 'profile');
  assert.equal((await f.request('PUT', { expectedRevision: second.saved.revision, displayName: previous.displayName, style: previous.style, lore: previous.lore })).status, 200);
  assert.equal((await f.get()).saved.profile.displayName, 'First');
  const read = await f.get(), raw = await readFile(f.path, 'utf8');
  // Same content, different protected file identity is still an external replacement.
  const external = join(f.dataDir, 'synthetic-external.json'); await writeFile(external, raw, { mode: 0o600 }); await rename(external, f.path);
  assert.equal((await f.request('PUT', { expectedRevision: read.saved.revision, ...editable('External stale') })).status, 409);
  assert.equal(await readFile(f.path, 'utf8'), raw);
  const latest = await f.get();
  const races = await Promise.all(['Race A', 'Race B'].map(displayName => f.request('PUT', { expectedRevision: latest.saved.revision, ...editable(displayName) })));
  assert.deepEqual(races.map(r => r.status).sort(), [200, 409]);
}));

test('unsafe existing file boundaries fail closed and never disclose private text or silently replace the file', async () => fixture(async f => {
  const absent = await f.get();
  assert.equal((await f.request('PUT', { expectedRevision: absent.saved.revision, ...editable() })).status, 200);
  const raw = await readFile(f.path, 'utf8');
  await chmod(f.path, 0o644);
  let response = await f.request(); assert.equal(response.status, 400); assert.ok(!(await response.text()).includes('SYNTHETIC'));
  response = await f.request('PUT', { expectedRevision: absent.saved.revision, ...editable('Unsafe') }); assert.equal(response.status, 400);
  assert.equal(await readFile(f.path, 'utf8'), raw); await chmod(f.path, 0o600);
  const other = join(f.dataDir, 'synthetic-link.json'); await link(f.path, other);
  assert.equal((await f.request()).status, 400); await rm(other);
  await rename(f.path, other); await symlink(other, f.path);
  assert.equal((await f.request()).status, 400); assert.equal(await readFile(other, 'utf8'), raw);
}));

test('pre-replacement fault stages leave current valid and remove only owned temporaries', async () => fixture(async f => {
  const absent = await f.get();
  assert.equal((await f.request('PUT', { expectedRevision: absent.saved.revision, ...editable('Good') })).status, 200);
  const raw = await readFile(f.path, 'utf8');
  const unrelated = join(f.dataDir, 'unrelated.tmp'); await writeFile(unrelated, 'synthetic unrelated', { mode: 0o600 });
  for (const phase of ['validation', 'temp', 'write', 'file-sync', 'backup', 'rename']) {
    const current = await f.get(); f.failAt(phase);
    const response = await f.request('PUT', { expectedRevision: current.saved.revision, ...editable('Never replaced') });
    assert.equal(response.status, 500, phase); assert.equal(await readFile(f.path, 'utf8'), raw, phase);
    f.failAt(); assert.deepEqual((await readdir(f.dataDir)).filter(n => n.endsWith('.tmp')), ['unrelated.tmp']);
    assert.equal(await readFile(unrelated, 'utf8'), 'synthetic unrelated');
  }
}));

test('post-replacement directory-sync failure reports uncertain durability, readback exposes actual saved state without activating', async () => fixture(async f => {
  const before = await f.get(); f.failAt('directory-sync');
  const response = await f.request('PUT', { expectedRevision: before.saved.revision, ...editable('Uncertain') });
  assert.equal(response.status, 503);
  const failure = await response.json() as { error: { code: string } }; assert.equal(failure.error.code, 'PROFILE_DURABILITY_UNCERTAIN');
  f.failAt(); const actual = await f.get(); assert.equal(actual.saved.profile.displayName, 'Uncertain');
  assert.deepEqual(actual.active, before.active); assert.equal(actual.pendingActivation, true);
  assert.deepEqual((await readdir(f.dataDir)).filter(n => n.endsWith('.tmp')), []);
}));
