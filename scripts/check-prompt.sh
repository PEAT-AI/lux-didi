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
# Compile the prompt test graph from the real source tree. Removed research modules
# are not staged, and TypeScript resolves each current transitive dependency itself.
printf '{"type":"module"}\n' > "$out/package.json"
ln -s "$deps" "$out/node_modules"
sources=(server/test/prompt.test.ts server/test/model.test.ts server/test/live-persona.test.ts
  server/test/runtime-context.test.ts server/test/chat-prompt.test.ts)
# The plain-JS integration imports the retained Text history tool outside the TS test graph.
node "$deps/typescript/bin/tsc" --target ES2023 --module NodeNext --moduleResolution NodeNext \
  --strict --noUnusedLocals --noUnusedParameters --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --skipLibCheck --types node --typeRoots "$deps/@types" --rootDir "$root/server" --outDir "$out/dist" "${sources[@]}" server/tools/history.ts
tests=()
for source in "${sources[@]}"; do
  name="${source##*/}"
  tests+=("$out/dist/test/${name%.ts}.js")
done
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
assert.ok(worker.length <= 4267);
for (const text of [voice, worker]) {
  assert.doesNotMatch(text, /research|[\u2013\u2014]/i);
  assertNoRecitation(text);
}
assert.match(voice, /# Work and spoken delivery/);
assert.match(voice, /MUST be handed off in the same turn/);
// 10.11: each new rule is a judgment she applies, and neither public text carries a said line.
for (const rule of [
  'Everything else is yours and you answer it yourself',
  'Speak of looking something up only in the turn you hand it off',
  'Word may also be that nothing needs looking up',
  'You cannot see work in progress',
  'give what is there rather than only that it is incomplete',
  'no reflex tag',
  'the floor stays his',
]) assert.ok(voice.includes(rule) || persona.NAYA_VOICE_SURFACE.includes(rule), `the new conduct is stated: ${rule}`);
for (const rule of [
  'She speaks what you write, so you decide what he hears',
  'To him there is one companion, never two',
  'returns no_action, so that she answers it herself',
  'start with the smallest set that can answer it',
  'Use a returned reference only with its own reader',
  'give all of it now',
  'answered only from verified host status and task evidence',
]) assert.ok(worker.includes(rule), `the new helper rule is stated: ${rule}`);
assert.doesNotMatch(voice, /"/, 'the voice conduct hands her no quoted line to say');
const backchannel = persona.NAYA_VOICE_SURFACE.slice(persona.NAYA_VOICE_SURFACE.indexOf('# Backchannel policy'),
  persona.NAYA_VOICE_SURFACE.indexOf('# Ending the call'));
assert.ok(backchannel.length > 0, 'the backchannel paragraph is present');
assert.doesNotMatch(backchannel, /"/, 'the backchannel paragraph hands her no quoted line to say');
assert.doesNotMatch(worker, /"/, 'the helper conduct hands her no quoted line to say');
const { TASK_TOOL_NAMES } = await import(pathToFileURL(`${dist}/tasks/tools.js`).href);
function assertNoRecitation(text) {
  assert.doesNotMatch(text, /["“][^"”]+["”]/);
  // Apostrophes inside words are contractions or possessives, not opening quotation marks.
  assert.doesNotMatch(text, /(?<![\p{L}\p{N}_])['‘](?=\S)[^\n]*?['’](?![\p{L}\p{N}_])/u);
}
function assertVoicePolicy(text) {
  assert.doesNotMatch(text, /research|[\u2013\u2014]/i);
  assertNoRecitation(text);
  for (const name of TASK_TOOL_NAMES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.doesNotMatch(text, new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu'), `voice names registered tool: ${name}`);
  }
}
assertVoicePolicy(voice);
for (const quote of ["Say 'I have the result.'", "Say 'I'm ready.'", 'Say ‘I have the result.’']) {
  assert.throws(() => assertVoicePolicy(`${voice}\n\n${quote}`), { name: 'AssertionError' }, `voice recitation rejected: ${quote}`);
  assert.throws(() => assertNoRecitation(`${worker}\n\n${quote}`), { name: 'AssertionError' }, `worker recitation rejected: ${quote}`);
}
assert.ok(TASK_TOOL_NAMES.size > 0);
for (const name of TASK_TOOL_NAMES) {
  assert.throws(() => assertVoicePolicy(`${voice}\n\nCall ${name}.`), { name: 'AssertionError' }, `registered tool rejected: ${name}`);
}
for (const prose of ["It's the owner's choice; don't invent facts.", "I'm listening, and I won't guess.", "The owners' plans aren't final.", 'She’s listening; it isn’t settled.', "An opened door isn't a tool call."]) {
  assert.doesNotThrow(() => assertVoicePolicy(`${voice}\n\n${prose}`), `ordinary voice prose accepted: ${prose}`);
  assert.doesNotThrow(() => assertNoRecitation(`${worker}\n\n${prose}`), `ordinary worker prose accepted: ${prose}`);
}
console.log(JSON.stringify({ case: 'voice_policy_guard_fixtures', registeredTools: TASK_TOOL_NAMES.size, quotedRecitations: 3, ordinaryProse: 5 }));
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
for (const rule of ['say you cannot hear it', 'never say you are unchanged', 'no reflex tag']) {
  assert.ok(persona.NAYA_VOICE_SURFACE.includes(rule), `the voice surface states the truth rule: ${rule}`);
}
// Result honesty belongs to the work policy, not a host-authored line for her to say.
assert.equal(persona.CLAIM_WITHOUT_CALL_LINE, undefined);
assert.ok(persona.NAYA_WORK_DELIVERY.includes('Say something happened only when a result says it happened.'));
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
assert.ok(persona.NAYA_LIVE_BASE.includes('look back over past conversations word for word through what the helper returned'));
assert.ok(persona.NAYA_LIVE_BASE.includes('Quote only what the helper returned; never invent a past quote.'));
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
