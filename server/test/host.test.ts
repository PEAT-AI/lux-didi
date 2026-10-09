import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Store } from '../runtime/store.js';
import { listenService } from '../http/server.js';

const webRoot = resolve(import.meta.dirname, '../../../web/dist');

test('host serves the accepted build with security policy, never API or private files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-host-static-'));
  const store = new Store(dir);
  const service = await listenService({ store, port: 0, webRoot });
  try {
    const response = await fetch(service.origin);
    assert.equal(response.status, 200, 'the real shell must be available without API authentication');
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    const html = await response.text();
    assert.equal(html, await readFile(join(webRoot, 'index.html'), 'utf8'));
    assert.equal((service.server.address() as { address: string }).address, '127.0.0.1');
    const head = await fetch(service.origin, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const assetPaths = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(match => match[1]!);
    assert.ok(assetPaths.length >= 2);
    for (const path of assetPaths) {
      const asset = await fetch(service.origin + path);
      assert.equal(asset.status, 200, path);
      assert.ok((await asset.arrayBuffer()).byteLength > 0, path);
    }
    assert.equal((await fetch(service.origin + '/health')).status, 200);
    const policy = JSON.parse(await readFile(resolve(webRoot, '../security-headers.json'), 'utf8')) as Record<string, string>;
    for (const [name, value] of Object.entries(policy)) assert.equal(response.headers.get(name), value);
    for (const path of ['/manifest.webmanifest', '/icon.svg', '/sw.js']) {
      assert.equal((await fetch(service.origin + path)).status, 200, path);
    }
    for (const path of ['/api/v1/not-real', '/api', '/server/runtime/store.ts', '/.env', '/admin.token', '/%2e%2e%2findex.html', '/%252e%252e%252findex.html', '/assets/%5c..%5csecret']) {
      const denied = await fetch(service.origin + path);
      assert.ok(denied.status >= 400, path);
      assert.doesNotMatch(denied.headers.get('content-type') ?? '', /text\/html/, path);
    }
    assert.equal((await fetch(service.origin, { headers: { Host: 'evil.invalid' } })).status, 403);
    assert.equal((await fetch(service.origin, { headers: { Origin: 'http://evil.invalid' } })).status, 403);
    const status = await fetch(service.origin + '/api/v1/status');
    assert.equal(status.status, 401, 'static shell must not relax API auth');
    const pairing = await fetch(service.origin + '/api/v1/auth/pairing', { method: 'POST', headers: { Authorization: `Bearer ${store.adminCredential}`, 'Content-Type': 'application/json' }, body: '{}' });
    const { data: { pairingCode } } = await pairing.json();
    const paired = await fetch(service.origin + '/api/v1/auth/pair', { method: 'POST', headers: { Origin: service.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairingCode }) });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get('set-cookie')!.split(';')[0]!;
    const { data: { csrfToken } } = await paired.json();
    const browserStatus = await fetch(service.origin + '/api/v1/status', { headers: { Cookie: cookie } });
    assert.equal(browserStatus.status, 200);
    assert.equal((await browserStatus.json()).data.capabilities.domain, false);
    for (const extra of [{}, { 'X-Didi-CSRF': csrfToken }, { Origin: service.origin }]) {
      const denied = await fetch(service.origin + '/api/v1/auth/logout', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', ...extra }, body: '{}' });
      assert.equal(denied.status, 403, 'static-enabled service must retain browser Origin/CSRF checks');
    }
    assert.equal((await fetch(service.origin + '/api/v1/auth/logout', { method: 'POST', headers: { Cookie: cookie, Origin: service.origin, 'X-Didi-CSRF': csrfToken, 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
  } finally { await service.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('host refuses incomplete builds before listening and denies a symlink escape', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-host-invalid-'));
  const store = new Store(join(dir, 'state'));
  try {
    for (const root of [join(dir, 'missing'), dir]) {
      await assert.rejects(async () => {
        const unexpected = await listenService({ store, port: 0, webRoot: root });
        await unexpected.close();
      }, /web|build|ENOENT/i);
    }
    const privateFile = join(dir, 'private.txt');
    await writeFile(privateFile, 'private sentinel');
    const escape = join(webRoot, 'assets/host-escape.js');
    await symlink(privateFile, escape);
    try {
      const service = await listenService({ store, port: 0, webRoot });
      try {
        const denied = await fetch(service.origin + '/assets/host-escape.js');
        assert.ok(denied.status >= 400);
        assert.doesNotMatch(await denied.text(), /private sentinel/);
      } finally { await service.close(); }
    } finally { await rm(escape, { force: true }); }
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
