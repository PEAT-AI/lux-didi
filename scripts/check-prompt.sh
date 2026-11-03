#!/usr/bin/env bash
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/lib/node-test-files.sh"
export CI=1 OMP_NUM_THREADS=1 VECLIB_MAXIMUM_THREADS=1
root="$(cd "$(dirname "$0")/.." && pwd)"
# SERVICE owns installation; this lane never downloads or changes manifests.
deps="${DIDI_TYPESCRIPT_ROOT:-$root/server/node_modules}"
if [[ ! -f "$deps/typescript/bin/tsc" ]]; then
  deps="$root/../lux-didi-service/server/node_modules"
fi
if [[ ! -f "$deps/typescript/bin/tsc" || ! -d "$deps/@types/node" ]]; then
  echo 'PROMPT CHECK BLOCKED: installed SERVICE TypeScript/@types/node required' >&2
  exit 2
fi
out="$(mktemp -d "${TMPDIR:-/tmp}/didi-prompt.XXXXXX")"
trap 'rm -rf "$out"' EXIT
cd "$root"
# Stage only this unit under a temporary ESM marker, so the isolated worktree
# follows SERVICE's actual NodeNext conventions without a competing manifest.
mkdir -p "$out/source/tasks" "$out/source/adapters/model" "$out/source/adapters/live-voice" "$out/source/adapters/mcp" "$out/source/connectors" "$out/source/test" "$out/source/prompt" "$out/source/tools" "$out/source/host" "$out/source/http" "$out/source/config" "$out/source/contracts" "$out/source/trace" "$out/source/domain" "$out/source/live"
cp server/adapters/model/*.ts "$out/source/adapters/model/"
cp server/adapters/live-voice/types.ts "$out/source/adapters/live-voice/"
# #562: the prompt content test reads the accepted Live instruction through the adapter, so the adapter
# and the two modules it imports are staged; nothing else of the adapter tree is compiled.
cp server/adapters/live-voice/openai.ts server/adapters/live-voice/resample.ts server/adapters/live-voice/audio-level.ts "$out/source/adapters/live-voice/"
# The adapter types name the host's trace port (O1b-A), so stage the trace kinds and the record door.
cp server/trace/kinds.ts server/trace/record.ts server/trace/clock.ts "$out/source/trace/"
cp server/domain/history-turns.ts server/domain/history-reader.ts server/domain/history-lifecycle.ts server/domain/util.ts server/domain/contract.ts "$out/source/domain/"
cp server/adapters/mcp/port.ts server/adapters/mcp/registry.ts "$out/source/adapters/mcp/"
cp server/connectors/google.ts "$out/source/connectors/"
cp server/tools/vault-write.ts server/tools/lux-note.ts server/tools/find-file.ts "$out/source/tools/"
cp server/tasks/*.ts "$out/source/tasks/"
# W7: the Trello tool descriptions are voice content too.
cp server/tools/trello.ts "$out/source/tools/"
cp server/tools/redact.ts "$out/source/tools/"
cp server/tools/refusal-cause.ts server/tools/declarations.ts server/tools/normalize.ts server/tools/host-events.ts server/tools/research.ts server/tools/intent.ts server/tools/live-shape.ts server/tools/open-handles.ts server/tools/open.ts server/tools/types.ts server/tools/history.ts server/tools/diagnostic-input.ts server/tools/canonical.ts server/tools/received-body.ts server/tools/remember.ts server/tools/calendar-window.ts server/tools/web-search.ts server/tools/chat-intent.ts server/tools/google.ts server/tools/lux-knowledge.ts server/tools/mongoose.ts server/tools/mattermost.ts "$out/source/tools/"
cp server/prompt/*.ts "$out/source/prompt/"
cp server/tasks/instructions.ts "$out/source/tasks/"
# W15: the persona, the tools and the connectors resolve people through the host snapshot, so the
# staging tree carries that module and its import closure too.
mkdir -p "$out/source/people"
cp server/people/*.ts "$out/source/people/"
cp server/host/log.ts "$out/source/host/"
# L2: host/log.ts re-exports the call-context helpers from host/events.ts, so stage that module too.
cp server/host/events.ts "$out/source/host/"
# host/log.ts names the stop gate constants, so stage the module it imports.
cp server/live/stop-phrase.ts server/live/tool-outcome.ts "$out/source/live/"
# The latency wagon made host/log.ts import the mongoose connector's clock, so stage that module too.
cp server/connectors/*.ts "$out/source/connectors/"
# The live-voice adapters import the alarm mode marker, so stage its module too.
cp server/live/alarm-mode.ts "$out/source/live/"
cp server/http/routes.ts "$out/source/http/"
cp server/config/files.ts server/config/owner-profile.ts "$out/source/config/"
cp server/contracts/*.ts "$out/source/contracts/"
cp server/test/prompt.test.ts server/test/model.test.ts server/test/live-persona.test.ts server/test/runtime-context.test.ts server/test/research.test.ts server/test/research-shape.test.ts server/test/research-schema-parity.test.ts server/test/research-web.test.ts server/test/research-routed.test.ts server/test/research-calendar.test.ts server/test/research-coverage.test.ts server/test/research-drive.test.ts server/test/chat-prompt.test.ts "$out/source/test/"
# W11-R1: server/test/research-mail-query.test.ts lands from fix/w11-mail-queries-1021; stage it
# whenever this tree carries it, so this check is green on either side of that merge.
[[ -f server/test/research-mail-query.test.ts ]] && cp server/test/research-mail-query.test.ts "$out/source/test/"
printf '{"type":"module"}\n' > "$out/package.json"
# The staged declarations import ws and the MCP SDK types: resolve them from the one installed tree.
ln -s "$deps" "$out/node_modules"
node "$deps/typescript/bin/tsc" --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --noUnusedLocals --noUnusedParameters --skipLibCheck \
  --types node --typeRoots "$deps/@types" --rootDir "$out/source" --outDir "$out/dist" \
  "$out"/source/adapters/model/*.ts "$out"/source/adapters/live-voice/openai.ts "$out"/source/prompt/*.ts "$out"/source/tools/*.ts "$out"/source/test/*.ts
test -f "$out/dist/test/prompt.test.js" # fresh mktemp output; no stale dist accepted
tests=("$out/dist/test/prompt.test.js" "$out/dist/test/model.test.js" "$out/dist/test/live-persona.test.js" "$out/dist/test/runtime-context.test.js" "$out/dist/test/research.test.js" "$out/dist/test/research-shape.test.js" "$out/dist/test/research-schema-parity.test.js" "$out/dist/test/research-web.test.js" "$out/dist/test/research-routed.test.js" "$out/dist/test/research-calendar.test.js" "$out/dist/test/research-coverage.test.js" "$out/dist/test/research-drive.test.js" "$out/dist/test/chat-prompt.test.js")
# W11-R1: server/test/research-mail-query.test.ts lands from fix/w11-mail-queries-1021; stage and run
# it here whenever this tree carries it, so this check is green on either side of that merge.
if [[ -f "$out/source/test/research-mail-query.test.ts" ]]; then
  tests+=("$out/dist/test/research-mail-query.test.js")
fi
node_test_files --test-reporter=tap --test-timeout=15000 "${tests[@]}" | tee "$out/results.tap"
grep -Eq "^# tests [1-9][0-9]*$" "$out/results.tap"
# #562: the accepted prompt content, byte for byte, over the same strict compile staged above.
mkdir -p "$out/test/fixtures"
cp server/test/prompt-content.integration.mjs "$out/test/"
cp server/test/fixtures/prompt-final.json server/test/fixtures/prompt-character-excluded.json "$out/test/fixtures/"
# C-LIVE (W5): the partial-result rules, asserted on the compiled text the voice model and its backend receive.
# The removed phrases made the backend page a partial result silently; each new rule is pinned by its own words.
node --input-type=module - "$out/dist" <<'NODE'
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const dist = process.argv[2];
const persona = await import(pathToFileURL(`${dist}/prompt/live-persona.js`).href);
const voice = persona.NAYA_WORK_DELIVERY;
const { WORKER_INSTRUCTIONS: worker } = await import(pathToFileURL(`${dist}/tasks/instructions.js`).href);
assert.ok(worker.length <= 3000);
for (const text of [voice, worker]) {
  assert.doesNotMatch(text, /research|[\u2013\u2014]/i);
  assert.doesNotMatch(text, /["“][^"”]+["”]/);
}
assert.match(voice, /# Work and spoken delivery/);
assert.match(voice, /MUST be handed off in the same turn/);
assert.doesNotMatch(voice, /research|[\u2013\u2014]|\b(?:open_web|draft_email|stage_lux_note)\b/i);
assert.doesNotMatch(voice, /["“][^"”]+["”]/);
const composed = persona.composeLiveInstruction({ base: persona.NAYA_LIVE_BASE });
assert.ok(composed.text.includes(voice));
assert.equal(composed.sections.find(section => section.id === 'tools').chars, voice.length);
console.log(JSON.stringify({ case: 'client_mode_work_delivery', chars: composed.text.length, toolsChars: voice.length }));
NODE
# W4 (truth about her own state): the connector line is host-computed, and the persona is bound to it, so a
# sign-in is never claimed or denied from guesswork. The voice rules for a changed voice and the "okay?" tag
# are pinned here, beside the ceiling they are paid for.
node --input-type=module - "$out/dist" <<'NODE'
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const dist = process.argv[2];
const persona = await import(pathToFileURL(`${dist}/prompt/live-persona.js`).href);
const runtime = await import(pathToFileURL(`${dist}/prompt/runtime-context.js`).href);
const state = runtime.buildRuntimeContext({ now: new Date('2026-10-27T12:00:00Z'), timeZone: 'UTC',
  connected: ['company knowledge'],
  connectors: [{ connector: 'mongoose', state: 'connected' }, { connector: 'google', state: 'error', reasonCode: 'not_signed_in' }] });
assert.match(state, /^Connectors: company knowledge connected; calendar not signed in; mail not signed in\. Never deny or claim a sign-in or a capability without this line or a live tool check, and never name a place to change it that this line does not name\.$/mu,
  'the runtime line carries the live state and the no-denial rule');
assert.doesNotMatch(runtime.buildRuntimeContext({ now: new Date('2026-10-27T12:00:00Z'), timeZone: 'UTC', connected: [] }), /^Connectors:/mu,
  'no connector line without host rows');
// W4 F7: the bucket comes from the host's own sign-in codes, so a credential that failed identity proof is a
// sign-in and not plain unavailability; a transport failure stays unavailable.
for (const reasonCode of ['credential_missing', 'credential-unavailable', 'credential-identity-mismatch', 'credential-identity-unverified', 'identity_mismatch']) {
  const one = runtime.buildRuntimeContext({ now: new Date('2026-10-27T12:00:00Z'), timeZone: 'UTC', connected: [],
    connectors: [{ connector: 'mongoose', state: 'error', reasonCode }] });
  assert.match(one, /^Connectors: company knowledge not signed in\./mu, `host sign-in code classified as a sign-in: ${reasonCode}`);
}
for (const rule of ['say you cannot hear it', 'never say you are unchanged', 'End no answer with "okay?" as a reflex']) {
  assert.ok(persona.NAYA_VOICE_SURFACE.includes(rule), `the voice surface states the truth rule: ${rule}`);
}
// C-TURN8: the one corrective line the host sends for a claim without its call is voice content, one
// sentence, inside the instruction ceiling (#693), and free of dash prose.
assert.ok(persona.CLAIM_WITHOUT_CALL_LINE.length > 0 && persona.CLAIM_WITHOUT_CALL_LINE.length <= 160,
  'the claim correction stays one short instruction inside the voice ceiling');
assert.doesNotMatch(persona.CLAIM_WITHOUT_CALL_LINE, /[\u2013\u2014]/, 'no dash prose reaches her voice');
assert.match(persona.CLAIM_WITHOUT_CALL_LINE, /^Correction: /, 'she hears it as the host correcting her');
assert.match(persona.CLAIM_WITHOUT_CALL_LINE, /make the call now/i, 'it offers the call');
assert.match(persona.CLAIM_WITHOUT_CALL_LINE, /say plainly that you are not checking anything/, 'it offers the plain refusal');
// C-CLAIMS9 outcome 2: an approval is a closed reason said in plain words, with no invented place to fix it.
const approval = runtime.buildRuntimeContext({ now: new Date('2026-10-28T10:21:00Z'), timeZone: 'UTC', connected: [],
  connectors: [{ connector: 'mattermost', state: 'error', configurationError: 'owner-approval-required' }] });
assert.match(approval, /^Connectors: team chat needs approval, and there is no approval control in the app: she cannot fix it from this call\./mu,
  'an approval-type reason states that no approval control exists in the app');
assert.doesNotMatch(approval, /settings|preferences|dashboard|control panel|control centre|control center/iu,
  'no settings location is named in the connector line');
assert.match(approval, /never name a place to change it that this line does not name/u,
  'and the guidance forbids naming a place the line does not name');
const notConnected = runtime.buildRuntimeContext({ now: new Date('2026-10-28T10:21:00Z'), timeZone: 'UTC', connected: [],
  connectors: [{ connector: 'mattermost', state: 'error', reasonCode: 'not_connected' }] });
assert.match(notConnected, /^Connectors: team chat not connected\./mu, 'a connector the host reports as not connected says so in plain words');
console.log(JSON.stringify({ case: 'connector_truth', approvalNoControl: true, noSettingsLocation: true, notConnected: true }));
// C-CLAIMS9 outcome 2, W3-R2: the rule holds on a session with no connector rows too, where no connector line
// is built at all, so it lives in the voice surface the model always receives.
assert.ok(persona.NAYA_VOICE_SURFACE.includes('Never name a settings or approval location the connector state line does not name.'),
  'the voice surface forbids naming a location the connector state line does not name, with or without connector rows');
console.log(JSON.stringify({ case: 'connector_truth_without_rows', voiceRule: true }));
NODE

# C-RECALL104: retained conversations are research-backed, never invented quotes.
node --input-type=module - "$out/dist" <<'NODE'
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const persona = await import(pathToFileURL(`${process.argv[2]}/prompt/live-persona.js`).href);
assert.ok(persona.NAYA_LIVE_BASE.includes('look back over past conversations word for word through research'));
assert.ok(persona.NAYA_LIVE_BASE.includes('Quote only what research returned; never invent a past quote.'));
assert.ok(!persona.NAYA_LIVE_BASE.includes('the full conversation does not'));
NODE

# F12: the distillation prompt is the one place long-term memory is written from a call, so its attribution and
# its closed tool-evidence rule are asserted here, on the source the summarizer service ships.
grep -Fq 'is never written as "the owner said"' server/services/summarize.ts
grep -Fq 'Never quote or paraphrase tool guidance, instructions, refusal messages, validator text' server/services/summarize.ts
grep -Fq "Only what the Owner-tagged transcript turns actually contain may be attributed to the owner." server/services/summarize.ts
printf '%s\n' 'F12 summary attribution and closed tool evidence: PASS'

# Keep the full golden-fixture integration gate, after independent policy evidence.
node "$out/test/prompt-content.integration.mjs"
