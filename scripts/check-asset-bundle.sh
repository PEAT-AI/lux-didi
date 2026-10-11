#!/usr/bin/env bash
# Declared producer for the asset-only Didi bundle.
#
# It carries an executable red fixture first: a planted bundle that swaps the
# staged official Node for a host/Homebrew binary and adds an app label must be
# refused by this check's own verifier, so a green result is never vacuous. Only
# then does it build the real bundle with scripts/build-asset-bundle.sh, verify
# each stage, and drive the real bundled host from inside the bundle: the built
# shell answers 200, a one-time pairing captures a synthetic local note, and a
# restart on the same private state directory recalls that note.
#
# Asset-only: this check never signs and never claims the app. It asserts the
# bundle carries no codesign output, no Info.plist and no .app/.framework label.
set -euo pipefail
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
cd "$(dirname "$0")/.."
if test -n "$(git status --porcelain -- server web scripts/build-asset-bundle.sh scripts/check-asset-bundle.sh)"; then
  echo 'Asset bundle check requires clean, committed server and web source' >&2
  exit 1
fi
work=$(mktemp -d "${TMPDIR:-/tmp}/didi-asset-check.XXXXXX")
trap 'rm -rf "$work"' EXIT
bundle="$work/bundle"
state="$work/state"
mkdir -p "$bundle" "$state"

# Assert the staged bundle obeys the asset-only contract. Rejections print the
# decisive reason so a planted violation fails for the right reason.
verify_bundle() {
  local dir="$1" node exec version svc="$1/server/node_modules/@lux-didi/service"
  node="$dir/Resources/node/bin/node"
  if [ ! -f "$node" ]; then echo 'verify: bundled node is missing' >&2; return 1; fi
  if [ -L "$node" ]; then echo 'verify: bundled node is a symlink' >&2; return 1; fi
  version=$("$node" -p 'process.version' 2>/dev/null) || { echo 'verify: bundled node does not execute' >&2; return 1; }
  case "$version" in
    v2[6-9].*|v[3-9][0-9].*) ;;
    *) echo "verify: bundled node $version is below engines.node >=26.0.0" >&2; return 1;;
  esac
  exec=$("$node" -p 'process.execPath' 2>/dev/null) || { echo 'verify: bundled node does not report execPath' >&2; return 1; }
  case "$exec" in
    "$dir"/Resources/node/*) ;;
    *) echo "verify: node execPath is outside the bundle: $exec" >&2; return 1;;
  esac
  if [ ! -d "$svc/dist/tools" ] || [ -z "$(ls -A "$svc/dist/tools" 2>/dev/null)" ]; then
    echo 'verify: packaged closure is missing the compiled tools tree' >&2; return 1
  fi
  if [ ! -f "$svc/dist/host/index.js" ]; then echo 'verify: bundled host entry is missing' >&2; return 1; fi
  if /usr/bin/find "$dir" \( -name Info.plist -o -name _CodeSignature -o -name '*.app' -o -name '*.framework' \) -print -quit | grep -q .; then
    echo 'verify: asset bundle carries a signing or app claim' >&2; return 1
  fi
  if [ ! -f "$dir/Resources/web/dist/index.html" ]; then echo 'verify: built interface shell is missing' >&2; return 1; fi
  return 0
}

# --- Red fixture: planted violations must be refused for the right reason. ---
red="$work/red-fixture"
mkdir -p "$red/Resources/node/bin" "$red/Resources/web/dist" "$red/server/node_modules/@lux-didi/service/dist/host"
ln -s "$(command -v node)" "$red/Resources/node/bin/node"   # a host/Homebrew binary, never the staged official runtime
: > "$red/server/node_modules/@lux-didi/service/dist/host/index.js"
: > "$red/Resources/web/dist/index.html"
printf '<plist/>' > "$red/Info.plist"                       # an app label the asset bundle must never carry
if verify_bundle "$red" 2>"$work/red.err"; then
  echo 'red fixture: a planted bundle was accepted instead of refused' >&2
  exit 1
fi
if ! grep -q 'bundled node is a symlink' "$work/red.err"; then
  echo 'red fixture: refusal reason was not the planted violation' >&2
  cat "$work/red.err" >&2
  exit 1
fi
printf 'RED_FIXTURE refused: %s\n' "$(cat "$work/red.err")"

# --- Green path: build the real bundle, then verify every stage. ---
bash scripts/build-asset-bundle.sh "$bundle"
verify_bundle "$bundle" || exit 1
node_bin="$bundle/Resources/node/bin/node"
recorded=$(sed -n 's/^node=v//p' "$bundle/ASSET-BUNDLE.txt")
if [ "v${recorded}" != "$("$node_bin" -p 'process.version')" ]; then
  echo 'verify: manifest node version disagrees with the bundled runtime' >&2
  exit 1
fi
printf 'ASSET_BUNDLE_VERIFIED=%s node=v%s\n' "$bundle" "$recorded"

# --- Real host from inside the bundle: shell, pairing, synthetic note, restart recall. ---
cat > "$work/drive.mjs" <<'DRIVER'
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const [bundle, state] = process.argv.slice(2);
const node = join(bundle, 'Resources', 'node', 'bin', 'node');
const entry = join(bundle, 'server', 'node_modules', '@lux-didi', 'service', 'dist', 'host', 'index.js');
const web = join(bundle, 'Resources', 'web', 'dist');
const descriptor = join(state, 'host-runtime.json');
if (!process.execPath.startsWith(bundle + '/')) throw new Error(`driver does not run on the bundled node: ${process.execPath}`);
const marker = `syntheticnote${Math.random().toString(16).slice(2, 10)}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function launch() {
  const child = spawn(node, [entry, '--data-dir', state, '--web-root', web, '--port', '0'], { cwd: bundle, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  return { child, log: () => log };
}
async function origin() {
  for (let i = 0; i < 300; i++) {
    if (existsSync(descriptor)) {
      try { const data = JSON.parse(readFileSync(descriptor, 'utf8')); if (typeof data.origin === 'string') return data.origin; } catch {}
    }
    await sleep(100);
  }
  throw new Error('host runtime descriptor was not published');
}
async function stop(running) {
  if (running.child.exitCode !== null || running.child.signalCode !== null) return;
  const exited = new Promise(resolve => running.child.once('exit', resolve));
  running.child.kill('SIGTERM');
  await Promise.race([exited, sleep(5000)]);
  if (running.child.exitCode === null && running.child.signalCode === null) {
    running.child.kill('SIGKILL');
    await new Promise(resolve => running.child.once('exit', resolve));
  }
}
async function pair(orig) {
  const credential = readFileSync(join(state, 'admin-credential'), 'utf8').trim();
  const requested = await fetch(`${orig}/api/v1/auth/pairing`, { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, body: '{}' });
  if (requested.status !== 200) throw new Error(`pairing request ${requested.status} ${await requested.text()}`);
  const { pairingCode } = (await requested.json()).data;
  const paired = await fetch(`${orig}/api/v1/auth/pair`, { method: 'POST', headers: { Origin: orig, 'Content-Type': 'application/json' }, body: JSON.stringify({ pairingCode }) });
  if (paired.status !== 200) throw new Error(`pair ${paired.status} ${await paired.text()}`);
  const cookie = paired.headers.getSetCookie()[0].split(';')[0];
  const { csrfToken } = (await paired.json()).data;
  return { cookie, csrfToken };
}
async function authorityEpoch(orig, auth) {
  const response = await fetch(`${orig}/api/v1/status`, { headers: { Cookie: auth.cookie } });
  if (response.status !== 200) throw new Error(`status ${response.status}`);
  return (await response.json()).data.authorityEpoch;
}
function mutation(orig, auth, epoch) {
  return { Cookie: auth.cookie, Origin: orig, 'X-Didi-CSRF': auth.csrfToken, 'x-didi-authority-epoch': epoch, 'Idempotency-Key': crypto.randomUUID(), 'Content-Type': 'application/json' };
}
async function shell(orig) {
  const page = await fetch(`${orig}/`);
  if (page.status !== 200) throw new Error(`shell ${page.status}`);
  const asset = /(?:src|href)="(\/assets\/[^"?#]+\.js)"/.exec(await page.text());
  if (!asset) throw new Error('built shell exposes no compiled script asset');
  const compiled = await fetch(orig + asset[1]);
  if (compiled.status !== 200) throw new Error(`asset ${compiled.status}`);
  console.log(`ASSET_BUNDLE_SHELL ${orig} ${asset[1]} 200`);
}
async function capture(orig, auth, epoch) {
  const created = await fetch(`${orig}/api/v1/sessions`, { method: 'POST', headers: mutation(orig, auth, epoch), body: JSON.stringify({ title: 'Synthetic asset-bundle note', timeZone: 'UTC' }) });
  if (created.status !== 200) throw new Error(`createSession ${created.status} ${await created.text()}`);
  const sessionId = (await created.json()).data.id;
  const appended = await fetch(`${orig}/api/v1/sessions/${sessionId}/entries`, { method: 'POST', headers: mutation(orig, auth, epoch), body: JSON.stringify({ text: `synthetic local note ${marker}`, role: 'user', timeZone: 'UTC' }) });
  if (appended.status !== 200) throw new Error(`appendEntry ${appended.status} ${await appended.text()}`);
}
async function recall(orig, auth) {
  const response = await fetch(`${orig}/api/v1/recall?q=${marker}&limit=10`, { headers: { Cookie: auth.cookie } });
  if (response.status !== 200) throw new Error(`recall ${response.status} ${await response.text()}`);
  return (await response.json()).data;
}

const first = launch();
try {
  const orig = await origin();
  const auth = await pair(orig);
  await shell(orig);
  const epoch = await authorityEpoch(orig, auth);
  console.log(`ASSET_BUNDLE_HOST ${orig} authorityEpoch=${epoch}`);
  await capture(orig, auth, epoch);
  const before = await recall(orig, auth);
  if (before.totalMatches < 1) throw new Error('captured note was not recalled before restart');
  console.log(`ASSET_BUNDLE_CAPTURE note=${marker} totalMatches=${before.totalMatches}`);
} finally { await stop(first); }

rmSync(descriptor, { force: true });
const second = launch();
try {
  const orig = await origin();
  const auth = await pair(orig);
  const after = await recall(orig, auth);
  if (after.totalMatches < 1) throw new Error('note was not recalled after restart');
  console.log(`ASSET_BUNDLE_RESTART_RECALL note=${marker} totalMatches=${after.totalMatches}`);
} finally { await stop(second); }
console.log('ASSET_BUNDLE_E2E_OK');
DRIVER
"$node_bin" "$work/drive.mjs" "$bundle" "$state"

# No process started by this check may be left running.
if ps -axo pid=,command= | grep -F "$bundle/server/node_modules/@lux-didi/service/dist/host/index.js" | grep -v grep | grep -q .; then
  echo 'a host process started by the check is still running' >&2
  exit 1
fi
printf 'ASSET_BUNDLE_NO_LEFTOVER_PROCESS\nASSET_BUNDLE_CHECK_PASS\n'
