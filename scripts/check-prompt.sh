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
mkdir -p "$out/source/adapters/model" "$out/source/adapters/live-voice" "$out/source/adapters/mcp" "$out/source/connectors" "$out/source/test" "$out/source/prompt" "$out/source/tools" "$out/source/host" "$out/source/http" "$out/source/config" "$out/source/contracts" "$out/source/trace" "$out/source/domain" "$out/source/live"
cp server/adapters/model/*.ts "$out/source/adapters/model/"
cp server/adapters/live-voice/types.ts "$out/source/adapters/live-voice/"
# #562: the prompt content test reads the accepted Live instruction through the adapter, so the adapter
# and the two modules it imports are staged; nothing else of the adapter tree is compiled.
cp server/adapters/live-voice/openai.ts server/adapters/live-voice/resample.ts server/adapters/live-voice/audio-level.ts "$out/source/adapters/live-voice/"
# The adapter types name the host's trace port (O1b-A), so stage the trace kinds and the record door.
cp server/trace/kinds.ts server/trace/record.ts server/trace/clock.ts "$out/source/trace/"
cp server/domain/history-reader.ts server/domain/history-lifecycle.ts server/domain/util.ts server/domain/contract.ts "$out/source/domain/"
cp server/adapters/mcp/port.ts server/adapters/mcp/registry.ts "$out/source/adapters/mcp/"
cp server/connectors/google.ts "$out/source/connectors/"
cp server/tools/vault-write.ts "$out/source/tools/"
# W7: the Trello tool descriptions are voice content too.
cp server/tools/trello.ts "$out/source/tools/"
cp server/tools/redact.ts "$out/source/tools/"
cp server/tools/declarations.ts server/tools/host-events.ts server/tools/research.ts server/tools/intent.ts server/tools/live-shape.ts server/tools/open-handles.ts server/tools/open.ts server/tools/types.ts server/tools/history.ts server/tools/diagnostic-input.ts server/tools/canonical.ts server/tools/received-body.ts server/tools/remember.ts server/tools/calendar-window.ts server/tools/web-search.ts server/tools/chat-intent.ts "$out/source/tools/"
cp server/prompt/*.ts "$out/source/prompt/"
# W15: the persona, the tools and the connectors resolve people through the host snapshot, so the
# staging tree carries that module and its import closure too.
mkdir -p "$out/source/people"
cp server/people/*.ts "$out/source/people/"
cp server/host/log.ts "$out/source/host/"
# L2: host/log.ts re-exports the call-context helpers from host/events.ts, so stage that module too.
cp server/host/events.ts "$out/source/host/"
# host/log.ts names the stop gate constants, so stage the module it imports.
cp server/live/stop-phrase.ts "$out/source/live/"
cp server/http/routes.ts "$out/source/http/"
cp server/config/files.ts "$out/source/config/"
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
node "$out/test/prompt-content.integration.mjs"
# C-LIVE (W5): the partial-result rules, asserted on the compiled text the voice model and its backend receive.
# The removed phrases made the backend page a partial result silently; each new rule is pinned by its own words.
node --input-type=module - "$out/dist" <<'NODE'
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const dist = process.argv[2];
const persona = await import(pathToFileURL(`${dist}/prompt/live-persona.js`).href);
const backend = await import(pathToFileURL(`${dist}/prompt/backend-procedure.js`).href);
const research = await import(pathToFileURL(`${dist}/tools/research.js`).href);
const open = await import(pathToFileURL(`${dist}/tools/open.js`).href);
const voice = persona.NAYA_VOICE_TOOLS;
const procedure = backend.NAYA_BACKEND_PROCEDURE;
const everything = [persona.NAYA_LIVE_BASE, voice, procedure, persona.NAYA_TOOLS, JSON.stringify(research.RESEARCH)].join('\n');
for (const removed of [
  'continue the same research automatically',
  'Silence while you look something up is fine',
  'Continue a partial result without asking for permission',
  'There is more available if you want it',
  'back as a permission question',
  'follow a plausible next source once',
]) assert.ok(!everything.includes(removed), `removed rule still present: ${removed}`);
for (const rule of [
  'One owner turn allows two research operations',
  'after a result arrives, never call research again until the owner speaks, except to stop',
  'Answer at once from a result, even a partial one',
  'state its coverage honestly in a few words, such as nine of thirty-eight events',
  'never call a partial result complete',
  'lead with the answer and the qualification that changes its meaning',
  'offer it in one short plain statement, not a question and not a stock line',
  'If research answers blocked, answer from the result you have',
]) assert.ok(voice.includes(rule), `voice rule missing: ${rule}`);
for (const rule of [
  'One owner turn allows two research operations',
  'Continue a run with its researchId only when the owner asks for more',
  'If research answers blocked, do not call it again in this turn',
]) assert.ok(procedure.includes(rule), `backend rule missing: ${rule}`);
// The no-filler rule and the eight-line reply bound stay as they were.
assert.ok(persona.NAYA_LIVE_BASE.includes('Only the host bridges lookups'), 'the no-filler rule is kept');
// C-CONVO9 and W6-R1: new conversation rules pay for themselves within the existing sections.
assert.ok(persona.NAYA_CHARACTER.length <= 2868);
assert.ok(persona.NAYA_VOICE_SURFACE.length <= 2206);
for (const rule of ['at most once per call', 'under thirty seconds with at most two spoken numbers',
  'put it in a document', 'stage_lux_note', 'host note, not the owner', 'never agree with the host',
  'A progress phrase is not reused', 'No backchannel words while he is speaking']) {
  assert.ok(persona.NAYA_LIVE_BASE.includes(rule), `conversation rule missing: ${rule}`);
}
// C-OPEN: a failed open is never given an invented reason, and the guidance names the real refusal.
assert.ok(persona.NAYA_OPEN_SURFACE.includes('Never invent a failed-open reason'), 'the open surface bans an invented reason');
assert.ok(persona.NAYA_OPEN_SURFACE.includes('retry once with the same handle'), 'the open surface retries on a repeated ask');
for (const code of ['no_open_intent', 'not_allowed']) {
  assert.ok(open.OPEN_GUIDANCE[code].includes('same handle'), `the ${code} guidance asks for the same handle on a retry`);
}
assert.equal(open.OPEN_GUIDANCE.no_open_intent.includes('did not hear an open request'), true, 'no_open_intent says she did not hear one');
// C-OPENWEB8: a web ask is answered by open_web at once, and a refused binding says nothing is open.
assert.ok(persona.NAYA_OPEN_SURFACE.includes('call open_web at once'), 'the web open rule is pinned in the open surface');
assert.ok(persona.NAYA_OPEN_SURFACE.includes('never a web lookup first'), 'she never looks it up before opening it');
assert.ok(open.OPEN_WEB_DESCRIPTION.includes('never pass a URL'), 'the tool description bans a URL argument');
assert.ok(open.OPEN_WEB_DESCRIPTION.includes('open_source instead'), 'a document by name keeps the handle path');
assert.equal(open.OPEN_WEB_GUIDANCE.not_owner_words.say.includes('nothing is open'), true, 'a refused binding says nothing opened');
assert.equal(open.OPEN_WEB_GUIDANCE.not_owner_words.fixNotForSpeech.length > 0, true, 'a refused binding carries a fix');
assert.deepEqual([...open.OPEN_WEB_PARAMETERS.properties.kind.enum].sort(), ['maps', 'search', 'site'], 'the web kind set is closed');
assert.ok(voice.includes('never use a stock waiting line'), 'the stock waiting line ban is kept');
assert.equal(research.RESEARCH.mailLines, 8); assert.equal(research.RESEARCH.chatLines, 8);
assert.equal(research.RESEARCH.moreAvailableNote, 'Partial: answer now, offer the rest; read on only if asked.');
console.log(JSON.stringify({ case: 'partial_result_rules', removed: 6, voiceRules: 8, backendRules: 3 }));
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
assert.match(state, /^Connectors: company knowledge connected; calendar not signed in; mail not signed in\. Never deny or claim a sign-in or a capability without this line or a live tool check\.$/mu,
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
for (const rule of ['say you cannot hear your output', 'never say you are unchanged', 'End no answer with "okay?" as a reflex']) {
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
console.log(JSON.stringify({ case: 'own_state_truth', connectorLine: true, noDenialRule: true, voiceRules: 3, claimWithoutCall: true }));
NODE
