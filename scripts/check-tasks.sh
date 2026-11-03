#!/usr/bin/env bash
# Synthetic task core contracts and lifecycle. No provider calls.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
. "$root/scripts/lib/node-test-files.sh"
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
out="$(mktemp -d "${TMPDIR:-/tmp}/didi-tasks.XXXXXX")"
trap 'rm -rf "$out"' EXIT
cd "$out"
"$root/server/node_modules/.bin/tsc" --target ES2023 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --skipLibCheck --esModuleInterop --rootDir "$root/server" --outDir "$out" "$root/server/test/tasks-contract.test.ts" "$root/server/test/tasks-lifecycle.test.ts"
printf '{"type":"module"}\n' > "$out/package.json"
ln -s "$root/server/node_modules" "$out/node_modules"
node_test_files --test-timeout=15000 "$out/test/tasks-contract.test.js" "$out/test/tasks-lifecycle.test.js"
