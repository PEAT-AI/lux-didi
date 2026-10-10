#!/usr/bin/env bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
if test -n "$(git status --porcelain -- server scripts/check-package.sh docs/service-packaging.md)"; then
  echo 'Package check requires clean, committed package source' >&2
  exit 1
fi
# Only committed source and a fresh, explicit builder cache can feed the artifact.
work=$(mktemp -d "${TMPDIR:-/tmp}/didi-package.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/source" "$work/runtime"
git archive HEAD server | tar -xf - -C "$work/source"
builder="$work/source/server"
export npm_config_cache="$work/builder-cache"
printf 'PACKAGE_SOURCE=%s NODE=%s NPM=%s PLATFORM=%s\n' "$(git rev-parse HEAD)" "$(node --version)" "$(npm --version)" "$(node -p 'process.platform+"/"+process.arch')"
(cd "$builder" && npm ci --ignore-scripts --no-audit --no-fund && npm run typecheck && npm run build)
cp -R "$builder/dist" "$work/exact-dist"
# The repository tsconfig deliberately enumerates tests. Extend it only in the
# disposable builder; do not change service compilation or another lane's tests.
node --input-type=module - "$builder" <<'NODE'
import {readFileSync, writeFileSync} from 'node:fs';
const root = process.argv[2];
const config = JSON.parse(readFileSync(`${root}/tsconfig.json`, 'utf8'));
writeFileSync(`${root}/tsconfig.package.json`, JSON.stringify({extends:'./tsconfig.json', include:[...config.include, 'test/package.test.ts']}));
NODE
(cd "$builder" && npm exec --offline -- tsc -p tsconfig.package.json)
diff -qr -x test "$work/exact-dist" "$builder/dist"
# Retain the actual compiler's package assertion locations, not inferred offsets.
node --input-type=module - "$builder/dist/test/http.test.js" <<'NODE'
import {readFileSync} from 'node:fs';
const file = process.argv[2];
readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
  if (line.includes('assert.equal(installed.status') || line.includes('assert.equal(code, 0)')) {
    console.log(`PACKAGE_COMPILED ${file}:${index + 1} ${line.trim()}`);
  }
});
NODE
cp "$builder/package.json" "$builder/package-lock.json" "$work/runtime/"
cp -R "$builder/dist" "$work/runtime/dist"
mkdir -p "$work/runtime/adapters/mcp"
cp "$builder/adapters/mcp/SDK-LICENSE.txt" "$work/runtime/adapters/mcp/"
# This is a separate locked production install, not a pruned or dirty developer tree.
(cd "$work/runtime" && npm ci --offline --omit=dev --ignore-scripts --no-audit --no-fund)
export DIDI_PACKAGE_SOURCE="$builder"
cd "$work/runtime"
for file in dist/test/http.test.js dist/test/package.test.js; do
  test -s "$file" || { echo "Missing selected test: $file" >&2; exit 1; }
done
node --test --test-reporter=tap --test-timeout=30000 --test-name-pattern='package|artifact' dist/test/http.test.js dist/test/package.test.js | tee "$work/test.log"
grep -Eq '^# tests [1-9][0-9]*$' "$work/test.log" || { echo 'Zero selected package tests' >&2; exit 1; }
