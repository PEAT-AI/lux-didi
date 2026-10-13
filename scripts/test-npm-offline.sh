#!/usr/bin/env bash
# Prove the offline npm install helper fails loud on an empty cache and is a pure
# swap once the cache is warm.
#
# The whole test uses a temporary npm cache, never the user's real cache.
set -uo pipefail
cd "$(dirname "$0")/.."

helper=scripts/npm-ci-offline.sh
warm=scripts/warm-npm-cache.sh

work=$(mktemp -d "${TMPDIR:-/tmp}/didi-test-npm.XXXXXX")
trap 'rm -rf "$work"' EXIT
cache="$work/cache"
mkdir -p "$cache"
export npm_config_cache="$cache"

# 1. An empty cache: the helper exits non-zero and names the failure and the fix.
echo 'TEST: empty cache fails loud'
set +e
bash "$helper" server >"$work/empty.out" 2>"$work/empty.err"
empty_status=$?
set -e
if [ "$empty_status" -eq 0 ]; then
  echo 'FAIL: helper exited 0 on an empty cache' >&2
  exit 1
fi
grep -q 'ENOTCACHED' "$work/empty.err" || { echo 'FAIL: stderr did not name ENOTCACHED' >&2; cat "$work/empty.err" >&2; exit 1; }
grep -q 'warm-npm-cache.sh' "$work/empty.err" || { echo 'FAIL: stderr did not name the warm command' >&2; cat "$work/empty.err" >&2; exit 1; }
grep -Eq 'missing [^ ]+@[0-9]' "$work/empty.err" || { echo 'FAIL: stderr did not name the missing tarball' >&2; cat "$work/empty.err" >&2; exit 1; }
echo 'PASS: empty cache fails loud'

# 2. Warm the same temporary cache, then the helper installs cleanly.
echo 'TEST: warm cache succeeds'
bash "$warm"
set +e
bash "$helper" server >"$work/helper.out" 2>"$work/helper.err"
warm_status=$?
npm --prefix server ci --offline --ignore-scripts --no-audit --no-fund >"$work/bare.out" 2>"$work/bare.err"
bare_status=$?
set -e
if [ "$warm_status" -ne 0 ]; then
  echo "FAIL: helper exited $warm_status on a warm cache" >&2
  tail -5 "$work/helper.err" >&2
  exit 1
fi
echo 'PASS: warm cache succeeds'

# 3. Pure call-site swap: with a warm cache the helper's exit code and stdout match
# the bare command it replaces. npm prints its own wall-clock duration ("added N
# packages in 1s"), which differs between ANY two runs of the bare command, so the
# duration token is normalized before the comparison.
echo 'TEST: helper matches the bare npm ci --offline'
normalize() { sed -E 's/ in [0-9]+m?s//' "$1"; }
if [ "$warm_status" -ne "$bare_status" ]; then
  echo "FAIL: helper exit $warm_status != bare exit $bare_status" >&2
  exit 1
fi
normalize "$work/helper.out" > "$work/helper.norm"
normalize "$work/bare.out" > "$work/bare.norm"
if ! cmp -s "$work/helper.norm" "$work/bare.norm"; then
  echo 'FAIL: normalized stdout differs from the bare command' >&2
  diff "$work/helper.norm" "$work/bare.norm" >&2
  exit 1
fi
echo 'PASS: helper matches the bare npm ci --offline'

echo 'TEST: locked production install in a differently named directory'
mkdir "$work/runtime"
cp server/package.json server/package-lock.json "$work/runtime/"
bash "$helper" "$work/runtime" ci --offline --omit=dev --ignore-scripts --no-audit --no-fund
node --input-type=module - "$work/runtime" <<'JS'
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const root = process.argv[2];
const require = createRequire(`${root}/package.json`);
assert.equal(typeof require('ws').WebSocket, 'function');
assert.ok(existsSync(`${root}/node_modules/@modelcontextprotocol/client/package.json`));
assert.equal(existsSync(`${root}/node_modules/typescript`), false);
console.log('PASS: locked production dependencies installed without dev dependencies');
JS

echo 'TEST-NPM-OFFLINE PASS'
