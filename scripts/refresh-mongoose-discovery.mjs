#!/usr/bin/env node
// Usage: node scripts/refresh-mongoose-discovery.mjs --mongoose-version <v> [--origin https://host] [--out path]
// Only unauthenticated GETs of the four public discovery documents: no registration, no authorize, no
// credential or config read, never run by a check. Writes a candidate for review and prints a structural diff.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(root, 'server/test/fixtures/mongoose-discovery.json');
const args = process.argv.slice(2);
const flag = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const origin = flag('--origin') ?? 'https://mongoose.dev.peat-cloud.com';
const version = flag('--mongoose-version');
const out = flag('--out') ?? join(root, 'server/test/fixtures/mongoose-discovery.candidate.json');
if (!version || !/^[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+$/.test(version)) {
  console.error('usage: --mongoose-version <deployed version, read from the Mongoose health page by the reviewer>');
  process.exit(2);
}
const parsed = new URL(origin);
if (parsed.protocol !== 'https:' || parsed.origin !== origin) { console.error('origin must be a bare https origin'); process.exit(2); }

export const DISCOVERY_PATHS = [
  '/.well-known/oauth-protected-resource/mcp/knowledge',
  '/.well-known/oauth-protected-resource/mcp/data',
  '/.well-known/oauth-protected-resource/mcp/crm',
  '/.well-known/oauth-authorization-server',
];

const documents = {};
for (const path of DISCOVERY_PATHS) {
  const response = await fetch(`${origin}${path}`, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'error' });
  if (!response.ok) { console.error(`GET ${path}: HTTP ${response.status}`); process.exit(1); }
  documents[path] = await response.json();
}
const candidate = {
  provenance: {
    source: origin,
    captured: new Date().toISOString().slice(0, 10),
    mongooseVersion: version,
    how: 'scripts/refresh-mongoose-discovery.mjs: unauthenticated public GETs of the four documents below, verbatim',
  },
  documents,
};
writeFileSync(out, `${JSON.stringify(candidate, null, 2)}\n`);

function leaves(value, prefix = '') {
  if (value === null || typeof value !== 'object') return [`${prefix}: ${value === null ? 'null' : typeof value}=${JSON.stringify(value)}`];
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  if (!entries.length) return [`${prefix}: ${Array.isArray(value) ? 'array' : 'object'}=empty`];
  return entries.flatMap(([key, item]) => leaves(item, prefix ? `${prefix}.${key}` : key));
}
let committed;
try { committed = JSON.parse(readFileSync(fixture, 'utf8')).documents; } catch { committed = {}; }
const before = new Set(leaves(committed));
const after = new Set(leaves(documents));
const removed = [...before].filter(line => !after.has(line));
const added = [...after].filter(line => !before.has(line));
for (const line of removed) console.log(`- ${line}`);
for (const line of added) console.log(`+ ${line}`);
console.log(removed.length || added.length ? `candidate differs from the committed fixture: ${out}` : `candidate matches the committed fixture: ${out}`);
