#!/usr/bin/env bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/../server"
npm run build
node --test --test-timeout=15000 dist/test/knowledge-connector.test.js
