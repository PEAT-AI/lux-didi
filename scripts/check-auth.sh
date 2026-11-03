#!/usr/bin/env bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root/server"
out="$(mktemp -d "${TMPDIR:-/tmp}/didi-auth.XXXXXX")"
trap 'rm -rf "$out"' EXIT
node node_modules/typescript/bin/tsc --ignoreConfig --target ES2023 --module NodeNext --moduleResolution NodeNext --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess --skipLibCheck --types node --outDir "$out" tasks/authority.ts test/task-authority.test.ts
printf '{"type":"module"}\n' > "$out/package.json"
node --test "$out/test/task-authority.test.js"
