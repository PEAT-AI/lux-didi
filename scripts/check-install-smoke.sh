#!/usr/bin/env bash
# The install research smoke (#598), against the repo build.
#
# Builds server/ and runs server/test/smoke/install-research-smoke.mjs against server/dist: the same file the
# installer runs against a bundle, in its default mode. It starts no host, opens no port and makes no network
# call (every fetch is intercepted); it fails unless the run prints networkCalls: 0 and removes its store.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
root="$(pwd)"
work=$(mktemp -d "${TMPDIR:-/tmp}/didi-install-smoke.XXXXXX")
trap 'rm -rf "$work"' EXIT
# Distinct isolated configuration files; never inherit account npm configuration.
printf '# isolated user config\n' > "$work/npm-user"
printf '# isolated global config\n' > "$work/npm-global"
export npm_config_userconfig="$work/npm-user" npm_config_globalconfig="$work/npm-global"
cd "$root/server"
npm run build
cd "$root"
node server/test/smoke/install-research-smoke.mjs | tee "$work/smoke.log"
grep -qx 'INSTALL RESEARCH SMOKE PASS' "$work/smoke.log" || { echo 'The install research smoke did not pass' >&2; exit 1; }
grep -qx 'networkCalls: 0' "$work/smoke.log" || { echo 'The install research smoke reported a network call' >&2; exit 1; }
grep -qx 'syntheticStoreRemoved: true' "$work/smoke.log" || { echo 'The install research smoke left its synthetic store' >&2; exit 1; }
