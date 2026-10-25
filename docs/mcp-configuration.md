# Protected MCP configuration and standing consent

This describes the protected MCP configuration and its CLI, which the host reads at startup (`server/host/mcp.ts`, `server/config/mcp.ts`). The CLI never opens a Store. The host receives the existing migrated Store, creates one canonical ToolsOwner/registry/adapter, and consumes the protected intent at startup. C does not change Host runtime, create another database/owner, watch files, poll, or expose an admin API.

## The three Mongoose endpoints

Release 1023b serves three MCP endpoints, and Didi connects to all three and never to admin. Each is its
own OAuth resource with its own token record, so a token for one endpoint is refused on another. The OAuth
resource of an endpoint is its URL: the configured origin plus the endpoint path, for example
`https://mongoose.dev.peat-cloud.com/mcp/data`. The `resource` column below is the catalogue's local label for
the endpoint (it is also the audience Mongoose mints into the token); it is never sent as an OAuth resource.

| id | url | catalogue resource label | credentialRef | read envelope |
| --- | --- | --- | --- | --- |
| `mongoose-knowledge` | `https://mongoose.dev.peat-cloud.com/mcp/knowledge` | `mongoose:knowledge` | `mongoose-knowledge` | `search`, `read`, `list_companies`, `list_company_products`, `get_market_profile`, `get_commercial_paths`, `list_tickets`, `get_started` |
| `mongoose-data` | `https://mongoose.dev.peat-cloud.com/mcp/data` | `mongoose:data` | `mongoose-data` | `search_content`, `read_content`, `list_content`, `list_explores`, `get_data_context`, `get_metadata`, `list_verified_content`, `run_metric_query` |
| `mongoose-crm` | `https://mongoose.dev.peat-cloud.com/mcp/crm` | `mongoose:crm` | `mongoose-crm` | `get_company`, `list_inbound_leads`, `list_inbound_lead_events`, `summarize_email_engagements` |

The catalog must carry all three, once each, with three distinct resources and three distinct credential
references. `/mcp`, `/mcp/`, `/mcp-lightdash`, `/mcp-crm`, `/mcp-mongoose`, a `?toolset=` query, a retired
tool name and `/mcp/admin` are refused at load with the closed code `invalid_source`. A grant may only name
tools of its own endpoint's envelope, and no envelope carries a write.

Data reads need one more thing the owner supplies: a Lightdash personal access token, connected at
`https://mongoose.dev.peat-cloud.com/settings/connections`. Until it is connected every data tool answers
`data_not_connected`, which Didi reports as one line ("your Lightdash token is not connected in Mongoose
settings") and never as a failure. CRM admission is by team: a refused sign-in answers `endpoint_not_allowed`
with the required teams, reported as one line, and the knowledge and data endpoints keep working.

## The Trello board sign-in

The owner's Trello board is reached through the official Trello remote MCP server at `https://mcp.trello.com/v1` (streamable HTTP). It is not a catalogue entry: no `mcp.json` line is needed, and the Settings connection poll always carries one `trello` row with a **Sign in to Trello** button while no session exists. The sign-in is the same host OAuth client as the Mongoose endpoints (`server/host/oauth-client.ts`), with three trusted anchors fixed in `server/host/trello.ts` from the server's public documents of 2026-10-25 (`server/test/fixtures/trello-discovery.json`): the resource `https://mcp.trello.com/v1`; the issuer `https://auth.atlassian.com/<tenant>` (the authorization server is on another origin and its issuer has a path); and the issuer's origin, on which the authorization, token and registration endpoints must sit. Discovery reads the resource's own RFC 9728 document at `https://mcp.trello.com/.well-known/oauth-protected-resource/v1` (its `resource` must equal the resource and its first `authorization_servers` entry the issuer), then the issuer's RFC 8414 document at `https://auth.atlassian.com/.well-known/oauth-authorization-server/<tenant>` (its `issuer` must equal the issuer and it must offer S256). Then one dynamic client registration of a public client (`token_endpoint_auth_method: none`), PKCE S256, `resource=<URL>` on the authorize request, the code exchange and every refresh, a loopback callback on `http://127.0.0.1:8769/callback` (Atlassian allows `127.0.0.1` redirects by default), and one atomic 0600 write of the schemaVersion 3 record `trello.json` beside the Mongoose records, with `endpoint: "board"`. The scope is `offline_access read:me read:account read:member:trello read:member.inbox:trello write:member.inbox:trello read:board:trello write:board:trello read:organization:trello`: never Planner, never a workspace write; the Inbox he jots into from his phone is read through `read:member.inbox:trello`, and one of its notes can be moved onto a list of the board (W7-R1), which is why the Inbox write scope is asked for as well.

The board name is the owner's private configuration and is never in this repository (W7-R2). Put `{"board": "<the board name he sees in Trello>"}` in `trello-board.json` in the same protected configuration directory as the sign-in record, mode 0600; with no such file the `trello` row reads `not_configured` and every Trello call refuses before it reaches the server. The consent screen picks one Trello workspace per connection. The hops write the same `signin_*` lines with endpoint `trello` ([debugging.md](debugging.md)). The refresh has no consent cap of its own; a refused refresh asks for a new sign-in. Whether Atlassian's registration accepts the exact loopback redirect and the `resource` parameter can only be proven by the owner's first sign-in.

## Explicit operator assertions

Select the exact owner ID (the existing Store's `assistantId`), absolute host data root, connection/endpoint ID, normalized endpoint URL, account, resource and non-null credential reference. Nothing infers a production account. The account/resource binding is an **operator assertion**, not SDK verification of token identity. HTTPS binds the destination; the source server must enforce token account/resource scope. Plain HTTP is accepted only for literal loopback local fixtures. Do not place a production credential in a fixture.

Configuration is a UID-owned 0700 directory containing `profile.json` and `credential.json`. Both are UID-owned regular, single-link, non-symlink 0600 files, read through bounded descriptor checks. Node lacks `openat`; ancestors and same-UID path replacement are the existing trust boundary. Files are reread synchronously at authority boundaries. Secret rotation may replace the credential file, but must retain its binding metadata; no token-byte/fingerprint/inode comparison defines authorization.

A credential file has one of two shapes. `schemaVersion: 1` is the pasted bearer this CLI provisions, `{ schemaVersion, token }`, read at `<credentialRef>.json` (`credential.json` is the CLI's own input name, never the runtime path). `schemaVersion: 3` is the host-owned Mongoose OAuth session, exactly `{ schemaVersion, endpoint, resource, issuer, tokenEndpoint, clientId, redirectPort, account, accessToken, refreshToken, expiresAt, consentStartedAt }`, written only by the owner sign-in: the **Sign in** button on that endpoint's row in Settings, or `node <compiled-root>/host/index.js --mongoose-login knowledge` (or `data`, or `crm`) from a terminal. `resource` is the endpoint's resource URL, `issuer` the configured origin and `tokenEndpoint` sits on that origin. One record exists per Mongoose endpoint, because each endpoint is its own OAuth resource and a token for one endpoint is refused on another. Earlier record shapes are not read: an endpoint whose file is not schemaVersion 3 reports not signed in until the owner signs in again, and a release 9 `mongoose-mcp.json` is left on disk untouched (the owner may delete it). Each button, and a named `--mongoose-login`, signs in that one endpoint only; `--mongoose-login` without a name signs in every Mongoose endpoint that has no session, one after another, stopping at the first failure.

A sign-in binds one resource URL, computed once from the catalogue entry's URL (https, or http on a literal loopback address for local fixtures; no userinfo, query or fragment; the endpoint's own path) and never taken from a discovery document. It runs in the owner's default browser: discovery of that endpoint's own `/.well-known/oauth-protected-resource/mcp/<name>` document on the configured origin, with no redirect followed (its `resource` must equal the expected URL exactly, with no case or trailing slash normalising, and its first `authorization_servers` entry must be the configured origin), then `/.well-known/oauth-authorization-server` (its `issuer` must be the configured origin, it must offer S256, and its registration, authorization and token endpoints must sit on that origin), one dynamic client registration of `lux-didi`, PKCE S256, `resource=<URL>` on the authorize request, a loopback callback on `http://127.0.0.1:<port>/callback` that accepts its single-use state once, one code exchange carrying `resource=<URL>` and one atomic 0600 rename. Add `--no-browser` to print the authorization URL without opening or focusing a browser. One five-minute deadline starts before discovery and covers registration, response bodies, callback and code exchange. Expiry aborts outstanding requests, closes the loopback callback and saves no session. It never runs on a host boot.

The Settings click answers at once with an attempt id; the attempt's step (`running`, `waiting` for the browser, `finishing`, `signed_in`) or its failure class (`discovery_unreachable` when discovery gets no answer, for example with the VPN off, `discovery_refused`, `registration_refused`, `port_in_use`, `browser_unavailable`, `callback_failed`, `callback_timeout`, `token_refused`, `store_failed`, `did_not_finish`) reaches the endpoint's row as `signIn` on the connection poll (`GET /api/v1/live/connections`), and each hop writes one `signin_*` line to `host.log` ([debugging.md](debugging.md)).

The host refreshes lazily, on the first request at or after `expiresAt - 120 s`, under an exclusive lock with a re-read after taking it, so a rotating refresh token is used exactly once, and the refresh carries `resource=<URL>`. A record whose endpoint, resource or issuer does not match the current catalogue entry is a sign-in (`credential-missing`), and no refresh is attempted. A refresh failure is one owner line plus the mongoose next step, the last five days of the 90 day consent family emit one `consent-expiring` line, and discovery that is not published or does not match fails at once with `metadata-unavailable` rather than hanging. `scripts/refresh-mongoose-discovery.mjs` re-captures the four public discovery documents into a candidate beside `server/test/fixtures/mongoose-discovery.json` for review; it never registers, authorizes or reads a credential.

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

`catalog` is an explicit, bounded, authenticated official-SDK tool discovery. It uses an isolated in-memory registry/result store, not database ownership, and cannot call tools. `--allow-egress` is mandatory; limit is 1-64. SDK discovery must finish all bounded tool pages before output. CLI output contains supported read tool names, complete catalog digest/count, coverage basis and a local cursor, not arbitrary remote descriptions or bodies. Unsupported remote tool names are withheld as `<unapproved-tool>` (remote names can themselves echo credentials); the digest and count still cover every discovered tool. Local cursors bind selection/digest/offset; source-corpus search/get cursor pagination is unsupported and not fabricated. Complete tool catalog is **not** complete source-corpus coverage.

`approve` accepts the **complete reviewed envelope** in `--policy-input`, with the operator-supplied predecessor/generation/consent. The endpoint identity and host/owner/connection binding cannot change. It updates protected selection only and reports **provisioned; pending host application**, never applied. It neither guesses the predecessor nor invents a new generation.

`disable` disables the CURRENT local credential locator immediately, preserving the protected policy intent. It reports **disabled locally; durable revocation pending**. It cannot fabricate a durable policy generation. To persist revocation, the operator supplies an explicitly reviewed disabled policy at a larger generation with the exact current durable hash using `approve`; startup consumption then commits that revocation. A locally disabled locator makes the bundle pending and denies local egress/tools even while durable consent still exists.

## Existing-Store factory and restoration

`loadMcpConfiguration({configDir, ownerId, dataDir})` reads metadata and supplies the resolver/final guard without Store access. B uses this metadata to create the registry/adapter once; it passes the loader's `resolveCredential` and `assertCredentialCurrent` to the adapter. Only protected explicit selection authorizes separate registry enable and egress operations. Neither operation grants tools.

`composeMcpConnection({store, owner, registry, configDir})` accepts that **existing Store**, its **same owner** and **same registry**. It verifies their object/owner/host/registered-endpoint binding, invokes `owner.applyConnectionIntent`, and returns `applied`, `unchanged`, `refused` or local-disable `pending`. Applied means durable policy consumption, **not** discovery/projection or runtime activation. Returned `sha256` is the canonical durable policy hash. `restore()` invokes owner-mediated authenticated rediscovery; only `restored` establishes exact read projection. No replacement owner, registry, port, journal or resultGate is created.

Conditional apply is one Store transaction: verified identical canonical policy is idempotent even with a stale predecessor; otherwise the predecessor must match exactly, the generation must increase, and the entire endpoint identity is immutable. Hash corruption and endpoint collisions fail without mutation. Durable revocation commits before local projection changes; stale startup intent cannot overwrite it.

Restoration reads enabled durable consent/hash, awaits complete authenticated discovery **outside** a Store transaction, then rereads authority and checks CURRENT protected binding. It checks again after the synchronous locator callback and installs exact registry projection synchronously with no await gap. Catalog changes cannot authorize widened access. Returning to the original catalog can restore the same standing generation while consent remains current. Suspension retains consent; explicit revoke blocks equal/older restoration. New approvals still require increasing generations. A fresh process may restore only from owner-verified current durable consent. Existing snapshots/results retain canonical policy/hash gates; restoration never resets the journal/resultGate or authorizes another account's retained result.

After awaited credential resolution and current registry checks, the adapter performs the final synchronous CURRENT locator guard immediately before `dispatched = true` and fetch. Local disable/rebind therefore sends no tool HTTP. Valid same-binding secret replacement does not change consent generation. Remote token revocation may cause an authentication rejection; it does not prove local revocation, and must execute no tool at the enforcing server. No ambiguous tool call is retried automatically.

## Verification and activation boundary

The focused managed gates are `scripts/check-mcp-config.sh`, existing `scripts/check-mcp.sh` and `scripts/check-tool-owner.sh`, with the declared verified TypeScript/official SDK assembly root. The new producer isolates its output and removes it after execution; no dependency installation is performed. Tests use fabricated alpha/beta accounts, real local official SDK servers and real Store. Nonempty authenticated reads and account exclusion, not HTTP 200 or empty data, are the evidence.

Production activation remains separate: explicit production config/account/resource/catalog/classes/route approval; B startup/runtime composition using accepted tools migrations; then authorized nonempty read, revoke and restart verification. This seam does not claim deployed activation, full provider swap or six-state roadmap closure.

## Locally approved stdio bindings (optional)

A connection may bind an operator-approved local executable instead of an HTTP URL. The stdio arm is `{ id, transport: 'stdio', command, args, env?, account, resource }` with `credentialRef` absent; the HTTP arm is unchanged and an absent `transport` still means HTTP (no discriminator is injected into existing records or their canonical hashes). Unknown transport values and cross-arm fields (stdio with `url`, HTTP with `command`/`args`, stdio with a non-null credential) are refused.

`command` must be an absolute installed executable (no PATH lookup, `shell: false`); `args` is an ordered immutable string list. **Approved environment.** The SDK merges its platform inherited set into any supplied `env`, so the approved `env` must contain **every** key in that set (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER` on macOS/POSIX, the set the SDK publicly exports as `DEFAULT_INHERITED_ENV_VARS`); the shared in-scope helper `validateApprovedStdioEnv` is the single authority for this. `HOME` and `PATH` must be non-empty; a non-routing default is neutralized with an explicit empty string in the same approval identity. No key is inherited from the parent at spawn and the whole `process.env` is never forwarded. Paths containing spaces are valid. Approval identity covers the whole executable binding (command, ordered args, approved env, account, resource), so a changed binding requires new approval; a token rotation within an unchanged binding is not a new account. A missing executable is a typed unavailable, and no child is spawned before approval.

Child stdout/stderr are never forwarded to the parent's sinks, and neither command, args, env nor any secret marker appears in status payloads, diagnostics or model-visible projections.

**Platform support.** The stdio arm is supported and verified on macOS/POSIX only. On win32 a stdio binding is **refused** (`validateApprovedStdioEnv` returns false there) because the platform's inherited-environment set differs and its adapter is not implemented, while HTTP and local features are unaffected. This is a source-level guarantee; no Windows runtime behaviour is claimed or proven.

## Installed endpoint catalog and owner-trusted-reads

The owner supplies `mcp.json` in the selected protected configuration directory
with directory mode `0700` and file mode `0600`. The installer writes no catalog.
An endpoint names a `credentialRef` rather than embedding a secret. Shape:

`{ "schemaVersion": 1, "grantMode": "explicit" | "owner-trusted-reads", "endpoints": [ { "id", "transport": "streamable-http", "url", "connector", "account", "resource", "credentialRef", "enabled", "allowEgress" } ] }`

An endpoint may instead bind a local executable (stdio): `{ "id", "transport": "stdio", "command", "args", "env", "connector", "account", "resource", "credentialRef": null, "enabled", "allowEgress" }`. `command` is an absolute path (no PATH lookup), `args` is an ordered string list, and `env` must contain every SDK `DEFAULT_INHERITED_ENV_VARS` key plus non-empty `HOME` and `PATH` (`validateApprovedStdioEnv`). `credentialRef` is strictly null.

`grantMode` defaults to `explicit` when absent. `validateEndpointUrl` permits plain HTTP only for literal loopback. There is no installed endpoint catalog. The owner supplies the actual server URLs or installed executable bindings, account/resource identities, classifications, credential references and approval mode for their own connectors.

Under `owner-trusted-reads`, after each successful discovery the host approves exactly the tools in the Didi connector's local read envelope for that endpoint (lux-knowledge: `search_knowledge`, `get_insight`; google: `gmail_get_profile`, `gmail_search_messages`, `gmail_read_message`, `calendar_list_calendars`, `calendar_list_events`; mongoose: the fixed read envelope of that one endpoint (knowledge: `search`, `read`, `list_companies`, `list_company_products`, `get_market_profile`, `get_commercial_paths`, `list_tickets`, `get_started`; data: `search_content`, `read_content`, `list_content`, `list_explores`, `get_data_context`, `get_metadata`, `list_verified_content`, `run_metric_query`; crm: `get_company`, `list_inbound_leads`, `list_inbound_lead_events`, `summarize_email_engagements`), each name admitted only when the server's own MCP `readOnlyHint` is true and the name is not on the connector's deny list, so no spelling of a name is ever a read on its own, and every write (`run_sql`, `create_content`, `update_content`, `create_scheduled_delivery`, `set_project`, `create_ticket`, `update_ticket`, `claim_ticket` and the rest of the deny list) is never admitted whatever the annotation says; mattermost: `mattermost_whoami`, `mattermost_get_channel_history`, `mattermost_get_thread`, `mattermost_search`, `mattermost_list_channels`) at the discovered schema digest, one generation higher; anything outside the envelope, and every write or unknown effect, is never auto-approved, whatever the remote `readOnlyHint` says. A changed digest re-approves only the envelope. The existing grant evaluator enforces every call unchanged. A Mattermost child with no session reports `auth needed: run mattermost_login once` as a configured status, never an empty success.
 A connector's own composite view is granted under its own name beside that envelope, and only when every child read it stands on is granted: `mattermost_attention` needs all five Mattermost reads, its declaration carries the host-computed digest that a catalog change is measured against, and a caller routed to an ungranted composite hears `tool-not-granted`, never `unknown_tool`.

A Calendar connector requires its own documented account sign-in and scopes, supplied by the owner. Missing account authorization remains a typed unavailable state, never an empty success. Lux Didi ships no universal Calendar sign-in command.

Status: `GET /api/v1/tools/status` (operator bearer only) returns `{ endpoints: [{ id, state, tools, lastHandshakeAt, error? }] }` with states `missing` (no file), `configured` (present, not connected), `connected` (handshake done) and `error`.

A connection becomes a Live acceptance id only after successful credential validation and discovery, durable canonical ConnectionPolicy reconciliation through the tools owner, and projection of that policy into the registry. The endpoint and discovered schema digest are bound to the durable generation; owner-trusted reads grant only the connector read envelope. Disabled endpoints, denied egress, missing credentials, failed discovery or policy reconciliation remain visible in endpoint status but are not acceptance ids. Refresh reconciles the policy before making the connection usable again.

### Live connector composition

Supported connector kinds are `lux-knowledge`, `google`, `mattermost`, and `mongoose`. Endpoint IDs are independent of the connector kind: separate `gmail` and `calendar` endpoints both use `google`. Each supported kind has a local read envelope and a Live reader descriptor. Model declarations accept only bounded read arguments; the company readers also validate the actual dispatched arguments against the original discovered MCP schema. Remote write tools never become Live declarations.

An unknown connector kind fails host startup before transport discovery with `ConnectorCompositionError`, naming the endpoint ID and connector kind, even for a disabled endpoint. A known connector with no approved discovered reads remains healthy and status-only; a missing credential remains a visible connector error and is not accepted into a Live run. A typed connector composition defect during CREATE returns HTTP 503 with the bounded error code `CONNECTOR_COMPOSITION_ERROR`, not a generic `INTERNAL_ERROR`.

The paired browser may read `GET /api/v1/live/connections`, protected by the same
browser-principal and same-origin checks as `/api/v1/live/current`, with
`Cache-Control: no-store` and no CORS grant. Its envelope data is an array of
allowlisted `{id, state, tools, lastHandshakeAt, reasonCode}` rows; `reasonCode`
is null for healthy connections or one of `credential_missing`, `unreachable`,
`discovery_failed`, `handshake_failed`, `unknown`. Diagnostics and configuration
payloads are not returned. `/api/v1/tools/status` remains operator bearer-only.

## Google helper failure vocabulary

The Google helper answers a failed call with `isError: true`, one text content item shaped `<code>: <message>`, and no `structuredContent`. Didi reads only the leading code: the message is never parsed, spoken or logged. `server/tools/google.ts` holds one closed table keyed by that code, and every row names the class, whether the refusal is pinned, the one clause Naya says, and what the host does. Provenance: `tools/google-mcp/error-contract.json` of lux-cli commit `6ee466f0bce423ce76102970efa9909bfd697530` on `train/google-ipc-1024`, pinned as a candidate because it is source-reviewed but not yet installed; the verbatim copy is `server/test/fixtures/google-error-contract-6ee466f0.json`, and a test fails if the fixture and the table disagree about a code or its pinning.

| code | class | pinned | Naya says | host action |
| --- | --- | --- | --- | --- |
| `credential-missing` | credential | yes | run `lux-google-mcp authorize --family <family>` to sign in again | none until the credential file changes |
| `credential-revoked` | credential | yes | the same sign-in line | none until the credential file changes |
| `credential-unreadable` | credential | yes | the same sign-in line | none until the credential file changes |
| `credential-scope-mismatch` | credential | yes | run the authorize command to grant the read scopes again | none until the credential file changes |
| `credential-overwrite-refused` | credential | yes | the authorize command replaces a sign-in file that belongs to another account | authorize surface only |
| `account-mismatch` | identity | yes | run the authorize command for the account you configured | none until the credential file changes |
| `identity-unverified` | identity | yes | run the authorize command and sign in as the account you configured | none until the credential file changes |
| `credential-refresh-failed` | transient | no | the refresh failed just now, ask again and she retries | one retry on the next ask |
| `provider-failure` | provider | no | the Google service failed just now, ask again and she retries | one retry on the next ask |
| `binding-unknown` | caller | no | the helper was started without the family she asked for | logged as a Didi defect with the tool name, no retry |
| `family-unknown` | caller | no | the helper does not serve that family | logged as a Didi defect, no retry |
| `tool-argument` | caller | no | she built the wrong arguments for the helper | logged as a Didi defect, no retry |
| `tool-unknown` | caller | no | the helper does not have that tool | logged as a Didi defect, no retry |
| `google-helper-error` | provider | no | the helper could not write its sign-in file | authorize surface only |
| any other code | unknown | no | the helper answered with an error she does not know, with a later retry offered | `unknown_helper_code`, logged content-free by the first 32 characters hashed |

A pinned credential or identity code marks the endpoint's connector status auth-needed with the helper's own authorize command, and the call is not retried in that process. Two legacy spellings, `credential-missing-env` and `credential_missing`, map to the `credential-missing` row until the release carrying this contract is installed; one test pins them, with the retirement comment.

## Required source classification per catalog entry

Every `mcp.json` endpoint, HTTP or stdio, must explicitly supply `unknownClass` as `ordinary`, `private` or `sensitive`, for example `"unknownClass": "private"`. This value is owner-controlled local configuration, not remote MCP metadata. It is the connection's approved fallback source class. No value is inferred from connector descriptions, transport, credentials, route identity or an ordinal privacy hierarchy.

Missing and invalid values produce the typed endpoint status `unknown-class-missing` or `unknown-class-invalid`. Only that endpoint is non-executable; the remaining configured connections still start. A healthy handshake is status-only unless the connection has current owner approval and a usable grant. The installer supplies no endpoint catalog or classifications. The owner must classify each configured source as `ordinary`, `private` or `sensitive` according to its actual data. Synthetic test catalogs use explicit `ordinary` values.

Reconciliation retains persisted source-policy revisions, allowed classes, bounds and disabled approval across restarts. Unchanged content causes no CAS and no generation bump. A tighter fallback class changes policy revision/generation immediately; lowering classification, adding tool names or changing endpoint binding returns `owner-approval-required` until the existing explicit connection intent approval is applied. Ambiguous legacy rows return `ambiguous-legacy-policy`. Editing a catalog never re-enables a revoked stored approval.

Installer template upgrades treat the stored PATH as a substitution, preserve its current value, and add unknownClass per entry only when every other byte matches the historical template.
