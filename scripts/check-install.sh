#!/bin/bash
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
# PATH discovery is test/build tooling only; the packaged runtime requires --node.
node_tool="$(command -v node)"
bash -n scripts/check-install.sh
"$node_tool" --check scripts/package-local.mjs
"$node_tool" --check scripts/install-local.mjs
"$node_tool" scripts/package-local.mjs --help
"$node_tool" scripts/install-local.mjs --help
"$node_tool" --test --test-timeout=30000 Tests/DidiInstallTests/*.test.mjs
# This is an acceptance gate, not a fake-artifact success fallback.
"$node_tool" scripts/package-local.mjs --check-prerequisites --source-commit "$(git rev-parse HEAD)"
printf '%s\n' 'PACKAGE ACCEPTANCE NOT COMPLETE: root must supply accepted installed noninteractive proof argv before real relocated app/service gate can be implemented.' >&2
exit 1
