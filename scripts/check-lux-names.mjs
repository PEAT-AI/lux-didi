#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LUX_TOOLS, LUX_FORBIDDEN_TOOLS, LUX_RETIRED_TOOLS, LUX_PARAMS, LUX_LEGACY_CREATE } from '../server/connectors/lux-names.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const names = [...Object.values(LUX_TOOLS), ...LUX_FORBIDDEN_TOOLS, ...LUX_RETIRED_TOOLS, LUX_LEGACY_CREATE];
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tool = new RegExp(`(?<![\\w])(?:${names.filter(name => name.includes('_')).map(escaped).join('|')})(?![\\w])|['\"]checkpoint['\"]`);
// A lux parameter spelling is a quoted wire key. Host persistence uses the same words as bare SQL
// columns, so a quoted occurrence is the only form that can be a wire identity.
const parameter = new RegExp(`['"](?:${Object.values(LUX_PARAMS).filter(name => name.includes('_')).map(escaped).join('|')})['"]`);
// The files that may spell lux's wire parameter names, plus the two host persistence modules whose own
// column shares one spelling with lux (a SQL column read, never a wire key).
const parameterFiles = new Set(['server/connectors/lux-knowledge.ts', 'server/adapters/lux-write/client.ts', 'server/tools/vault-write.ts', 'server/tools/lux-note.ts', 'server/tasks/host.ts', 'server/tasks/connectors.ts', 'server/live/index.ts', 'server/domain/history-lifecycle.ts']);
const failures = [];
function scan(directory, depth = 0) {
  if (depth > 4) throw Error('Source scan exceeded its declared depth');
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'test', '.git', '.cache'].includes(entry.name)) continue;
    const path = join(directory, entry.name), name = relative(root, path);
    if (entry.isDirectory()) { scan(path, depth + 1); continue; }
    if (!entry.isFile() || !/\.(?:ts|mjs|sh)$/.test(entry.name) || name === 'server/connectors/lux-names.ts') continue;
    readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
      // F2: the allowlist is the set of files that legitimately speak lux's parameter spellings.
      // Everywhere else in server/, scripts/ and web/src a spelling is a stray one.
      if (tool.test(line) || (!parameterFiles.has(name) && parameter.test(line))) failures.push(`${name}:${index + 1}`);
    });
  }
}
scan(join(root, 'server'));
scan(join(root, 'scripts'));
scan(join(root, 'web/src'));
if (failures.length) { console.error(`Lux wire identities outside lux-names.ts: ${failures.join(', ')}`); process.exitCode = 1; }
else console.log('Lux wire identity check: no stray tool names, and no parameter spelling outside the declared wire files');
