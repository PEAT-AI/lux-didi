#!/usr/bin/env bash
# Credential binding across provider config, model, live voice, prompt, remember, declarations and Mongoose auth.
# Exits non-zero on the first failing test.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/node-test-files.sh"
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
deps="${DIDI_TYPESCRIPT_ROOT:-$root/server/node_modules}"
if [[ ! -f "$deps/typescript/bin/tsc" ]]; then
  deps="$root/../lux-didi-service/server/node_modules"
fi
if [[ ! -f "$deps/typescript/bin/tsc" || ! -d "$deps/@types/node" || ! -d "$deps/@types/ws" || ! -d "$deps/ws" ]]; then
  echo 'CREDENTIAL BINDING CHECK BLOCKED: installed TypeScript/@types/node/@types/ws/ws required (DIDI_TYPESCRIPT_ROOT)' >&2
  exit 2
fi
node -e 'if (Number(process.versions.node.split(".")[0]) < 26) { console.error("CREDENTIAL BINDING CHECK BLOCKED: installed Node >=26 required"); process.exit(2); }'
out="$(mktemp -d "${TMPDIR:-/tmp}/didi-credential-binding.XXXXXX")"
trap 'rm -rf "$out"' EXIT
# #624: the staged tree is the repository's own tracked server sources, taken from git rather than a
# hand-written directory list, so a new module or directory reaches this check without an edit here. The
# tsc entry points below stay explicit, because they are the selected tests, not the whole suite.
git -C "$root" ls-files -z -- server > "$out/files.z" || { echo 'CREDENTIAL BINDING CHECK FAIL: git ls-files server' >&2; exit 1; }
while IFS= read -r -d '' file; do
  case "$file" in server/node_modules/*|server/dist/*) continue ;; esac
  mkdir -p "$out/source/$(dirname "${file#server/}")"
  cp "$root/$file" "$out/source/${file#server/}"
done < "$out/files.z"
printf '{"type":"module"}\n' > "$out/package.json"
ln -s "$deps" "$out/node_modules"
entry=("$out"/source/config/*.ts)
for name in credential-binding provider-config model live-voice prompt live-remember live-declarations mongoose-auth; do
  entry+=("$out/source/test/$name.test.ts")
done
entry+=("$out/source/test/live-voice-fixture.ts")
node "$deps/typescript/bin/tsc" --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noUnusedLocals --noUnusedParameters --skipLibCheck \
  --types node --typeRoots "$deps/@types" --rootDir "$out/source" --outDir "$out/dist" \
  "${entry[@]}"
for name in credential-binding provider-config model live-voice prompt mongoose-auth; do
  node_test_files --test-reporter=tap --test-timeout=15000 "$out/dist/test/$name.test.js" | tee "$out/$name.log"
  grep -Eq '^# tests [1-9][0-9]*$' "$out/$name.log" || { echo "Zero selected $name tests" >&2; exit 1; }
done
