#!/usr/bin/env bash
# Synthetic task core contracts and lifecycle. No provider calls.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
. "$root/scripts/lib/node-test-files.sh"
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
out="$(mktemp -d "${TMPDIR:-/tmp}/didi-tasks.XXXXXX")"
trap 'rm -rf "$out"' EXIT
cd "$out"
"$root/server/node_modules/.bin/tsc" --types node --typeRoots "$root/server/node_modules/@types" --target ES2023 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --skipLibCheck --esModuleInterop --rootDir "$root/server" --outDir "$out" "$root/server/test/task-vault.test.ts" "$root/server/test/task-chat.test.ts" "$root/server/test/task-call.test.ts" "$root/server/test/task-delivery.test.ts" "$root/server/test/tasks-contract.test.ts" "$root/server/test/tasks-lifecycle.test.ts" "$root/server/test/tasks-store.test.ts" "$root/server/test/live-shape.test.ts"
printf '{"type":"module"}\n' > "$out/package.json"
ln -s "$root/server/node_modules" "$out/node_modules"
mkdir -p "$out/scripts" "$out/test/fixtures"
cp "$root/server/test/fixtures/stdio-mattermost-people-child.mjs" "$root/server/test/fixtures/mattermost-draft-tools-list.json" "$root/server/test/fixtures/google-tools-list.json" "$root/server/test/fixtures/stdio-mcp-child.mjs" "$root/server/test/fixtures/google-write-child.mjs" "$out/test/fixtures/"
cp "$root/scripts/eval-worker-replay.mjs" "$out/scripts/"
node_test_files --test-timeout=15000 "$out/test/task-vault.test.js" "$out/test/task-chat.test.js" "$out/test/task-call.test.js" "$out/test/task-delivery.test.js" "$out/test/tasks-contract.test.js" "$out/test/tasks-lifecycle.test.js" "$out/test/tasks-store.test.js" "$out/test/live-shape.test.js"

cd "$root"
bash scripts/check-combined-tree.sh --selftest
