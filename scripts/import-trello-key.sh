#!/usr/bin/env bash
# Import the owner's own Trello API key and token into Didi's private provider configuration.
#
# Usage: scripts/import-trello-key.sh <env-file> <config-dir>
#
# The env file carries the names the `trello` CLI uses, TRELLO_API_KEY and TRELLO_TOKEN (also accepted:
# TRELLO_KEY). Only the two values are read; nothing in the file is executed and no value is ever
# printed. The output is <config-dir>/trello-key.json, mode 0600, the file the connector reads.
set -euo pipefail

usage() {
  echo 'usage: scripts/import-trello-key.sh <env-file> <config-dir>' >&2
  exit 2
}

[ "$#" -eq 2 ] || usage
env_file=$1
config_dir=$2
[ -f "$env_file" ] || { echo "import-trello-key: no env file at $env_file" >&2; exit 1; }
[ -d "$config_dir" ] || { echo "import-trello-key: no configuration directory at $config_dir" >&2; exit 1; }

# Read one assignment from the env file: the last one wins, surrounding quotes are dropped.
value_of() {
  sed -n "s/^[[:space:]]*export[[:space:]]\{1,\}$1[[:space:]]*=[[:space:]]*//p;s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$env_file" \
    | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/" -e 's/[[:space:]]*$//'
}

key=$(value_of TRELLO_API_KEY)
[ -n "$key" ] || key=$(value_of TRELLO_KEY)
token=$(value_of TRELLO_TOKEN)

if [ -z "$key" ] || [ -z "$token" ]; then
  echo 'import-trello-key: the env file has no TRELLO_API_KEY and TRELLO_TOKEN' >&2
  exit 1
fi

out="$config_dir/trello-key.json"
if [ -L "$out" ]; then
  echo "import-trello-key: $out is a symlink; refusing to write through it" >&2
  exit 1
fi

# The values travel in the environment of one short child, never on a command line and never in a log.
umask 077
KEY=$key TOKEN=$token OUT=$out node -e '
const { writeFileSync, chmodSync } = require("node:fs");
const path = process.env.OUT;
writeFileSync(path, JSON.stringify({ key: process.env.KEY, token: process.env.TOKEN }) + "\n", { mode: 0o600, flag: "w" });
chmodSync(path, 0o600);
'

printf 'import-trello-key: wrote %s (0600)\n' "$out"
