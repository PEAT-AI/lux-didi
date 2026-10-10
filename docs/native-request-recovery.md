# Native pending request recovery

`PendingRequestStore` preserves **one frozen connected request identity** across native
process termination. It does not send, retry, resolve, or render a conversation. There
is no installed/native Send/restart parity claim and no app call site in this change.
The committed service transcript and CHAT acceptance remain the only conversation authority.

## Four different things

- A **pending request** is the immutable assistant ID, authority epoch, pinned session ID
  and display title, frozen text, idempotency key, optional explicit retry-of run ID,
  and local dispatch phase. It is private app-local JSON, not a transcript copy.
- A **committed server transcript** is service-owned conversation history. The pending
  file is neither proof that CHAT accepted a request nor proof a model completed it.
- A **pre-Send unsaved draft** is not stored here. The caller freezes a request only
  at the Send boundary. This component does not preserve or retarget draft selection.
- **Raw audio** is never stored here. Neither are profile/persona copies, cookies,
  credentials, CSRF tokens, model keys, or caller-defined extension fields.
  Frozen user text is private content; the DTO does not attempt to censor its prose.

## API and caller ordering

The provisional API was published before implementation at the architecture report's
`pending-request/API.md`. Public Swift types live in `Sources/LuxDidi/PendingRequestStore.swift`.

1. The app supplies an explicit dedicated **absolute private directory** to
   `PendingRequestStore(directory:)`. No HOME change, hardcoded user/checkout path,
   keychain/security prompt, network, or accessibility permission is involved.
2. Construct `PendingRequestIdentity(assistantId:authorityEpoch:sessionId:idempotencyKey:)`
   and `PendingRequestEnvelope(identity:displayTitle:frozenText:retryOf:phase:)` using
   the already chosen service identity, frozen destination/text, and caller-chosen stable key.
   The component never fabricates missing UUIDs, rotates an epoch, generates a key,
   truncates text, or changes a destination. Only `.prepared` can create a new record.
3. Await `prepare` **before** any attempted dispatch. It either installs the envelope,
   returns an exact existing envelope, or rejects a conflict. String comparison uses
   UTF-8 bytes: canonically equivalent Unicode text is not the same frozen request.
4. Await `markDispatchUnknown(identity)` **before** an attempted transport call.
   It is a forward/idempotent transition that leaves all frozen fields unchanged.
   `dispatch-unknown` is only evidence that dispatch might have been attempted, not
   evidence that acceptance, sending, or completion occurred. A crash after transition
   but before transport is intentionally indistinguishable from a lost response.
5. After restart, await `load(assistantId:authorityEpoch:)`: `.empty`, `.current(envelope)`,
   or `.orphaned(envelope)`. A different assistant or epoch is an orphan, not authorization
   to rewrite/reseed/retarget it. Corrupt or unsafe files raise a sanitized typed error
   and remain in place for explicit recovery. No automatic discard or new-key retry.
6. A later connected caller must use unchanged CHAT owner/key replay with the frozen
   session/text/retryOf, and obtain **valid durable CHAT acceptance** before invoking
   `acknowledgeAccepted(identity)`. This API cannot establish acceptance or validate a
   `RunSnapshot`. Owner+key lookup, fingerprint checking, and acceptance are service concerns.
   `discardByUser(identity)` is a separate explicitly user-authorized action, never an
   automatic error path. Both methods only remove local state and require all four
   identity fields; empty-state cleanup is idempotent, another request is rejected.

The store is a Swift actor. Calls from the existing `@MainActor` app are awaited;
filesystem operations execute on the store's actor, not the UI actor. There is no
network operation or network wait inside the component. Cooperative competing
processes receive `.busy`, rather than blocking for a filesystem lock.

## Exact version-1 DTO and bounds

Flat keys: `version`, `assistantId`, `authorityEpoch`, `sessionId`, `displayTitle`,
`frozenText`, `idempotencyKey`, `phase`, optional `retryOf`. `retryOf` is **omitted**
when absent, never null. Unknown/duplicate/missing keys, nested extensions, nulls,
wrong scalar types, unknown phases/versions, invalid JSON/UTF-8, and invalid UUIDs
are denied; version is the integer JSON token `1` (not a string, bool, or `1.0`).

UUID strings use HTTP's explicit case-insensitive versions 1–8 / RFC-variant syntax.
They are preserved, not normalized. Assistant and epoch are persisted runtime UUIDs.
Required strings must not be whitespace-only. Bounds are UTF-16 units to match
JavaScript string lengths: frozen text **16,000** (`server/http/routes.ts` default),
title **1,000** (session creation route), key **128** (`server/chat/index.ts`). The
local file bound **128 KiB** is newly proposed storage policy, sufficient for worst-case
JSON escaping of accepted text plus bounded metadata; it is not a server payload
limit. Every violation fails visibly; nothing is silently truncated.

## Filesystem and mutation guarantees

The final configured directory is current-user owned and exactly `0700`. Only that
last component may be created; the app must supply an existing parent. Absolute
path components cannot be empty, `.` or `..`, and no component may be a symlink.
Ancestors are descriptor-walked with `openat`/`O_NOFOLLOW` and must be root/current
user owned and not group/world writable, except root-owned sticky system temp
ancestors. The final directory never uses that exception.

`pending-request.json`, `.pending-request.lock`, and `.pending-request.next` must be
regular current-user-owned `0600` files with exactly one hard link. Reads are bounded.
Unsafe directory/file modes, symlinks, FIFOs, foreign owner metadata, hard links,
and path escape fail with fixed `PendingRequestError` codes; diagnostics do not
include the path, frozen text, or underlying exception. There is no permissive fallback.

Each operation opens the same retained private lock file and obtains nonblocking
exclusive `flock` before inspecting/mutating the record. Other cooperative processes
reject with `.busy`; after a winner commits, a competing differing prepare rejects
with `.conflict`. The lock file is never unlinked by cleanup. One active app is
expected; hostile same-UID unlink/rename of the directory or lock is outside this
cooperative writer guarantee. Directory descriptors avoid symlink-following races;
this is not a sandbox against arbitrary same-user code.

Replacement creates the reserved temporary file exclusively, writes all bytes,
`fsync`s and closes it, then atomically renames it over the old record. Rename is
the commit point; no fallible production success-path step follows it. Pre-commit
failures do not report success or replace the old record. Normal failures remove
only the store's own temporary file. Process death can leave the reserved safe temp;
the next locked operation removes it, without promoting it into a pending request.
Unsafe temp remnants are preserved and denied. The valid old/new record is never
reset as an error recovery shortcut.

**Guarantee: process-kill/reopen consistency, not power-loss durability.** No directory
fsync or full hardware flush guarantee is claimed. Explicit clear is an atomic local
unlink, not proof about service state. Malformed files require separate explicit
recovery by the app/user; this store does not provide a corrupt-file purge API.

## Focused verification

`bash scripts/check-pending-request.sh` compiles the actual component under Swift 6
strict concurrency with Foundation/POSIX and no package/dependency changes. It runs
only `Tests/DidiPendingRequestTests/Runner.swift`, using synthetic real private temporary
files and child processes. No browser, app, audio, model, server, or real app state.
`--durations=10` is the runner's supported timing flag, used by the producer.

Coverage includes exact reopen, byte-exact conflicts, transitions, omission and strict
DTO/bounds, orphan classification, symlink/path/mode/hard-link/FIFO denial, preservation,
wrong/matching clear, injected pre-commit failures and actual rename failure, and six
real child-kill checkpoints around initial prepare/transition replacement. Checkpoint
pipes (not sleeps) synchronize competing writers and SIGKILL of only those child PIDs.
Test-only checkpoints compile under `PENDING_REQUEST_TESTING`; the production API has
no fixture/fault extension parameter.

Foreign-file UID rejection uses the production metadata validator with `fstat` of a
real private fixture and a changed UID, since unprivileged macOS cannot create files
owned by another UID. Real foreign-owned system temp directory denial is also checked
read-only, before any lock creation. This does **not** claim a real foreign-owned
private-file fixture was created. No system file is linked, copied, or modified.
