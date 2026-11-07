#!/usr/bin/env bash
# #853: a check that needs installed dependencies says one BLOCKED line naming the missing
# toolchain, instead of a stack of reds from module-not-found inside a bare worktree.
#
# The list is the repository's own declaration, config/lane-toolchain.json, so the message and the
# cut that populates a lane can never disagree:
#
#   . "$(dirname "$0")/lib-toolchain.sh"
#   toolchain_blocked || exit $?

toolchain_blocked() {
  local root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
  local missing
  missing=$(node - "$root" <<'node'
const fs = require('node:fs');
const path = require('node:path');
const [root] = process.argv.slice(2);
let entries;
try {
  entries = JSON.parse(fs.readFileSync(path.join(root, 'config', 'lane-toolchain.json'), 'utf8'));
} catch (error) {
  console.error(`config/lane-toolchain.json unreadable: ${error.message}`);
  process.exit(2);
}
process.stdout.write(entries
  .filter(entry => !fs.existsSync(path.join(root, entry.path)))
  .map(entry => `${entry.path} (${entry.source}${entry.install === undefined ? '' : `: ${entry.install}`})`)
  .join(', '));
node
  ) || return 2
  [ -n "$missing" ] || return 0
  printf '%s BLOCKED: toolchain not installed: %s. Run the declared install, or cut the lane from a seeded checkout.\n' \
    "$(basename "$0")" "$missing" >&2
  return 2
}
