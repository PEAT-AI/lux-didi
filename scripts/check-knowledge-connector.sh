#!/usr/bin/env bash
# The Lux Knowledge reader: query shape, confidence field and bounded body reads.
# Exits non-zero on the first failing test.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/node-test-files.sh"
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/../server"
npm run build
node_test_files --test-timeout=15000 dist/test/knowledge-connector.test.js
