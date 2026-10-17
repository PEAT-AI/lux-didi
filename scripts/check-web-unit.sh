#!/usr/bin/env bash
# The web unit suite for the three-lane rework (V3-R3, PEAT-AI/lux-didi#264): the built bundle first,
# then the headless tests for the orb stage, the bubble markup, the pin rule and the numbered lists.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/../web"
npm run build
node --test test/autoscroll.test.ts test/orb-motion.test.ts test/orb-parity.test.ts test/live-view.test.ts test/connected.test.ts test/markdown.test.ts test/layout.test.ts test/ui-hierarchy.test.ts test/mini.test.ts test/orb-states.test.ts test/settings-view.test.ts
