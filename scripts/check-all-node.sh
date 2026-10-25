#!/usr/bin/env bash
# One Linux-runnable node gate for the whole repository: every node test file under
# server/test and web/test that does not need macOS, real credentials or the network,
# plus the headless Chromium suites that drive the built web bundle against the
# repository's fake server (web/test/fixture.mjs).
#
# Single source of the file list. The train workflow (.github/workflows/train.yml) calls
# this script and never repeats the list, so the Linux job and the local desk cannot
# disagree. This script does not replace the per-check scripts under scripts/check-*.sh;
# it adds the 52 test files none of them names (see the release train audits).
#
#   bash scripts/check-all-node.sh                  # every phase, in order
#   CHECK_ALL_NODE_PHASE=web bash scripts/check-all-node.sh
#
# Exit 0 only when every named file ran and passed. A file that cannot run here is in
# one of the named skip lists below with its one-line reason; nothing is excluded by a
# glob that silently matches nothing.
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/node-test-files.sh"
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
phase="${CHECK_ALL_NODE_PHASE:-all}"
case "$phase" in server|web|browser|all) ;; *) printf 'unknown CHECK_ALL_NODE_PHASE: %s\n' "$phase" >&2; exit 2 ;; esac
work="$(mktemp -d "${TMPDIR:-/tmp}/didi-all-node.XXXXXX")" || exit 2
trap 'rm -rf "$work"' EXIT
started=$SECONDS
status=0
ran_server=0; ran_web=0; ran_browser=0

# Skipped test files. One line each: path, then the reason it cannot run in the Linux job.
# A macOS-only, credential-only or network-only file belongs here, never in a glob.
skip_server=(
  'host-browser.mjs|spawns scripts/run-local.sh (the real host process) and the desk renderer lease; scripts/check-host.sh owns it on macOS'
  'connected-browser.mjs|spawns the real host through scripts/run-local.sh and needs the desk renderer lease; scripts/check-connected.sh owns it on macOS'
  'api-response-browser.mjs|needs a DIDI_API_RESPONSE_ARTIFACTS proof tree and its own 280 s budget; scripts/check-api-response.sh owns it on macOS'
)
skip_web=(
  'selected-memory-browser.mjs|drives the shared GPU renderer through lux-browser-slot, which exists only on the managed host; scripts/check-selected-memory-ui.sh owns it'
  'mini-shots.mjs|writes screenshot artifacts for a human; no pass/fail gate'
  'orb-motion-shots.mjs|writes screenshot artifacts for a human; no pass/fail gate'
  'orb-states-shots.mjs|writes screenshot artifacts for a human; no pass/fail gate'
  'orb-ink-browser.mjs|writes screenshot artifacts for a human; no pass/fail gate'
  'v2-shots.mjs|writes screenshot artifacts for a human; no pass/fail gate'
  'v3-shots.mjs|writes screenshot artifacts for a human; no pass/fail gate'
  'native-conversation.spec.ts|Playwright spec of the macOS native bridge in the app shell; the Swift desk gate owns it'
)

is_skipped() { # <list-name-array> <path-without-prefix>
  local entry
  eval "local -a list=(\"\${$1[@]}\")"
  for entry in "${list[@]}"; do [ "${entry%%|*}" = "$2" ] && return 0; done
  return 1
}

print_skips() {
  local entry
  for entry in "$@"; do printf 'SKIP %s: %s\n' "${entry%%|*}" "${entry#*|}"; done
}

# Server tests are compiled: `node --test` runs dist/test/*.js and the .integration.mjs
# sources import dist. The 26 test files server/tsconfig.json does not name get a second
# explicit compile pass with the same flags the per-check scripts use, so no suite is
# unreachable just because the build never emitted it.
server_extra_compile() {
  local -a extra=() file
  for file in test/*.test.ts; do
    grep -qF "\"$file\"" tsconfig.json || extra+=("$file")
  done
  [ "${#extra[@]}" -eq 0 ] && return 0
  printf 'server: compiling %d test files that server/tsconfig.json does not name\n' "${#extra[@]}"
  ./node_modules/.bin/tsc --ignoreConfig --target ES2023 --module NodeNext --moduleResolution NodeNext \
    --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noUnusedLocals \
    --noUnusedParameters --skipLibCheck --declaration --sourceMap --types node \
    --rootDir . --outDir dist "${extra[@]}"
}

run_phase() { # <label> <logfile> <command...>
  local label="$1" log="$2"; shift 2
  local phase_start=$SECONDS
  printf '=== %s: %s\n' "$label" "$*"
  if "$@" >"$log" 2>&1; then
    printf '=== %s: PASS in %ds\n' "$label" "$((SECONDS - phase_start))"
    return 0
  fi
  printf '=== %s: FAIL in %ds\n' "$label" "$((SECONDS - phase_start))"
  node - "$log" <<'PARSE'
// Name every failing test file and its first error line, and nothing else.
const lines = require('node:fs').readFileSync(process.argv[2], 'utf8').split('\n');
let file = null, first = null;
const flush = () => { if (file) { console.log(`FAIL ${file}`); if (first) console.log(`  ${first}`); } };
for (const line of lines) {
  const top = /^not ok \d+ - (.+)$/.exec(line);
  const sub = /^# Subtest: (\S+)$/.exec(line);
  const inner = /^ +not ok \d+ - (.+)$/.exec(line);
  const error = /^ +(?:error|message): '?([^']{1,200})/.exec(line);
  if (sub) { if (file && first) { flush(); } file = sub[1]; first = null; }
  else if (inner && file && !first) first = `first failing test: ${inner[1]}`;
  else if (error && file && !first) first = error[1].trim();
  else if (top && file) { flush(); file = null; first = null; }
}
flush();
PARSE
  tail -25 "$log" | sed 's/^/  | /'
  status=1
  return 1
}

if [ "$phase" = server ] || [ "$phase" = all ]; then
  cd "$root/server"
  run_phase 'server typecheck' "$work/server-typecheck.log" npm run --silent typecheck || exit 1
  run_phase 'server build' "$work/server-build.log" npm run --silent build || exit 1
  run_phase 'server extra compile' "$work/server-extra.log" server_extra_compile || exit 1
  server_files=()
  for file in dist/test/*.test.js; do
    name="test/${file#dist/test/}"; name="${name%.js}.ts"
    is_skipped skip_server "${name#test/}" || server_files+=("$file")
  done
  for file in test/*.integration.mjs; do
    is_skipped skip_server "${file#test/}" || server_files+=("$file")
  done
  [ "${#server_files[@]}" -gt 0 ] || { printf 'server: no test files matched; refusing a green run\n' >&2; exit 1; }
  printf 'server: %d test files, %d named skips\n' "${#server_files[@]}" "${#skip_server[@]}"
  print_skips "${skip_server[@]}"
  ran_server="${#server_files[@]}"
  run_phase 'server tests' "$work/server-tests.log" node_test_files --test-timeout=15000 "${server_files[@]}"
  server_status=$?
  cd "$root"
  [ "$server_status" -eq 0 ] || status=1
fi

if [ "$phase" = web ] || [ "$phase" = all ]; then
  cd "$root/web"
  run_phase 'web build' "$work/web-build.log" npm run --silent build || exit 1
  web_files=()
  for file in test/*.test.ts test/*.test.mjs; do
    is_skipped skip_web "${file#test/}" || web_files+=("$file")
  done
  [ "${#web_files[@]}" -gt 0 ] || { printf 'web: no test files matched; refusing a green run\n' >&2; exit 1; }
  printf 'web: %d test files, %d named skips\n' "${#web_files[@]}" "${#skip_web[@]}"
  print_skips "${skip_web[@]}"
  ran_web="${#web_files[@]}"
  run_phase 'web tests' "$work/web-tests.log" node_test_files --test-timeout=15000 "${web_files[@]}"
  web_status=$?
  cd "$root"
  [ "$web_status" -eq 0 ] || status=1
fi

if [ "$phase" = browser ] || [ "$phase" = all ]; then
  # Headless Chromium against the built web bundle and the fake server in
  # web/test/fixture.mjs. One process per suite, serial: they share the fixture port.
  browser_files=(web/test/browser.mjs web/test/presentation-browser.mjs web/test/ui-proof.mjs
    web/test/transcript-pagination-replay.mjs web/test/transcription-replay.mjs)
  printf 'browser: %d suites\n' "${#browser_files[@]}"
  ran_browser="${#browser_files[@]}"
  for suite in "${browser_files[@]}"; do
    run_phase "browser $suite" "$work/browser-$(basename "$suite").log" node "$suite" || status=1
  done
fi

printf 'ALL-NODE COUNT files=%d wall=%ds\n' "$((ran_server + ran_web + ran_browser))" "$((SECONDS - started))"
[ "$status" -eq 0 ] && printf 'ALL-NODE PASS\n' || printf 'ALL-NODE FAIL\n'
exit "$status"
