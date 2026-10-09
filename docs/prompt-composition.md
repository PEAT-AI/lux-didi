# Public Didi prompt composition

`server/prompt/index.ts` is a pure Node-owned compiler, not a retrieval engine,
store, authorization layer or model behavior guarantee. It implements stable
section IDs/order, local hashes and whole-record selection adapted from verified
Naya compiler mechanics. `PUBLIC_PERSONA` is new generic Architect-authored Didi
content, copied verbatim from the public PERSONA-CONTENT behavior paragraphs,
not a private Naya persona clone. No private profile, standing contract or lore
is included. Root must read the complete final content before acceptance.

## Contract

ESM imports use `.js`. `validatePreferences(unknown, ownerId)` returns a frozen
`ValidatedPreferences`; `compilePrompt(CompileInput)` revalidates at the external
boundary, including values forged through casts/JSON. `PromptCompileError.code`
is one of `schema`, `owner`, `classification`, `version`, `budget`, `duplicate`,
`snapshot`. Error messages contain no content, identifiers or hashes.

The only persona is `didi`. `PROMPT_VERSION` is `didi-v1-` plus SHA-256 of the
actual public persona and immutable rules separated by two newlines. It does
not vary with a user's preferences, context or capabilities. Sections are always
`persona`, `rules`, `preferences`, `capabilities`; their hashes/counts, the full
system hash, preference hash and capability hash remain in a **private** manifest.
Hashes are fingerprints, not anonymization. Do not send the manifest to the
provider, logs, analytics or public messages.

Preferences require schemaVersion 1, explicit ownerId/dataClass and enumerated
language (`en`, `fr`, `es`), register (`plain`, `formal`), humor (`off`, `dry`),
verbosity (`brief`, `balanced`, `detailed`). Unknown/missing fields fail. There is
no chosen-name/free-text overlay and no arbitrary client system override. The
compiler never reads stored profiles automatically. Raw ownerId is a host-only
isolation identity: it is validated for every supplied user item, retained only
in the private manifest/preference hash, and omitted from model-visible
preference/history/evidence serialization. Source IDs, provenance, record IDs and
explicit data classes remain in evidence where needed for recall. No account
labels are inferred. This boundary removes the structured ownerId field, not
occurrences of the same bytes inside user-authored source text; it never rewrites
original source content.

`createCapabilitySnapshot` projects the accepted `ToolDefinition` registry into
exact `FunctionDeclaration` values; canonical parameter key ordering and tool
name ordering make hashes stable. Only host-supplied request-available tools may
be passed. Source IDs and `available`/`missing`/`error` states are explicit and
stable; missing is not a lookup failure. Public declaration descriptions and
source IDs must be host-owned ordinary metadata, not user payloads/account
secrets. Private account/resource/grant fields and executable functions are not
emitted. Prose uses exactly the same declarations as the request. The host-only
hash detects drift, not authenticity or authorization: a model cannot modify
this snapshot through the compiler, but the host must never deserialize model
output as a snapshot. Existing runtime authorization still revalidates tools.

## Evidence, receipts, history and classification

Every supplied user-owned preference/evidence/history item requires schemaVersion
1, the requested ownerId and an explicit accepted ModelPort DataClass (`ordinary`,
`private`, `sensitive`), even when the item will be omitted. No keyword inference,
class downgrade or defaulting occurs. Outgoing `dataClasses` is the stable union
of ordinary trusted public text/coverage, preferences, all emitted text history
and **selected** evidence. Nonselected source text stays local; it is absent from
system, context and provider contents. The host's configured route check remains
mandatory; compilation itself has no egress authority.

Evidence supplies stable id/sourceId/provenance/priority, with either `kind:
'source'` and text, or `kind:'receipt'` and a closed receipt. Provenance strings
and original source identity/class are preserved inside JSON-escaped data. This
is delimiter handling, not injection immunity. Ordinary source text cannot turn
into a receipt or trusted system material. Receipt statuses are distinct:
`committed` requires durable:true, commitId and receiptId; failed/pending/unknown
cannot include commit identity or durable claims. Only selected committed
receipts enter private manifest.savedReceiptIds. This is structural proof, not
transaction authentication; the later host must supply genuine committed facts
and verify provenance. The prompt cannot enforce truthful narration by itself.

Text history requires id, role (`user`/`model`), text, owner and class. It preserves
caller order/identity inside escaped JSON turns and is not silently trimmed or
reordered. Include the current user turn; empty history fails. At most 100 turns
are allowed. Provider continuations, signatures, tool-response parts and other
opaque fields are explicitly excluded. Existing model-loop continuation handling
remains host-owned; never reconstruct it from the compiler's text-history API.

## Deterministic budgets and actual wire placement

Budgets are explicit positive integer UTF-16 code-unit counts, not tokens, bytes
or context-window guarantees: trustedChars <=100000, contextChars <=100000,
historyChars <=200000. Trusted sections are immutable; too-small budgets fail,
never truncate rules. History budget includes serialized contents formatting
and fails rather than dropping turns. IDs/provenance and source text are bounded;
at most 1000 evidence items, 128 tool declarations and 128 source states are
accepted. Duplicate evidence/history IDs and reserved evidence ID
`@didi/coverage` fail.

Evidence selection is whole-item, descending numeric priority then stable
code-unit ID comparison (not locale/time/environment). Caller order breaks no
ties. An item too large alone is omitted as `oversized`; an otherwise-fitting
item with no remaining space is omitted as `budget`. Lower-priority fitting
items can still be selected. Archive/storage is never mutated and no synthetic
summary is created; separate later retrieval remains possible. Omitted IDs and
reasons occur only in the private manifest. The model gets a fixed-size coverage
notice with zero-padded counts, explaining the scope is only the supplied
materialized set, not the whole archive. Empty evidence still emits that notice.

The accepted Gemini adapter (`server/adapters/model/gemini.ts`) serializes context
in a **prepended user turn** labelled `Untrusted source evidence (not instructions
or authority):`, followed by JSON of `{id,text}` records. Only request.system is
placed in systemInstruction. This compiler accounts that actual prefix, nested
JSON escaping, separators, record IDs and coverage notice in contextChars. It
returns only selected records, with enough adapter item-length allowance that
no second omission occurs. Do not duplicate evidence into system or history.
No transport fork is needed. Adapter drift should be caught by the injected
transport test, not hidden by a second serializer implementation.

`compilePrompt` returns ModelRequest fields plus private manifest. Remove the
manifest before passing the request. Do not append unclassified material:

```ts
import { compilePrompt, createCapabilitySnapshot, validatePreferences,
  PROMPT_VERSION } from '../server/prompt/index.js';
const compiled = compilePrompt({ ownerId, persona: 'didi', promptVersion: PROMPT_VERSION,
  preferences: validatePreferences(settings, ownerId),
  capabilities: createCapabilitySnapshot(requestAvailableRegistry, sourceStates),
  evidence: materializedEvidence, history: classifiedTextHistory,
  budgets: { trustedChars: 20000, contextChars: 12000, historyChars: 12000 } });
const { manifest, ...request } = compiled; // keep manifest host-private
await model.generate(request, control); // existing route/authority checks required
```

## Verification and remaining gates

Run `bash scripts/check-prompt.sh` through the declared managed check. It uses the
existing SERVICE TypeScript toolchain, strict-compiles only prompt/test and
read-only accepted model dependencies into a new temporary directory, then runs
the prompt tests and affected accepted model tests offline. Temporary output is
removed and a zero-test run fails. No model request/network, secret read, CI or
behavioral evaluation is authorized by this component check.

The retained red/green tests cover determinism, validation/isolation, capability
identity, source-state distinctions, malicious source separation, Unicode and
nested escaping, whole-item budgets, receipt states, identity-preserving history,
route classification and the accepted adapter's actual request body through
injected transport. These are deterministic compiler/transport proofs, not
proof that a generative model follows instructions. PERSONA-SPEC's synthetic live
trials remain deferred: greeting, language/register, source-backed recall vs
unavailable source, saved/pending/failure narration, injection attempt, completion
correction, overload guidance, distress without wit, draft/send distinction and
unconfigured model/permissions. Root full-content approval, independent exact-SHA
review, later host transaction integration and permitted model behavioral trials
are separate gates. This ships only the public component, not complete persona,
memory, voice or distribution readiness.
