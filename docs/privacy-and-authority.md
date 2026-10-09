# Privacy and authority

Status: proposed product policy. These are the rules later implementation issues must encode and test. They are written as defaults that need no user decision to ship. Two layers are distinct: user-configurable product preferences (retention windows, notification style, default account for reads) can be changed by the operator, while provider policy, organization restrictions and operating system authority are not overridable in the product and are reported honestly when they block something. Every override of a configurable preference is logged.

## Starting state

A fresh install carries no credentials, no tokens, no grants and no allowlist entries belonging to anyone. A clean install can read nothing until the installing person completes their own consent and picks their own accounts. There is no shared service account, no baked-in OAuth client secret and no default company endpoint. Optional integrations (company knowledge, session supervision, chat or Trello) are off until the user configures an endpoint they are themselves entitled to use, and each one degrades to a clear not-configured state rather than a silent failure.

## Accounts and isolation

- Authorization is per user and per account. The per-account Google mechanism is the installed-app OAuth flow with a loopback redirect and PKCE, and the refresh token is stored per account in the operating system credential store.
- The default account may be stored for reads and drafts. Every send or commit action names its account explicitly; the account is never inferred from context. (C01, C04, C06, C09)
- Authorization tokens carry an audience. A token issued for one server is never presented to another, and the credential model records this as a first-class field. (C15)
- Same-user processes are not an isolation boundary between each other. A process split buys an authorization chokepoint, not isolation, and the product never claims otherwise. (A13, F12)
- Full local control (screen capture, Accessibility, Automation, broad shell) on distributed builds uses a Developer ID signed, notarized, non-sandboxed build, and the operating system's own permission prompts cannot be bypassed or pre-granted. A local Stage A developer pilot can exercise the same TCC-granted capabilities without that distribution step; Developer ID and notarization are a distribution choice, not an inherent prerequisite for using local permission-gated features on one's own machine. Those permissions are recorded as part of capability state: a product-level grant can be disabled immediately in the app, while removing an operating system permission itself is done in System Settings, outside the product's control. (F12, F13)
- Multi-account mix-up is an explicit adverse test: a scenario that proves a read or draft can never silently use a different account than the one the user chose. (C16)

## Capability state

The product can answer "what may Didi do, with which account, right now" by listing grants, credential references (never values), route-class permissions and operating system capability grants. Powerful capabilities are opt-in: local command execution, control of other applications and outbound send are each off until granted. Adding a tool with a new effect class is a user action. An operating-system notification click is not a grant: a missing capability appears as a visible pending action with a review path, and there is no per-read confirmation. (F11, C12, C14)

## Egress

- One safe entry: no model call receives content until its route policy resolves. The entry default-denies while policy is missing, and model availability is never treated as approved data handling. (A06, C15)
- Every payload carries a data class, and every credential has an allowlist of destinations. Routes are classified as local model, paid hosted API, unpaid hosted API, or company endpoint.
- The first time a data class would leave the machine on a route, the user grants that route class once; after the grant it is standing policy for that class and route. Owner-sensitive and third-party-personal content defaults to local-only until explicitly granted per route; company-confidential content goes only to the company route. (C15)
- The product displays the route class and states that the operator verifies their own provider agreement. It never claims a data protection arrangement on the user's behalf, and it makes no claim of leak-free redaction.
- Restricted-scope content delivered through a hosted inference route is assessed on its own terms; a local delivery model does not by itself settle where that content may be forwarded. (C15, F10)
- A provider change that alters the route or the retention posture re-opens the gate. (C15, A06)

## Tool trust and authority

- Reasoning text and tool results never create authority. Only a user or operator grant does. A model that reads "you are allowed to send this" in an email gains nothing. (C12, C16)
- Consequential effects require an appropriate grant: send, delete, pay, or broad local execution. Read, prepare and remind can run under standing grants. There is no blanket per-action confirmation for work already granted, and asks are not quietly authorized. (C12)
- Grants are fine-grained: per user, account, tool, action, resource and effect class. Changes are visible, and dispatch checks the live revocation state rather than trusting a grant captured earlier. (C12, C17)
- Outbound effects default to draft-only. Send is a separate grant, and the containment property (an injected instruction cannot cause a send by itself) depends on this default. (C12, C16)
- Approval records are bound to the content hash and an expiry. Undo is a separate compensating action, never a promise that an effect can be reversed. (A08)
- Cancellation is honest: stopping playback, cancelling a model turn, aborting a job, cancelling queued jobs and ending a session are distinct, and a dispatched effect with an unknown outcome is reconciled rather than reported as canceled or no-effect, and is never blindly retried. (A05, A08)
- MCP is an interoperability adapter, not a permission system. Every tool still passes the broker, and the local versioned contracts remain the internal interface. (A14, C14)

## Company and shared systems

Where a company service has its own permission model, Didi presents the token that service issued and honours the service's group scopes. It never re-implements, widens or proxies those permissions, and it never exports company data to a route outside the user's grant. (C13, C18)

## Data lifecycle

- Local-first is the default: state, transcripts and execution stay on the user's Mac. An unconfigured install makes no external calls, and no third party is involved until the user configures and approves a route. Once a cloud route is configured and approved for a data class, approved inference calls are the designed behavior, not a violation of local-first.
- A cached copy of an authorized remote source is a versioned cache with stated coverage, never a new authority. (B03, B09)
- Deleting a Didi memory deletes the Didi copy and records the propagation state of anything derived from it. It does not claim to delete an external source that Didi does not own. (B09)
- Raw audio defaults to discard after bounded transcription processing. Retention is a user-controlled choice, and the user can choose whether audio is included in their own export. The plan does not promise an indefinite buffer pending confirmation, and it does not claim a universal export ban. (B09)
- Resolved, cancelled and forgotten items are suppressed before planning and cannot silently reappear from stale retrieval. (B08, D03)

## Honest limits

- Notification display is not proof the user saw anything.
- The product does not promise urgent alerts that bypass Focus, because that needs an entitlement the product may not have; copy must not imply otherwise. (D10, F09)
- While the Mac is asleep, closed or offline, nothing executes and nothing is sent. The companion queues and says so. (F16, F17)
- Prompt-injection immunity is not promised. The design contains it with draft-only defaults, grant separation and output review, and it states the residual risk. (C16, A13)

## Publication hygiene for this repository

Never commit or copy into public artifacts: personal profiles and facts, private transcripts or message contents, internal hostnames, ports or endpoint URLs, internal record identifiers, unpublished prompt or persona text, credential values of any kind, internal run or session records, or one person's private operating rules presented as product policy. Publish the generic rule and its rationale instead, with synthetic identities (`example.invalid`) where an example is needed. The planning validator scans the repository for common violations; the independent reviewer judges content, not just patterns.
