#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LUX_TOOLS, LUX_FORBIDDEN_TOOLS, LUX_RETIRED_TOOLS, LUX_PARAMS, LUX_LEGACY_CREATE } from '../server/connectors/lux-names.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const names = [...Object.values(LUX_TOOLS), ...LUX_FORBIDDEN_TOOLS, ...LUX_RETIRED_TOOLS, LUX_LEGACY_CREATE];
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tool = new RegExp(`(?<![\\w])(?:${names.filter(name => name.includes('_')).map(escaped).join('|')})(?![\\w])|['\"]checkpoint['\"]`);
const parameter = new RegExp(`(?<![\\w])(?:${Object.values(LUX_PARAMS).filter(name => name.includes('_')).map(escaped).join('|')})(?![\\w])`);
const parameterFiles = new Set(['server/connectors/lux-knowledge.ts', 'server/adapters/lux-write/client.ts', 'server/tools/vault-write.ts', 'server/tools/lux-note.ts', 'server/tasks/host.ts', 'server/tasks/connectors.ts']);
const failures = [];
function scan(directory, depth = 0) {
  if (depth > 4) throw Error('Source scan exceeded its declared depth');
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'test', '.git', '.cache'].includes(entry.name)) continue;
    const path = join(directory, entry.name), name = relative(root, path);
    if (entry.isDirectory()) { scan(path, depth + 1); continue; }
    if (!entry.isFile() || !/\.(?:ts|mjs|sh)$/.test(entry.name) || name === 'server/connectors/lux-names.ts') continue;
    readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
      if (tool.test(line) || (parameterFiles.has(name) && parameter.test(line))) failures.push(`${name}:${index + 1}`);
    });
  }
}
scan(join(root, 'server'));
scan(join(root, 'scripts'));
if (failures.length) { console.error(`Lux wire identities outside lux-names.ts: ${failures.join(', ')}`); process.exitCode = 1; }
else console.log('Lux wire identity check: no stray source names or host-owned parameter spellings');
