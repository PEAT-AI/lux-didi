#!/usr/bin/env bash
# W13: the capture gate admits every read tool its connector modules publish. The suite dispatches
# through the real gate against a real store, so a refused person read shows up here and not in a
# call (LOGS.md L-03).
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/node-test-files.sh"
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
deps="${DIDI_TYPESCRIPT_ROOT:-$root/server/node_modules}"
if [[ ! -f "$deps/typescript/bin/tsc" ]]; then
  # A linked worktree installs no dependencies of its own, so resolve the installed SERVICE tree the
  # main checkout beside it holds.
  common="$(cd "$root" && git rev-parse --git-common-dir 2>/dev/null || true)"
  if [[ -n "$common" ]]; then
    [[ "$common" = /* ]] || common="$root/$common"
    if main_root="$(cd "$common/.." && pwd)"; then deps="$main_root/server/node_modules"; fi
  fi
fi
if [[ ! -f "$deps/typescript/bin/tsc" ]]; then deps="$root/../lux-didi-service/server/node_modules"; fi
if [[ ! -f "$deps/typescript/bin/tsc" || ! -d "$deps/@types/node" || ! -d "$deps/@modelcontextprotocol/server" ]]; then
  echo 'DISPATCH GATE CHECK BLOCKED: installed TypeScript/Node types/MCP SDK required' >&2
  exit 2
fi
out="$(mktemp -d "${TMPDIR:-/tmp}/didi-dispatch-gate.XXXXXX")"
trap 'rm -rf "$out"' EXIT
cd "$root"
# Stage the complete server source tree so any server import resolves together, exactly as the
# whole-server build does; only the selected test is staged below.
mkdir -p "$out/source/test"
find server -mindepth 1 -maxdepth 1 -type d \
  ! -name node_modules ! -name dist ! -name test \
  -exec cp -R {} "$out/source/" \;
find server -mindepth 1 -maxdepth 1 -type f -name '*.ts' -exec cp {} "$out/source/" \;
cp server/test/dispatch-gate.test.ts "$out/source/test/"
ln -s "$deps" "$out/node_modules"
printf '{"type":"module"}\n' > "$out/package.json"
staged=()
while IFS= read -r file; do staged+=("$file"); done < <(find "$out/source" -name '*.ts' -type f)
node "$deps/typescript/bin/tsc" --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noUnusedLocals --noUnusedParameters --skipLibCheck \
  --types node --typeRoots "$deps/@types" --rootDir "$out/source" --outDir "$out/dist" "${staged[@]}"
test -f "$out/dist/test/dispatch-gate.test.js"
cd "$out"
node_test_files --test-timeout=15000 "$out/dist/test/dispatch-gate.test.js"
