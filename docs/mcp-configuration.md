# Protected MCP configuration and standing consent

This is a **startup library seam**, not production activation or current Host runtime wiring. The CLI never opens a Store. The future B composition must receive the existing migrated Store, create one canonical ToolsOwner/registry/adapter, and consume the protected intent at startup. C does not change Host runtime, create another database/owner, watch files, poll, or expose an admin API.

## Explicit operator assertions

Select the exact owner ID (the existing Store's `assistantId`), absolute host data root, connection/endpoint ID, normalized endpoint URL, account, resource and non-null credential reference. Nothing infers a production account. The account/resource binding is an **operator assertion**, not SDK verification of token identity. HTTPS binds the destination; the source server must enforce token account/resource scope. Plain HTTP is accepted only for literal loopback local fixtures. Do not place a production credential in a fixture.

Configuration is a UID-owned 0700 directory containing `profile.json` and `credential.json`. Both are UID-owned regular, single-link, non-symlink 0600 files, read through bounded descriptor checks. Node lacks `openat`; ancestors and same-UID path replacement are the existing trust boundary. Files are reread synchronously at authority boundaries. Secret rotation may replace the credential file, but must retain its binding metadata; no token-byte/fingerprint/inode comparison defines authorization.

Bearer tokens belong **only in the private credential file**. Never put them in profile JSON, command arguments, environment variables, database policy, reports, or logs. References use `[A-Za-z][A-Za-z0-9_-]{0,63}` and are identifiers, never paths. Commands and errors do not echo references, paths, URLs, token bytes or remote error bodies.

The profile/input envelope has exactly:

- `schemaVersion: 1`, `transport: "streamable-http"`, `dataDir`: the absolute existing host root;
- `expectedPolicySha256`: exact durable predecessor hash, or `null` only when no policy exists;
- `policy`: the canonical `ConnectionPolicy` with owner/connection/generation/enabled, endpoint `{id,url,account,resource,credentialRef}`, the approved read `toolNames` and complete catalog `schemaDigest`, reviewed `sourcePolicy`, `route` and positive `bounds`.

The credential has exactly `schemaVersion`, `ownerId`, `connectionId`, `endpointId`, `url`, `account`, `resource`, `generation`, `credentialRef`, `token`, `enabled`. Its metadata must match the selected profile. Source classes are never taken from remote annotations. Use `sourcePolicy.unknownClass: null` to deny unknown/opaque data by default. If the operator deliberately classifies this source's opaque results, set that class and consent to it explicitly in both source and route policies; an ordinary synthetic fixture is not production consent. Bounds have explicit local ceilings; unknown/duplicate fields, duplicate JSON keys and malformed data are rejected.

## CLI lifecycle

Use the compiled entry point; the focused producer compiles it in temporary output for tests. A normal server build emits it under the server's compiled root. `--help` lists the complete command/flag surface:

```
node <compiled-root>/config/mcp-cli.js --help
node <compiled-root>/config/mcp-cli.js init --config-dir <absolute-new-dir> --owner-id <owner> --profile-input <absolute-private-json> --credential-input <absolute-private-json>
node <compiled-root>/config/mcp-cli.js catalog --config-dir <absolute-dir> --owner-id <owner> --allow-egress --limit <positive-integer> [--cursor <opaque-local-cursor>]
node <compiled-root>/config/mcp-cli.js approve --config-dir <absolute-dir> --data-dir <absolute-host-root> --owner-id <owner> --policy-input <absolute-private-json>
node <compiled-root>/config/mcp-cli.js disable --config-dir <absolute-dir> --data-dir <absolute-host-root> --owner-id <owner>
```

Inputs are prepared privately by the operator, not supplied through stdin/argv/env token flags. Unknown, repeated, missing and malformed flags are rejected. `init` requires disabled policy/credential, a new directory and null predecessor. It reports **provisioned disabled; pending host application**.

`catalog` is an explicit, bounded, authenticated official-SDK tool discovery. It uses an isolated in-memory registry/result store, not database ownership, and cannot call tools. `--allow-egress` is mandatory; limit is 1–64. SDK discovery must finish all bounded tool pages before output. CLI output contains supported read tool names, complete catalog digest/count, coverage basis and a local cursor, not arbitrary remote descriptions or bodies. Unsupported remote tool names are withheld as `<unapproved-tool>` (remote names can themselves echo credentials); the digest and count still cover every discovered tool. Local cursors bind selection/digest/offset; source-corpus search/get cursor pagination is unsupported and not fabricated. Complete tool catalog is **not** complete source-corpus coverage.

`approve` accepts the **complete reviewed envelope** in `--policy-input`, with the operator-supplied predecessor/generation/consent. The endpoint identity and host/owner/connection binding cannot change. It updates protected selection only and reports **provisioned; pending host application**, never applied. It neither guesses the predecessor nor invents a new generation.

`disable` disables the CURRENT local credential locator immediately, preserving the protected policy intent. It reports **disabled locally; durable revocation pending**. It cannot fabricate a durable policy generation. To persist revocation, the operator supplies an explicitly reviewed disabled policy at a larger generation with the exact current durable hash using `approve`; startup consumption then commits that revocation. A locally disabled locator makes the bundle pending and denies local egress/tools even while durable consent still exists.

## Existing-Store factory and restoration

`loadMcpConfiguration({configDir, ownerId, dataDir})` reads metadata and supplies the resolver/final guard without Store access. B uses this metadata to create the registry/adapter once; it passes the loader's `resolveCredential` and `assertCredentialCurrent` to the adapter. Only protected explicit selection authorizes separate registry enable and egress operations. Neither operation grants tools.

`composeMcpConnection({store, owner, registry, configDir})` accepts that **existing Store**, its **same owner** and **same registry**. It verifies their object/owner/host/registered-endpoint binding, invokes `owner.applyConnectionIntent`, and returns `applied`, `unchanged`, `refused` or local-disable `pending`. Applied means durable policy consumption, **not** discovery/projection or runtime activation. Returned `sha256` is the canonical durable policy hash. `restore()` invokes owner-mediated authenticated rediscovery; only `restored` establishes exact read projection. No replacement owner, registry, port, journal or resultGate is created.

Conditional apply is one Store transaction: verified identical canonical policy is idempotent even with a stale predecessor; otherwise the predecessor must match exactly, the generation must increase, and the entire endpoint identity is immutable. Hash corruption and endpoint collisions fail without mutation. Durable revocation commits before local projection changes; stale startup intent cannot overwrite it.

Restoration reads enabled durable consent/hash, awaits complete authenticated discovery **outside** a Store transaction, then rereads authority and checks CURRENT protected binding. It checks again after the synchronous locator callback and installs exact registry projection synchronously with no await gap. Catalog changes cannot authorize widened access. Returning to the original catalog can restore the same standing generation while consent remains current. Suspension retains consent; explicit revoke blocks equal/older restoration. New approvals still require increasing generations. A fresh process may restore only from owner-verified current durable consent. Existing snapshots/results retain canonical policy/hash gates; restoration never resets the journal/resultGate or authorizes another account's retained result.

After awaited credential resolution and current registry checks, the adapter performs the final synchronous CURRENT locator guard immediately before `dispatched = true` and fetch. Local disable/rebind therefore sends no tool HTTP. Valid same-binding secret replacement does not change consent generation. Remote token revocation may cause an authentication rejection; it does not prove local revocation, and must execute no tool at the enforcing server. No ambiguous tool call is retried automatically.

## Verification and activation boundary

The focused managed gates are `scripts/check-mcp-config.sh`, existing `scripts/check-mcp.sh` and `scripts/check-tool-owner.sh`, with the declared verified TypeScript/official SDK assembly root. The new producer isolates its output and removes it after execution; no dependency installation is performed. Tests use fabricated alpha/beta accounts, real local official SDK servers and real Store. Nonempty authenticated reads and account exclusion—not HTTP 200 or empty data—are the evidence.

Production activation remains separate: explicit production config/account/resource/catalog/classes/route approval; B startup/runtime composition using accepted tools migrations; then authorized nonempty read, revoke and restart verification. This seam does not claim deployed activation, full provider swap or six-state roadmap closure.

## Locally approved stdio bindings (optional)

A connection may bind an operator-approved local executable instead of an HTTP URL. The stdio arm is `{ id, transport: 'stdio', command, args, env?, account, resource }` with `credentialRef` absent; the HTTP arm is unchanged and an absent `transport` still means HTTP (no discriminator is injected into existing records or their canonical hashes). Unknown transport values and cross-arm fields (stdio with `url`, HTTP with `command`/`args`, stdio with a non-null credential) are refused.

`command` must be an absolute installed executable (no PATH lookup, `shell: false`); `args` is an ordered immutable string list. **Approved environment.** The SDK merges its platform inherited set into any supplied `env`, so the approved `env` must contain **every** key in that set (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER` on macOS/POSIX — the set the SDK publicly exports as `DEFAULT_INHERITED_ENV_VARS`); the shared in-scope helper `validateApprovedStdioEnv` is the single authority for this. `HOME` and `PATH` must be non-empty; a non-routing default is neutralized with an explicit empty string in the same approval identity. No key is inherited from the parent at spawn and the whole `process.env` is never forwarded. Paths containing spaces are valid. Approval identity covers the whole executable binding (command, ordered args, approved env, account, resource), so a changed binding requires new approval; a token rotation within an unchanged binding is not a new account. A missing executable is a typed unavailable, and no child is spawned before approval.

Child stdout/stderr are never forwarded to the parent's sinks, and neither command, args, env nor any secret marker appears in status payloads, diagnostics or model-visible projections.

**Platform support.** The stdio arm is supported and verified on macOS/POSIX only; on Windows it fails closed (`validateApprovedStdioEnv` rejects any stdio binding) until its adapter is implemented, while HTTP and local features are unaffected. This is a source-level guarantee; no Windows runtime behaviour is claimed or proven.
