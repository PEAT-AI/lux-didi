#!/usr/bin/env bash
# Compile the real host closure, including the task helper used by tool authority.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/node-test-files.sh"
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/../server"
npm run build
node_test_files --test-timeout=15000 \
  dist/test/owner-utterances.test.js dist/test/tool-owner.test.js \
  dist/test/live-shape.test.js dist/test/redact.test.js \
  dist/test/open-destinations.test.js dist/test/lux-note.test.js
node_test_files --test-timeout=30000 \
  dist/test/tools-builtin-intent.test.js dist/test/time-corpus.test.js \
  dist/test/chat-tools.test.js dist/test/task-authority.test.js
