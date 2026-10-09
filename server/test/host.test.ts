import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Store } from '../runtime/store.js';
import { listenService, type ServiceOptions } from '../http/server.js';

const webRoot = resolve(import.meta.dirname, '../../../web/dist');

test('host serves the accepted build with security policy, never API or private files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-host-static-'));
  const store = new Store(dir);
  // Cast allows this regression to execute before the optional seam is implemented.
  const service = await listenService({ store, port: 0, webRoot } as ServiceOptions & { webRoot: string });
  try {
    const response = await fetch(service.origin);
    assert.equal(response.status, 200, 'the real shell must be available without API authentication');
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(await response.text(), await readFile(join(webRoot, 'index.html'), 'utf8'));
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
  } finally { await service.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('host refuses incomplete builds before listening and denies a symlink escape', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'didi-host-invalid-'));
  const store = new Store(join(dir, 'state'));
  try {
    for (const root of [join(dir, 'missing'), dir]) {
      await assert.rejects(async () => {
        const unexpected = await listenService({ store, port: 0, webRoot: root } as ServiceOptions & { webRoot: string });
        await unexpected.close();
      }, /web|build|ENOENT/i);
    }
    const privateFile = join(dir, 'private.txt');
    await writeFile(privateFile, 'private sentinel');
    const escape = join(webRoot, 'assets/host-escape.txt');
    await symlink(privateFile, escape);
    try {
      const service = await listenService({ store, port: 0, webRoot } as ServiceOptions & { webRoot: string });
      try {
        const denied = await fetch(service.origin + '/assets/host-escape.txt');
        assert.ok(denied.status >= 400);
        assert.doesNotMatch(await denied.text(), /private sentinel/);
      } finally { await service.close(); }
    } finally { await rm(escape, { force: true }); }
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
