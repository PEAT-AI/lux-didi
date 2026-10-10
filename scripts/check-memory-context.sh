#!/usr/bin/env bash
# Explicit selected-local-memory check.
#
# Builds the real service (Store/Domain/ChatService) and runs the new
# memory-context tests plus the impacted CHAT and CONNECTED authorization/context
# regressions and the DOMAIN/provenance resolution+label regressions. Compiles
# through the project tsconfig so the check fails on a stale or absent dist, and
# never runs a broad unrelated ring.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

# The lane worktree carries no installed deps; reuse an accepted sibling's
# installed node_modules read-only (symlink only when absent, never overwritten).
if [[ ! -d "$root/server/node_modules" || ! -d "$root/web/node_modules" ]]; then
  for cand in "$root/../lux-didi-connected" "$root/../lux-didi-service"; do
    if [[ -d "$cand/server/node_modules" && -d "$cand/web/node_modules" ]]; then
      [[ -e "$root/server/node_modules" ]] || ln -s "$cand/server/node_modules" "$root/server/node_modules"
      [[ -e "$root/web/node_modules" ]] || ln -s "$cand/web/node_modules" "$root/web/node_modules"
      break
    fi
  done
fi
if [[ ! -x "$root/server/node_modules/.bin/tsc" ]]; then
  echo 'check-memory-context BLOCKED: installed SERVICE TypeScript required' >&2; exit 2
fi

git diff --check
bash scripts/run-local.sh --build-only

for f in server/dist/chat/index.js server/dist/domain/facade.js server/dist/runtime/store.js \
         server/dist/test/memory-context.test.js server/dist/test/connected.test.js; do
  test -s "$f" || { echo "check-memory-context: missing build output: $f" >&2; exit 1; }
done

log=$(mktemp)
trap 'rm -f "$log"' EXIT
status=0

# New selection tests + impacted CHAT accept/dispatch/fingerprint/recovery and
# CONNECTED authorization/context regressions, against the real compiled build.
node --test --test-reporter=tap --test-timeout=30000 \
  server/dist/test/memory-context.test.js server/dist/test/chat.test.js server/dist/test/connected.test.js \
  | tee "$log" || status=$?
grep -Eq '^# tests [1-9][0-9]*$' "$log" || { echo 'check-memory-context: zero selected chat/connected tests' >&2; exit 1; }
if [ "$status" -ne 0 ]; then exit "$status"; fi

# Impacted DOMAIN resolution and routing-label regressions (real Store + Outbox).
node --test --test-reporter=tap --test-timeout=30000 \
  server/test/domain.test.ts server/test/provenance.test.ts \
  | tee "$log" || status=$?
grep -Eq '^# tests [1-9][0-9]*$' "$log" || { echo 'check-memory-context: zero selected domain tests' >&2; exit 1; }
exit "$status"
