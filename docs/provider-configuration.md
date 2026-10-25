# Provider configuration

Text chat and Live voice are separate configuration surfaces. A provider profile is a locally validated choice, not proof of account identity, service availability or consent for every data class.

## Source-owned contracts

| Concern | Source |
| --- | --- |
| Provider slots and protected credentials | `providerSlots` in `server/config/index.ts` |
| Text profile loading and initialization | `server/config/index.ts` |
| Operator CLI | `server/config/cli.ts` |
| Live profile, provider/voice selection | `server/config/live.ts` |
| Live validation, feature switches and limits | `server/live/config.ts` |
| Protected filesystem validation | `server/config/files.ts` |
| Credential route-class changes | `server/config/route-classes.ts` |

Use the validators for exact closed schemas rather than copying an old type definition from documentation. The owner supplies private files outside the repository and application bundle; installation preserves them but does not generate credentials.

## Provider and key selection

`providerSlots` defines each provider's key reference, official endpoint, API version, source variable, model syntax and default voice/model. `defaultLiveProvider` is OpenAI; Gemini remains selectable. Text inference uses the Gemini model adapter. Choosing OpenAI voice does not silently change the text provider.

The slots are distinct: `openai-primary` reads the OpenAI credential and `gemini-primary` reads Gemini's. `slotByReference` refuses an unknown reference; a missing key is not permission to borrow the other slot. Keep actual model availability separate from the syntactic model-ID validation the loader can perform locally.

The text profile is `profile.json`; Live uses `live.json` in the selected configuration directory. Protected secret records are separate. Neither profile is a place to put an inline API key, and no key belongs in argv, diagnostics, a browser field or source control.

## Initializing a configuration

The compiled operator entry supports:

```sh
node server/dist/config/cli.js --help
node server/dist/config/cli.js init --config-dir /absolute/new/config \
  --owner-id LOCAL_STORE_OWNER_ID --provider gemini \
  --profile-input /absolute/private/profile.json \
  --source-env /absolute/authorized/provider.env
```

The owner prepares the profile and authorized source file first. `initializeProviderConfig` reads them using the protected-file validators; it does not discover shell credentials or execute the source file as a script. Gemini initialization creates the text profile in a new destination. Adding the OpenAI voice slot has different existing-directory semantics; do not rerun an initializer blindly over a partial failure.

`--binding-input /absolute/private/binding.json` supplies an explicit operator-asserted account and route binding. `CredentialBindingReceipt` and `CredentialRouteScope` in `server/config/index.ts` own its contract. A key without a usable binding is not permission to use receipt-dependent source tools. The labels are operator assertions, not remote provider identity verification.

Use [user-guide.md](user-guide.md) for the first-call sequence. An owner profile is a separate optional input, documented in [owner-profile.md](owner-profile.md), not an API-key profile.

## Live selection and features

The CLI's `select` command changes the selected voice provider and optional voice, accent and playback rate:

```sh
node server/dist/config/cli.js select --config-dir /absolute/private/config --provider openai
```

`saveLiveSelection` in `server/config/live.ts` validates the provider's own key and selection. The CLI works on files; deliberately restart the host for its new selection. In-app Settings uses the host's settings path and applies changes to subsequent calls, not the one already in progress.

`liveFeatures` in `server/live/config.ts` separates `composedNotes` from `notesExport`. Composed notes default off. `defaultLiveLimits` owns timer defaults; a private profile can override supported limits only within the validator's bounds. Do not copy timer values or voice lists into another source of truth here.

## Route changes and disclosure

A configured credential is not a grant for every source class. Bound receipts pin the account assertion, route and generation; dispatch must match the current accepted scope. `migrate-binding` and `set-route-classes` are explicit operator operations, not automatic compatibility repair. Read the CLI help and [privacy-and-authority.md](privacy-and-authority.md) before changing them.

Route changes must not silently authorize an old conversation under a new provider/model/class policy. A remembered text disclosure is separate from connector approval and Live microphone permission. [Text chat](text-chat.md) and [live-call.md](live-call.md) own their acceptance boundaries.

## Failure recovery and verification

Keep incomplete setup private and inspect the typed error; never delete unknown files, overwrite credentials or relax permissions until initialization appears green. The protected loaders reject unsafe ownership, modes, types and malformed inputs. Same-user filesystem validation is not an operating-system sandbox against a compromised account.

[Checks](checks.md) names configuration and credential-binding producers. They use synthetic private fixtures, not owner keys. Locally validated configuration does not prove a model request works, that a provider honors the desired voice or that connected accounts are available.
