# Explicit portable Gemini configuration

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
escaped duplicate names. `enabled` must be boolean. `modelId` is 1–128 ASCII
letters, digits, dot, underscore or hyphen, starting with a letter/digit.
`dataClasses` is a nonempty unique subset of `ordinary`, `private`, `sensitive`.
Preferences contain exactly the six fields shown. The accepted
`validatePreferences` validates them after injecting `schemaVersion:1` and the
host's current `ownerId`, and canonicalizes the explicit BCP47 locale. Its closed
register/humor/verbosity choices apply; no default language, free-form instruction
or portable owner identity is accepted. A disabled profile must still be valid.

`gemini-primary.json`, at most 8 KiB:

```json
{"schemaVersion":1,"keyReference":"gemini-primary","key":"synthetic-example"}
```

Exactly these fields. The only reference is `gemini-primary`, never a filename
or caller-selected path. Key length is 1–1024 bytes, visible ASCII without space
(0x21–0x7e); whitespace, controls, CR/LF and non-ASCII are rejected. Examples
are synthetic, not credentials. Secret bytes never appear in status/errors,
causes, logs, CLI output, argv or serialized returned objects.

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

The CLI accepts exactly those four flags once, no positional key, no key argument,
no provider endpoint and no variable-selection flag. It prints a constant success
message or a finite safe error code, not input paths/source lines. The source is
read bounded (64 KiB) inside the process; only literal `GEMINI_API_KEY` is
extracted, never loaded/exported to the environment. No shell, child credential
CLI, eval, source, command substitution, interpolation or execution is used.

Supported source syntax: UTF-8, LF or CRLF, blank lines, full-line `#` comments,
and one `NAME=literal` assignment per line (optional horizontal space around the
line, not around `=`). Values are unquoted literals or whole single/double-quoted
literals, without escapes, interpolation, inline comments or multiline strings.
Only ASCII letters/digits and `_ . : / + , = @ % -` are supported inside literals.
Thus `$`, backticks, backslash, semicolon, pipes, parentheses and spaces inside
values are rejected even in quotes. This intentionally narrow dotenv subset is
not a shell parser. Other simple assignments are ignored, not exported; unsupported
syntax anywhere is rejected. GEMINI_API_KEY must appear exactly once, nonempty;
duplicate, absent, malformed and malicious assignments fail without quoting input.

All roots/files are explicit. Input profile and authorized source must be current
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
