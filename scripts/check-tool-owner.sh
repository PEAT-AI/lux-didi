#!/usr/bin/env bash
# Compile the real host closure, including the task helper used by tool authority.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/node-test-files.sh"
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/../server"
npm run build
# These authority unit files are intentionally outside the service tsconfig inventory.
# Compile their real import closure with the same strict flags as the former staged build.
node node_modules/typescript/bin/tsc --ignoreConfig --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noUnusedLocals --noUnusedParameters \
  --skipLibCheck --types node --typeRoots node_modules/@types --rootDir . --outDir dist \
  test/owner-utterances.test.ts test/tool-owner.test.ts test/live-shape.test.ts \
  test/redact.test.ts test/open-destinations.test.ts test/lux-note.test.ts test/task-authority.test.ts
mkdir -p dist/test/fixtures
cp test/fixtures/open-destinations.json test/fixtures/open-evals.json test/fixtures/owner-utterances.json dist/test/fixtures/
cp tools/open-handles.ts dist/test/fixtures/parity-open-handles.ts
cp ../Sources/LuxDidi/NativeActions.swift dist/test/fixtures/parity-NativeActions.swift
node_test_files --test-reporter=tap --test-timeout=15000 \
  dist/test/owner-utterances.test.js dist/test/tool-owner.test.js \
  dist/test/live-shape.test.js dist/test/redact.test.js \
  dist/test/open-destinations.test.js dist/test/lux-note.test.js
node_test_files --test-reporter=tap --test-timeout=30000 \
  '--test-name-pattern=^real chat declares approved reads, journals execution, and discloses only gated evidence$' \
  dist/test/tools-builtin-intent.test.js dist/test/time-corpus.test.js \
  dist/test/chat-tools.test.js dist/test/task-authority.test.js
