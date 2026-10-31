import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { regressionsDir } from './locate.js';

interface Manifest { fixtures: Record<string, string> }

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

const fixtures = (): string[] => readdirSync(regressionsDir()).filter(name => name.endsWith('.json') && name !== 'provenance-manifest.json');

test('every regression fixture carries its provenance header', () => {
  for (const name of fixtures()) {
    const body = JSON.parse(readFileSync(join(regressionsDir(), name), 'utf8')) as Record<string, unknown>;
    assert.ok(name.length > 0);
    const provenance = body['provenance'];
    assert.equal(typeof provenance, 'object', `${name} has no provenance header`);
    const header = provenance as Record<string, unknown>;
    assert.ok(typeof header['source_finding'] === 'string' && header['source_finding'].length > 0, `${name}: source_finding is required`);
    assert.match(String(header['date']), /^\d{4}-\d{2}-\d{2}$/, `${name}: date is required, as YYYY-MM-DD`);
  }
});

test('an edited fixture is refused unless a ruling line says so', () => {
  const manifest = JSON.parse(readFileSync(join(regressionsDir(), 'provenance-manifest.json'), 'utf8')) as Manifest;
  for (const name of fixtures()) {
    const body = JSON.parse(readFileSync(join(regressionsDir(), name), 'utf8')) as Record<string, unknown>;
    const header = body['provenance'] as Record<string, unknown>;
    const recorded = manifest.fixtures[name];
    assert.notEqual(recorded, undefined, `${name} is not in provenance-manifest.json; add it with its hash`);
    if (sha256(join(regressionsDir(), name)) === recorded) continue;
    assert.equal(typeof header['ruling'], 'string',
      `${name} changed without a provenance.ruling line; a fixture edit needs a ruling, so the manifest hash is not updated`);
  }
});

test('the manifest lists exactly the fixtures on disk', () => {
  const manifest = JSON.parse(readFileSync(join(regressionsDir(), 'provenance-manifest.json'), 'utf8')) as Manifest;
  assert.deepEqual(Object.keys(manifest.fixtures).sort(), fixtures().sort());
});
