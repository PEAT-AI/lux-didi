#!/usr/bin/env bash
# Temporary focused diagnosis for LIVETESTS-R1. Full inventory is restored before acceptance.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/node-test-files.sh"
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/../server"
npm run build
node_test_files --test-reporter=tap --test-timeout=30000 \
  dist/test/live-session.test.js
