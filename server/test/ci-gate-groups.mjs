// The pull request gate's shape: three parallel group jobs, ten checks, none dropped.
//
// The check list is the one the gate measured on 2026-11-02 (contract C-CIFIX): the ten checks
// scripts/ci-gauntlet.sh --ci runs. The group partition lives in scripts/ci-gauntlet.sh and the
// job/matrix shape in .github/workflows/ci.yml, so this test reads both sources and the inventory
// table in docs/checks.md, and fails if any of the three stops agreeing with the other two.
//
// It runs no check and touches no network: scripts/ci-gauntlet.sh --ci --list-groups prints the
// partition and exits before the install step.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = name => readFileSync(resolve(root, name), 'utf8');

// The ten the gate runs on ubuntu, measured 2026-11-02.
const GATE = [
  'check-live-gateway',
  'check-live-session',
  'check-live-voice',
  'check-package',
  'check-prompt',
  'check-tool-owner',
  'check-google-connector',
  'check-company-connectors',
  'check-install-smoke',
  'check-web-unit',
];
const EXPECTED_GROUPS = {
  gateway: ['check-live-gateway'],
  session: ['check-live-session', 'check-live-voice'],
  other: ['check-prompt', 'check-tool-owner', 'check-google-connector',
    'check-company-connectors', 'check-web-unit', 'check-install-smoke', 'check-package'],
};

function partition() {
  const out = execFileSync('bash', ['scripts/ci-gauntlet.sh', '--ci', '--list-groups'],
    { cwd: root, encoding: 'utf8' });
  const pairs = out.split('\n').filter(Boolean).map(line => line.split('\t'));
  return pairs;
}

// A deliberate subset of YAML: this file is the only workflow in the repository, so the test
// reads the matrix list, the strategy block and the ci-success needs list structurally rather
// than pulling a parser dependency into the service package.
function matrixGroups(source) {
  const match = source.match(/^ {8}group: \[([^\]]*)\]$/m);
  assert.ok(match, 'ci.yml has no `group: [...]` matrix list');
  return match[1].split(',').map(value => value.trim()).filter(Boolean);
}

test('the three groups partition the ten gate checks, each exactly once', () => {
  const pairs = partition();
  const groups = {};
  for (const [group, check] of pairs) {
    assert.ok(group && check, `unparsable --list-groups line: ${group} ${check}`);
    groups[group] = (groups[group] ?? []).concat(check);
  }
  const names = pairs.map(([, check]) => check);
  assert.equal(new Set(names).size, names.length, 'a check is listed in more than one group');
  assert.deepEqual([...names].sort(), [...GATE].sort(), 'the gate checks changed');
  const normalized = Object.fromEntries(Object.entries(groups).map(([group, list]) => [group, [...list].sort()]));
  const expected = Object.fromEntries(Object.entries(EXPECTED_GROUPS).map(([group, list]) => [group, [...list].sort()]));
  assert.deepEqual(normalized, expected, 'a group lost or gained a check');
});

test('ci.yml runs the three groups in parallel with fail-fast off', () => {
  const source = read('.github/workflows/ci.yml');
  assert.deepEqual(matrixGroups(source).sort(), Object.keys(EXPECTED_GROUPS).sort());
  assert.match(source, /^ {6}fail-fast: false$/m, 'the matrix must not fail fast');
  assert.match(source, /runs-on: ubuntu-latest/, 'the gate must not need a macOS runner');
  assert.match(source, /bash scripts\/ci-gauntlet\.sh --ci --group "\$\{\{ matrix\.group \}\}"/,
    'the gate job must run one group through the gauntlet');
  // One status a branch protection can require, and it accepts only a full success: a failed,
  // cancelled or blocked leg leaves the aggregate result non-success.
  assert.match(source, /^ {4}needs: \[gate\]$/m, 'ci-success must need the gate job');
  assert.match(source, /needs\.gate\.result \}\}" != "success"/,
    'ci-success must refuse anything but success');
});

test('docs/checks.md inventory names every gate check and its group', () => {
  const source = read('docs/checks.md');
  const rows = new Map();
  for (const line of source.split('\n')) {
    const cells = line.split('|').map(cell => cell.trim());
    if (cells.length < 4) continue;
    const name = cells[1].replace(/`/g, '');
    if (!GATE.includes(name)) continue;
    rows.set(name, cells[2]);
  }
  assert.deepEqual([...rows.keys()].sort(), [...GATE].sort(),
    'the check inventory table must name all ten gate checks');
  for (const [group, names] of Object.entries(EXPECTED_GROUPS)) {
    for (const name of names) assert.equal(rows.get(name), group, `${name} is listed under the wrong group`);
  }
});
