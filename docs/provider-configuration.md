# Explicit portable provider configuration

The host passes an explicit trusted `configDir` and the current Store `ownerId`.
Nothing reads HOME, environment credentials, HTTP fields, source secrets, user
records or a default location. This configuration is not permission to classify
unknown history or import data. The chosen model is operator-supplied; there is
no default/latest model or live availability claim. Networking remains solely
in the existing GeminiAdapter, including its fixed official endpoint and header
credential transport.

## Exact version 1 schema

`profile.json`, at most 16 KiB of UTF-8 JSON:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "provider": "gemini",
  "modelId": "operator-selected-model",
  "keyReference": "gemini-primary",
  "dataClasses": ["ordinary"],
  "preferences": {
    "dataClass": "ordinary",
    "language": "de-DE",
    "register": "plain",
    "humor": "off",
    "verbosity": "balanced"
  }
}
```

All fields are required; extra and duplicate fields are rejected, including
escaped duplicate names. `enabled` must be boolean. `modelId` is 1 to 128 ASCII
letters, digits, dot, underscore or hyphen, starting with a letter/digit.
`dataClasses` is a nonempty unique subset of `ordinary`, `private`, `sensitive`.
Preferences contain exactly the five fields shown. The accepted
`validatePreferences` validates them after injecting `schemaVersion:1` and the
host's current `ownerId`, and canonicalizes the explicit BCP47 locale. Its closed
register/humor/verbosity choices apply; no default language, free-form instruction
or portable owner identity is accepted. A disabled profile must still be valid.

`gemini-primary.json`, at most 8 KiB:

```json
{"schemaVersion":1,"keyReference":"gemini-primary","key":"synthetic-example"}
```

Legacy v1 accepts exactly these fields. Bound v2 is described below. The only reference is `gemini-primary`, never a filename
or caller-selected path. Key length is 1 to 1024 bytes, visible ASCII without space
(0x21 through 0x7e); whitespace, controls, CR/LF and non-ASCII are rejected. Examples
are synthetic, not credentials. Secret bytes never appear in status/errors,
causes, logs, CLI output, argv or serialized returned objects.

## Live profile (`live.json`) and the local persona overlay

`live.json`, at most 16 KiB, is a separate closed file in the same `configDir`
(`<dataDir>/provider-config`). It carries the same five-field `preferences`
block, and its `preferences.language` is the same explicit BCP47 locale. For
Live a valid language-region tag is kept end to end for
`generationConfig.speechConfig.languageCode` (for example `de-DE` stays `de-DE`;
the adapter pins bare `ar` to `ar-XA`). Every Live session therefore
sends an explicit language: the owner's tag when it is a two-letter language
with an optional two-letter region, otherwise the bare primary subtag of the
owner's BCP47 locale (for example a script subtag `zh-Hans-CN` sends `zh`),
otherwise `en`. The setup is never left unset, so the voice always has an
explicit language pin. The voice anchor still reduces to the bare primary
language name. The literal key reference
is still `gemini-primary`; the key file is separate and untouched. The `provider`
field is a checked union (`LiveProvider` in `live/types.ts`, declared by the adapter
port), currently only `gemini`: an unknown value fails the load with
`invalid_provider`, and no model-name regex anywhere outside the Gemini adapter
decides provider behaviour.

```json
{"schemaVersion":1,"enabled":true,"provider":"gemini","modelId":"models/gemini-3.1-flash-live-preview","voice":"Aoede","keyReference":"gemini-primary","dataClasses":["ordinary"],"preferences":{"dataClass":"ordinary","language":"en","register":"plain","humor":"dry","verbosity":"brief"}}
```

The owner supplies this file in the selected protected configuration directory.
The installer creates no profile and leaves existing files untouched. The public
Live baseline remains the Naya base plus its terminal language anchor. When an
owner profile is explicitly selected, its exact classified style and lore sections
join the accepted Live system between that base and anchor. The optional local
overlay joins later at session CREATE. The complete accepted instruction has the
existing 20,000-character limit and fails closed rather than truncating required
owner sections (see `docs/prompt-composition.md`).

The optional `limits` block carries per-profile timer overrides: `limits.sessionMs`
(the longest single session) and `limits.idleMs` (silence before the session ends),
both whole milliseconds. The effective profile determines the limits; an omitted
key falls back to the built-in default (`sessionMs` 3600000, 1 hour, and
`idleMs` 300000, 5 minutes). A value outside 1 to 2147483647
is a typed validation error.

`<dataDir>/persona-overlay.json`, at most 16 KiB, is the optional private local
persona layer, outside Git. It is a closed record
`{schemaVersion:1, text, greeting?, accent?}`. A missing file means no overlay; a
present but malformed, oversized or non-regular file is a typed error surfaced
as Live status `error` with code `invalid_overlay` or `overlay_too_large`, never
a silent fall back to the public base.

## Library API (ESM)

Import `loadProviderConfig`, `initializeProviderConfig`, `ConfigError` and types
from `server/config/index.js` (compiled from TypeScript).

```ts
const status = loadProviderConfig({ configDir, ownerId: currentStoreOwnerId });
if (status.status === 'ready') {
  // Host composition only: inject status.credentials and status.route into
  // the existing GeminiAdapter, with status.profile.modelId/keyReference.
  const key = await status.credentials.resolve('gemini-primary');
  // Only the existing in-process adapter consumes key. Never log it.
}
```

The synchronous loader returns one discriminated `ProviderStatus`:
- `unconfigured`: explicit directory or profile genuinely absent;
- `disabled`: complete valid explicit false profile, sanitized `profile`;
- `error`: configured invalid/inaccessible setup, finite safe `code`;
- `ready`: sanitized `profile`, existing `Route`, existing `Credentials`.

Preferences include only the validated current host ownerId and canonical locale.
No key is retained in returned fields/closures. `resolve(reference)` returns
`Promise<string | undefined>` to match Credentials; this resolver either returns
a revalidated key for the exact fixed reference or rejects with a safe ConfigError.
It rereads the root and secret each time; host must reload status when changing
profile/ownership. There is no silent fallback on key failure. A disabled or
unconfigured loader does not read the secret or any unrelated source file.

`initializeProviderConfig({configDir, ownerId, profileInputPath, sourceEnvPath})`
returns void, or throws a sanitized ConfigError. It creates a NEW private root
exclusively. It refuses every existing destination unchanged (even empty,
partial, disabled, symlink). Only enabled:true profiles can be initialized.
After validating inputs it creates the secret privately, then a private pending
profile, and activates `profile.json` last via an exclusive hard link. Successful
initialization removes its own pending link. It never overwrites, rotates or
deletes unknown files. Activation occurs only after complete writes and fsync.

## Explicit operator CLI

Compile this unit using the existing locked service TypeScript toolchain and
NodeNext ESM conventions. The host/install lane owns the permanent output path;
this change does not alter manifests or host composition. With `<compiled-root>`
as that output directory:

```text
node <compiled-root>/config/cli.js --help
node <compiled-root>/config/cli.js init --config-dir <new-private-dir> --owner-id <current-store-owner> --profile-input <private-profile-json> --source-env <authorized-private-env-file>
bash scripts/check-provider-config.sh
```

The legacy `init` CLI accepts those four required flags once, optional explicit
`--binding-input` once (see bound provisioning below), and optional `--provider`
once. No positional key, key argument, endpoint flag or variable-selection flag is
accepted. `--provider` names the credential slot to seed and defaults to `gemini`:
`gemini` reads literal `GEMINI_API_KEY` and writes `gemini-primary.json` plus the
text `profile.json` exactly as before, while `openai` reads literal
`OPENAI_API_KEY`, writes only `openai-primary.json`, and publishes no text profile
because the conversation model stays Gemini. The source is read bounded (64 KiB)
inside the process and only that slot's literal variable is extracted, never
loaded/exported to the environment. It prints a constant success message or a
finite safe error code, not input paths/source lines. No shell, child credential
CLI, eval, source, command substitution, interpolation or execution is used.

`init --provider openai --source-env <file>` also works against an **existing** config dir: it adds only
the OpenAI slot (a new private file plus its reference) and never reads, rewrites or rotates the Gemini
slot or `profile.json`. The Gemini path still requires a brand-new directory because it publishes the
text profile. `--provider` defaults to `openai` (owner order, OV1-R2).

`select` persists the same Live selection the settings page writes, through one shared function:

```text
node <compiled-root>/config/cli.js select --config-dir <existing-private-dir> --provider openai|gemini [--voice <id>]
```

It validates the provider against the slot table, refuses a provider whose key slot is empty
(`file_missing`) instead of pointing at another provider's key, sets the model id from that provider's
dialect, and leaves `limits`, `dataClasses` and the persona preferences untouched. The running service
keeps the profile it loaded, so the choice applies when the service next starts and never to a call in
flight.

### Provider slots

One slot table (`providerSlots` in `server/config/index.ts`) holds each provider's
key reference, private file name, endpoint, api-version, source variable and
model-id pattern:

| provider | reference | private file | endpoint | api version | source variable | model ids |
| --- | --- | --- | --- | --- | --- | --- |
| `gemini` | `gemini-primary` | `gemini-primary.json` | `https://generativelanguage.googleapis.com` | `v1beta` | `GEMINI_API_KEY` | `models/...` |
| `openai` | `openai-primary` | `openai-primary.json` | `https://api.openai.com/v1` | `v1` | `OPENAI_API_KEY` | `gpt-live-*` |

A resolver reads only the slot it is asked for: an unknown reference fails
`invalid_reference`, and a reference whose file is absent fails `file_missing`.
There is no fallback from one provider's slot to another's key, and a binding
receipt may never mix two providers' endpoint, api-version or reference.

Supported source syntax: UTF-8, LF or CRLF, blank lines, full-line `#` comments,
and one `NAME=literal` assignment per line (optional horizontal space around the
line, not around `=`). Values are unquoted literals or whole single/double-quoted
literals. Quoted values require a matching closing delimiter and no interior
occurrence of that delimiter; double-quoted content also rejects backticks.
Unquoted content rejects single quotes, double quotes and backticks. Content
ending in backslash is rejected, including an escaped closing delimiter. No
multiline values, continuation, escape decoding or interpolation is supported.
These are explicit one-line format constraints, not shell/dotenv equivalence.

Other assignments are ignored only after those checks. Their values are opaque:
punctuation, spaces and shell-looking text such as `$()` are literal data, never
executed or exported; `#` inside a value is not an inline comment. Backticks are
literal only inside single quotes. No foreign value is assigned to `process.env`.
Only `GEMINI_API_KEY` retains the restricted charset: ASCII letters/digits and
`_ . : / + , = @ % -`, at most 1024 characters, nonempty. It must appear exactly
once; the whole file is scanned even after finding it. Duplicate, absent, invalid
targets and unsupported syntax anywhere fail with finite content-free errors.

All roots/files use explicit absolute paths (no relative-path or default-location resolution). Input profile and authorized source must be current
UID, final non-symlink, regular, single-link 0600. Runtime config root is 0700,
profile/secret files are 0600; secret has exactly one hardlink. Limits are byte
limits and parsing uses fatal UTF-8 decoding. Files are opened O_NOFOLLOW and
O_NONBLOCK, checked with fstat, read bounded from that same descriptor and closed
on every path. Directory descriptor is likewise validated. No permission repair.

## Failure recovery and threat boundary

An existing destination is never changed. A failure after exclusive creation
leaves an explicit private incomplete setup: no active profile unless activation
completed. Do not run initialization again over it. Inspect it using an authorized
operator, preserve unknown files, and choose a fresh destination after resolving
the reported error. This unit never deletes it or exports the key for recovery.
Unconfigured means absent profile, not a guarantee that the directory is empty.

Supported on POSIX Node with getuid/O_NOFOLLOW/O_DIRECTORY. Wrong ownership, mode,
type, final symlink, hardlink, oversized/invalid content and identity/reference
mismatch fail clearly. Ancestor directories must be trusted by the host. Node's
supported APIs do not provide openat; validation cannot defend against concurrent
malicious same-UID directory/ancestor replacement, debugger/process inspection or
an already compromised host. There is no FFI or stronger isolation claim.

The focused check stages only this unit plus accepted prompt/model dependencies
under a temporary ESM marker, strictly compiles, and runs real filesystem and
child-CLI tests with synthetic private temporary files. It does not install
anything, read local credentials or call a provider. It prints Node TAP durations
(Node's equivalent of the Python-specific `--durations=10` requirement).

## Explicit operator-asserted binding (secret v2)

Existing profile v1 and its strict validation are unchanged. Legacy secret v1
remains readable through the string-only `credentialsFor` for text and Live;
it cannot produce a receipt or authorize receipt-dependent tools/disclosure.
There is no automatic migration, default account or generation, account inferred
from reference/key bytes, key fingerprint, or provider identity verification.

To create a bound record, independently supply a private regular 0600 UTF-8 JSON
file (at most 8 KiB) to `init --binding-input /absolute/private/binding.json`.
No environment/default discovery occurs. Binding input has exactly:

```json
{
  "schemaVersion": 1,
  "configuredAccount": "operator-asserted-account",
  "routeScope": {
    "provider": "gemini",
    "modelId": "gemini-synthetic",
    "endpoint": "https://generativelanguage.googleapis.com",
    "apiVersion": "v1beta",
    "keyReference": "gemini-primary",
    "allowedClasses": ["ordinary", "private"]
  },
  "bindingGeneration": "operator-stable-generation-1"
}
```

Account and generation are explicit, nonempty, trimmed labels of at most 256
characters without control characters. They must not contain secrets. This text
provider/endpoint/API version/reference are allowlisted exactly; model syntax
matches profile v1. Classes must be nonempty, unique members of ordinary/private/
sensitive, canonicalized into that order. The **whole** canonical scope must
match the profile's provider/model/reference/classes and this adapter's fixed
endpoint/API version, not merely its model or reference. Unknown or duplicate
fields, unsafe input files and incomplete scope fail before activation.

The active `gemini-primary.json` then has exactly `schemaVersion: 2`,
`keyReference`, `key`, `configuredAccount`, `routeScope`, and
`bindingGeneration`. Its key still obeys the v1 limits; protected storage modes,
size bounds and descriptor validation are unchanged. Binding input is metadata,
not another active database or a separately read receipt source.

### Explicit retained migration

For an already valid v1 configuration, run the compiled CLI explicitly:

```sh
node /absolute/compiled-root/config/cli.js migrate-binding \
  --config-dir /absolute/private/didi-config \
  --owner-id current-store-owner \
  --binding-input /absolute/private/binding.json
```

`init` without binding input retains v1 behavior. `migrate-binding` requires all
three flags exactly once and rejects v2 active records; it is not a rebind API.
It validates existing profile/secret and independently supplied binding before
activation. Existing profile, preferences and key are retained. The original
secret's **exact bytes**, including whitespace/BOM, are copied into newly created
0600 `gemini-primary.legacy.json` under the existing 0700 root. Copy is exclusive:
a collision is a visible failure, never an overwrite. This backup is sensitive
and remains there; never place it in a report, UI, browser, model content or
SQLite. Loading does not migrate or delete it.

A replacement v2 record is fully validated in memory, the exclusive legacy
backup is validated/fsynced, then a private fsynced `.binding.pending` is created
and atomically replaces the active secret. The retained backup must still be v1
with the same key as the initially validated source; a concurrent key/version
change fails visibly rather than activating a mismatched snapshot. On failure the active locator remains valid old or valid new,
with a sanitized visible error; no profile is half-activated. Retained backup is
never unlinked. The owner's unpublished pending file is cleaned on a later
failure; a preexisting pending path is not touched. A process interruption or
failed initial pending write can leave private incomplete pending data: preserve
it for authorized inspection, not automatic recovery. If a backup was already
retained before failure, retry refuses its collision: preserve it and obtain
operator-directed recovery rather than blindly deleting/overwriting it. Inspect
the current protected record after any failure; a post-activation durability
error does not imply rollback.

### Request-local resolver and receipt

`CredentialRouteScope`, `CredentialBindingReceipt` and `RequestCredentials` are
exported from `config/index.js`. Allocate `requestCredentialsFor(configDir,
expectedScope)` **inside every generate invocation** and inject its
`.credentials` into that invocation's new GeminiAdapter. ModelPort, Transport,
and `Credentials.resolve(reference): Promise<string | undefined>` are unchanged.
The factory captures a detached canonical expected scope, not a startup key or
receipt. Each successful resolution reads/parses one validated v2 descriptor
for both key and receipt. Its `.resolvedReceipt()` is invocation-private,
initially undefined, and cleared by a failed resolve. Do not share the factory
object across runs.

Receipts are detached, recursively frozen non-secret objects with
`schemaVersion: 1`, `keyReference`, `configuredAccount`, full canonical
`routeScope`, and `bindingGeneration`. They may be serialized as metadata, but
are only operator assertions. `credentialReceiptFor(configDir, expectedScope)`
synchronously rereads the **current** active locator and validates the complete
v2 record, including key validity; it returns only its receipt and discards the
key. Legacy, missing/deleted, malformed, invalid-key or wrong-scope records throw
a finite sanitized ConfigError. This is not the last resolve's cached receipt.
Compare the complete canonical non-secret receipt (for example structural
equality, or JSON serialization of these canonical receipts).

Same-account/scope/generation key rotation is allowed: next invocation resolves
the new key with equal binding. Changing account, scope or generation is
rebinding and requires new acceptance by the consumer. Delete/invalidate the
active record to revoke it; an old receipt or retained backup cannot authorize
the current locator. A consumer must perform a fresh check before sensitive
release, not merely validate an old receipt. This slice supplies the seam and
adapter fixtures, **not** production Chat/Host authorization.

The existing Live adapter still resolves the public string lazily and places
it in its trusted provider connection URL. No Live receipt authorization or
URL-free Live behavior is added. Never log, render or persist that URL. Trusted
ancestors and exclusion of same-UID malicious path replacement remain the
existing boundary; this feature does not claim to solve that limitation.

`bash scripts/check-credential-binding.sh` compiles the actual relevant dependency
closure in temporary output with installed Node >=26 and TypeScript (optional
`DIDI_TYPESCRIPT_ROOT` pointing to installed dependencies), then requires nonzero
credential-binding, provider-config, model, live-voice and prompt test selections.
Synthetic protected files and local fake transport/socket fixtures make no
private/production account or model calls.

The operator-selected config directory is the host's effective directory; without
an override it is `provider-config` under the data directory. For compatibility,
the host copies an existing default `live.json` profile or `mcp.json` catalog to
an effective directory only when that destination file is absent. The copy uses
atomic writes with mode 0600 in a protected 0700 directory; existing effective
files take precedence. This copies owner-provided files, not generated templates,
and never copies credentials. A fresh installation creates no default catalogs,
so there is nothing to copy and the missing configuration remains unconfigured.
