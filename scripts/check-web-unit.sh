#!/usr/bin/env bash
# The web unit suite for the three-lane rework (V3-R3, PEAT-AI/lux-didi#264): the built bundle first,
# then the headless tests for the orb stage, the bubble markup, the pin rule and the numbered lists.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/node-test-files.sh"
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/../web"
npm run build
node_test_files test/autoscroll.test.ts test/orb-motion.test.ts test/orb-parity.test.ts test/tool-phrases.test.ts test/live-view.test.ts test/connected.test.ts test/markdown.test.ts test/layout.test.ts test/ui-hierarchy.test.ts test/controls.test.ts test/mini.test.ts test/production-shape.test.ts test/signin-target.test.ts test/signin-repaint.test.ts test/settings-repaint.test.ts test/closed-sets.test.ts test/settings-view.test.ts test/settings-live-summary.test.ts test/chat-turn.test.ts test/orb-states.test.ts test/next-steps.test.ts test/connector-status.test.ts test/vault-card.test.ts test/memory-list.test.ts
