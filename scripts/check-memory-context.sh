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

# The lane worktree carries no installed deps. Materialize ignored node_modules
# DIRECTORY trees that symlink each entry of an accepted sibling's installed deps
# read-only. `node_modules/` is already gitignored by server/.gitignore and
# web/.gitignore, so this pollutes no tracked file, adds no shared exclude rule,
# and touches no other worktree.
if [[ ! -x "$root/server/node_modules/.bin/tsc" ]]; then
  for cand in "$root/../lux-didi-connected" "$root/../lux-didi-service"; do
    if [[ -x "$cand/server/node_modules/.bin/tsc" && -d "$cand/web/node_modules" ]]; then
      for pkg in server web; do
        mkdir -p "$root/$pkg/node_modules"
        for entry in "$cand/$pkg/node_modules"/* "$cand/$pkg/node_modules"/.[!.]*; do
          [[ -e "$entry" ]] || continue
          ln -sfn "$entry" "$root/$pkg/node_modules/$(basename "$entry")"
        done
      done
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

# New selection tests + impacted CHAT/HTTP/HOST accept/dispatch/fingerprint/recovery
# and CONNECTED authorization/context regressions, against the real compiled build.
timeout 1200 node --test --test-reporter=tap --test-timeout=30000 \
  server/dist/test/memory-context.test.js server/dist/test/chat.test.js server/dist/test/http.test.js \
  server/dist/test/host.test.js server/dist/test/connected.test.js \
  | tee "$log" || status=$?
grep -Eq '^# tests [1-9][0-9]*$' "$log" || { echo 'check-memory-context: zero selected chat/connected tests' >&2; exit 1; }
if [ "$status" -ne 0 ]; then exit "$status"; fi

# Impacted DOMAIN resolution and routing-label regressions (real Store + Outbox).
timeout 900 node --test --test-reporter=tap --test-timeout=30000 \
  server/test/domain.test.ts server/test/provenance.test.ts \
  | tee "$log" || status=$?
grep -Eq '^# tests [1-9][0-9]*$' "$log" || { echo 'check-memory-context: zero selected domain tests' >&2; exit 1; }
exit "$status"
