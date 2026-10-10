# Native connected draft — staged coordinator

## Delivery status

Phase 1 supplies `Sources/LuxDidi/ConnectedDraft.swift`, one pure Foundation coordinator and an API-only controlled integration producer. **It is not connected to the installed app yet.** Native shell/App/page transport composition and the installed editable-text/dictation/shared-page/UI proof are phase 2, gated on the root's accepted native prerequisite and reviewed assembled base. Local note Save and real microphone/playback are not modified or proven by phase 1.

The service and shared web page remain the only conversation authority and transcript renderer. There is no native conversation database, selector, transcript stream, provider retry or generic poller.

## Coordinator boundary

`ConnectedDraft` is MainActor-owned. Construct it with the canonical `PendingRequestStore` in the app's accepted private pending directory. Supply `ConnectedAuthority(assistantId:authorityEpoch:)` from the supervised service bootstrap and a `ConnectedConversationTransport` using the existing private authenticated page seam. Do not build another URLSession/bearer/Keychain transport for production.

- `connect(authority:transport:)` reads pending storage without any transport request. Same owner/epoch permits explicit replay; mismatch preserves an orphan and blocks replay. Corrupt/unsafe/oversized storage visibly blocks sending.
- `beginDraft()` resolves and pins the selected ID and visible title once. Missing selection blocks connected recording/send; `canRecord` describes a pinned editable draft only. Replacement, cancel and connection changes invalidate late selection responses. A page selection change never changes a pinned target.
- `setText(_:)` edits a pinned, unfrozen draft. `cancelDraft()` clears an unsent draft, not a durable pending request. Presend typing/audio is not advertised as crash-persisted.
- `send(retryOf:)` generates one request key and freezes exact text/target/title. It awaits real `prepare` and then `markDispatchUnknown` before invoking transport. Any persistence failure means zero HTTP dispatch. Double Send cannot create a second unresolved request. Errors retain the text.
- `replay()` is explicit only. It uses saved DTO/key/epoch and current page authentication. It does not resolve selection, create a new key or send `retryOf:null`.
- A complete valid matching durable RunSnapshot acknowledges only the exact saved identity. `outcome_unknown` is acceptance, not permission to retry provider work. HTTP loss/denial, malformed or mismatched responses and cancellation leave the immutable envelope intact. Provider completion/display belongs to the shared page.
- `discard(_ identity:)` requires the exact envelope identity and explicit user intent. Store cleanup refuses another request. `disconnect()` invalidates live transport and late results without dropping text/pending.

The coordinator emits state and acceptance run ID, not transcript content. Phase 2 must prominently label the pinned Send destination, keep page B on B when sending to A, reuse existing local Save labels/identity, and translate disconnect/owned-child exit into `disconnect()` immediately.

## Accepted wire

See `docs/native-conversation-protocol.md` for the accepted selection/event protocol. Coordinator transport performs page-mode GET `/api/v1/conversation-selection` and POST `/api/v1/chat` with body `{sessionId,text}` plus `retryOf` only when present. POST uses the immutable `Idempotency-Key` and `X-Didi-Authority-Epoch`. Existing page transport owns cookie, exact Origin and CSRF. Never combine Cookie with Authorization or fall back to bearer. The coordinator opens no conversation SSE; the existing web page owns that stream and durable reconnect discovery.

## Focused verification

Declared producer:

```sh
bash scripts/check-native-conversation-companion.sh
```

In a managed lane, invoke it only through the controller's declared `check-run`, not directly. It compiles the selected Foundation production sources with Swift 6 strict concurrency and warnings-as-errors. Tests use the accepted Store's existing test-only filesystem checkpoint seam for prepare/mark failures; a separate production module compile has no test flag.

The producer first compiles an isolated temporary source mutant that skips `markDispatchUnknown`. The actual Foundation runtime test must fail at the durable-marker assertion (EXIT=1). This is explicit sensitivity evidence, not a claim that the committed production coordinator is broken. It then runs the unmodified coordinator green. Missing-source and Host-startup failures do not count as behavioral sensitivity.

Lockfile-exact offline worktree-local dependency setup builds the actual canonical web shell under `web/dist` and the canonical service. No fake static runtime, renderer/browser, dependency change, global install or real provider is used. A controlled host process serves authenticated HTTP/CHAT; Foundation child transport implements the accepted wire for tests only. Read-only durable row/capture statistics verify actual acceptance; no fabricated SQL runs are inserted.

Integration cases include deterministic native termination after durable write but before wire, pinned A while shared selection is B, termination after committed acceptance, dropped/malformed HTTP response, actual service process kill/restart with persistent epoch, explicit exact-key replay and one capture/run/provider attempt at most, truthful recovered `outcome_unknown`, zero **all** HTTP requests on restore, different owner/epoch orphans, and auth/consent/active-run denial preserving text/pending. Unit cases cover stale selection/acceptance, cancellation, complete/matching snapshot validation, corrupt/oversized pending, prepare/mark write failure, omitted optional retry and identity cleanup. Canonical pending-store safety/process-death regression tests also run.

All proof uses ordinary synthetic text and a controlled synthetic provider. It proves process-kill recovery, not power-loss durability or real dictation. Test duration output uses `--durations=10`. Owned host/native children and temporary storage are cleaned up by the producer.
