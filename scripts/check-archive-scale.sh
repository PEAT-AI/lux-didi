#!/usr/bin/env bash
# Synthetic, sequential owner-cost assessment; no production store or performance gate.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
out="$(mktemp -d "${TMPDIR:-/tmp}/didi-archive-scale.XXXXXX")"
trap 'rm -rf "$out"' EXIT
export ARCHIVE_SCALE_SOURCE_SHA="$(git --no-pager rev-parse HEAD)"
export ARCHIVE_SCALE_DIST="$out/dist"
# The measurement JSON is retained evidence; set ARCHIVE_SCALE_OUTPUT to keep it somewhere permanent.
export ARCHIVE_SCALE_OUTPUT="${ARCHIVE_SCALE_OUTPUT:-${TMPDIR:-/tmp}/didi-archive-scale-measurements-$ARCHIVE_SCALE_SOURCE_SHA.json}"
# Never turn a setup failure into an apparently empty/green benchmark.
node --input-type=module - "$root" "$out" <<'NODE'
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const [root, out] = process.argv.slice(2);
assert.ok(Number(process.versions.node.split('.')[0]) >= 26, 'archive-scale requires Node >=26');
const deadline = Date.now() + 300000;
function run(command, args, cwd = root, capture = false) {
  const remaining = deadline - Date.now();
  assert.ok(remaining > 0, 'archive-scale five-minute producer budget exhausted');
  const result = spawnSync(command, args, { cwd, env: process.env, encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit', timeout: remaining, maxBuffer: 1024 * 1024 });
  if (capture) { process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? ''); }
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed (signal=${result.signal})`);
  return result.stdout;
}
let deps = process.env.DIDI_TYPESCRIPT_ROOT ?? join(root, 'server/node_modules');
if (!existsSync(join(deps, 'typescript/bin/tsc')) || !existsSync(join(deps, '@types/node'))) {
  // Locked dependencies in this producer's isolated yard; no sibling/global mutations.
  const yard = join(out, 'dependencies'); mkdirSync(yard);
  for (const file of ['package.json', 'package-lock.json']) cpSync(join(root, 'server', file), join(yard, file));
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], yard);
  deps = join(yard, 'node_modules');
}
// The staged tree resolves its bare package imports (the MCP client the connector registry builds)
// through the same node_modules the repository itself compiles against.
symlinkSync(deps, join(out, 'node_modules'));
// Stage the import closure of the modules the measurement contract loads, so the isolated copy
// compiles without a hand-kept list that goes stale the moment an import is added. A stale list
// fails TS2307 here instead of measuring anything.
const roots = ['runtime/store.ts', 'runtime/outbox.ts', 'domain/facade.ts', 'chat/index.ts', 'chat/context.ts', 'prompt/index.ts'];
const staged = new Set();
const pending = roots.map(file => join(root, 'server', file));
while (pending.length) {
  const file = pending.pop();
  if (staged.has(file) || !existsSync(file)) continue;
  staged.add(file);
  const target = join(out, 'source', file.slice(join(root, 'server').length));
  mkdirSync(dirname(target), { recursive: true });
  cpSync(file, target);
  for (const [, spec] of readFileSync(file, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/gu)) {
    const base = resolve(dirname(file), spec).replace(/\.js$/u, '');
    for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
      if (existsSync(candidate)) { pending.push(candidate); break; }
    }
  }
}
assert.ok(staged.size > roots.length, 'the measured modules import more than themselves');
// NodeNext must compile as the canonical ESM service, not CommonJS.
cpSync(join(root, 'server/package.json'), join(out, 'package.json'));
const files = [];
function collect(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) collect(child);
    else if (entry.name.endsWith('.ts')) files.push(child);
  }
}
collect(join(out, 'source'));
run(process.execPath, [join(deps, 'typescript/bin/tsc'), '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
  '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes', '--noUnusedLocals', '--noUnusedParameters', '--skipLibCheck',
  '--types', 'node', '--typeRoots', join(deps, '@types'), '--rootDir', join(out, 'source'), '--outDir', join(out, 'dist'), ...files]);
mkdirSync(dirname(process.env.ARCHIVE_SCALE_OUTPUT), { recursive: true });
assert.ok(!existsSync(process.env.ARCHIVE_SCALE_OUTPUT), 'refusing to overwrite retained measurement evidence');
const tap = run(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=15000', join(root, 'server/test/archive-scale.mjs')], root, true);
assert.match(tap, /^# tests 1$/m, 'archive-scale must select exactly one test');
assert.match(tap, /^# pass 1$/m, 'archive-scale test must pass');
assert.ok(existsSync(process.env.ARCHIVE_SCALE_OUTPUT), 'required measurement JSON absent');
console.log(`ARCHIVE_SCALE_OUTPUT=${process.env.ARCHIVE_SCALE_OUTPUT}`);
NODE
